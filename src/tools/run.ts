import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"
import { resolveToolOptions } from "./_resolveOptions.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  mode: z
    .enum(["cell", "range", "all", "from"])
    .describe(
      "What to execute: 'cell' (single cell by cellIndex), 'range' (start..end), 'all' (every code cell), 'from' (cellIndex to end)"
    ),
  cellIndex: z.number().int().nonnegative().optional().describe("For mode='cell' or 'from'"),
  start: z.number().int().nonnegative().optional().describe("For mode='range'"),
  end: z.number().int().nonnegative().optional().describe("For mode='range'"),
  kernel: z.string().optional().describe("Kernel name to use (default: notebook's kernelspec)"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Timeout in milliseconds (default 120000, from plugin options)"),
  save: z.boolean().optional().default(true).describe("Persist outputs to the notebook (default: true)"),
  workingDirectory: z.string().optional().describe("Working directory for the Python runner"),
  maxOutputChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of output characters per cell (default 12000, falls back to plugin options.defaultMaxOutputChars)")
}

export const ipynbRunTool = tool({
  description:
    "Execute a cell, range, or full notebook via the Python helper (nbclient in v0.3). The plugin never installs Python dependencies; it only detects them and returns a clear error if anything is missing. Use ipynb_doctor first if you are unsure about the environment.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    const pluginOpts = resolveToolOptions()
    const maxOutputChars = input.maxOutputChars ?? Math.max(12_000, pluginOpts.defaultMaxOutputChars)
    const timeoutMs = input.timeoutMs ?? pluginOpts.defaultTimeoutMs
    try {
      const result = await Effect.runPromise(
        services.execution.execute(input.filePath, {
          mode: input.mode,
          cellIndex: input.cellIndex,
          start: input.start,
          end: input.end,
          kernel: input.kernel,
          timeoutMs,
          save: input.save,
          workingDirectory: input.workingDirectory,
          maxOutputChars
        })
      )
      const lines: string[] = []
      const usedWarmKernel =
        pluginOpts.warmKernel &&
        services.kernel.isRunning(result.absPath) &&
        (input.mode === "all" || input.mode === "cell")
      lines.push(`Executed ${result.executedCells.length} cell(s) in \`${result.displayPath}\` (${result.durationMs}ms).`)
      lines.push(`Saved: ${result.saved}`)
      if (usedWarmKernel) {
        const k = services.kernel.list().find((it) => it.filePath === result.absPath)
        if (k) {
          lines.push(`Kernel: warm pid=${k.pid} requestsHandled=${k.requestsHandled}`)
        }
      }
      lines.push("")
      for (const out of result.response.outputs) {
        lines.push(`- cell [${out.cellIndex}] ${out.status}`)
        if (out.stdout) lines.push(`  stdout: ${out.stdout.slice(0, 200)}`)
        if (out.stderr) lines.push(`  stderr: ${out.stderr.slice(0, 200)}`)
        if (out.resultPreview) lines.push(`  result: ${out.resultPreview.slice(0, 200)}`)
        if (out.displayData && out.displayData.length > 0) {
          const display = out.displayData
            .slice(0, 5)
            .map((d) => `${d.mime} (${d.sizeBytes} bytes)`)
            .join(", ")
          const suffix = out.displayData.length > 5 ? `, +${out.displayData.length - 5} more` : ""
          lines.push(`  display_data: ${display}${suffix}`)
        }
        if (out.errors && out.errors.length > 0) {
          for (const err of out.errors) {
            lines.push(`  error: ${err.ename}: ${err.evalue}`)
          }
        }
      }
      return {
        title: `ipynb_run ${input.mode} on ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          executedCells: result.executedCells,
          durationMs: result.durationMs,
          saved: result.saved
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `ipynb_run ${input.mode} on ${input.filePath} (error)`,
        output: `Error: ${message}\n\nTip: run ipynb_doctor to diagnose the environment.`,
        metadata: { error: true, message }
      }
    }
  }
})
