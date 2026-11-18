import { z } from "zod"
import { rethrowPermissionDenied, runToolEffect, tool } from "../tool.js"
import type { ToolContext } from "../tool.js"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"
import { resolveToolOptions } from "./_resolveOptions.js"
import { stripAnsi } from "../utils/ansi.js"
import { MAX_RUN_RESPONSE_CHARS } from "../utils/limits.js"
import { truncate } from "../utils/truncate.js"
import { truncateMarkdown } from "../utils/markdown-safe.js"
import { sanitizeInline } from "../utils/markdown-safe.js"

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
  workingDirectory: z.string().optional().describe("Working directory for the one-shot Python runner (not supported with warmKernel)"),
  maxOutputChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of output characters per cell (default from plugin options.defaultMaxOutputChars, 6000)")
}

export const ipynbRunTool = tool({
  description:
    "Execute a cell, range, or full notebook via the Python helper (nbclient; cellIndex is 0-based). The plugin never installs Python dependencies; it only detects them and returns a clear error if anything is missing. Use ipynb_doctor first if you are unsure about the environment.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context, { warningSink: context.warningSink })
    const pluginOpts = resolveToolOptions(context)
    const maxOutputChars = input.maxOutputChars ?? pluginOpts.defaultMaxOutputChars
    const timeoutMs = input.timeoutMs ?? pluginOpts.defaultTimeoutMs
    try {
      if (services.pythonPathError !== undefined) {
        const message = `Invalid pythonPath: ${services.pythonPathError}`
        return {
          title: `ipynb_run ${input.mode} on ${input.filePath} (error)`,
          output: `Error: ${message}`,
          metadata: { error: true, message }
        }
      }
      const result = await runToolEffect(
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
        }, { signal: context.abort })
      )
      const lines: string[] = []
      const usedWarmKernel =
        pluginOpts.warmKernel &&
        services.kernel.isRunning(result.kernelPath) &&
        (input.mode === "all" || input.mode === "cell")
      lines.push(
        `Executed ${result.executedCells.length} cell(s) in \`${sanitizeInline(result.displayPath)}\` (${result.durationMs}ms).`
      )
      lines.push(`Saved: ${result.saved}`)
      if (usedWarmKernel) {
        const k = services.kernel.list().find((it) => it.filePath === result.kernelPath)
        if (k) {
          lines.push(`Kernel: warm pid=${k.pid} requestsHandled=${k.requestsHandled}`)
        }
      }
      lines.push("")
      for (const out of result.response.outputs) {
        lines.push(`- cell [${out.cellIndex}] ${out.status}`)
        if (out.stdout) lines.push(`  stdout: ${sanitizeInline(out.stdout)}`)
        if (out.stderr) lines.push(`  stderr: ${sanitizeInline(out.stderr)}`)
        if (out.resultPreview) lines.push(`  result: ${sanitizeInline(out.resultPreview)}`)
        if (out.displayData && out.displayData.length > 0) {
          const display = out.displayData
            .slice(0, 5)
            .map((d) => `${sanitizeInline(d.mime)} (${d.sizeBytes} bytes)`)
            .join(", ")
          const suffix = out.displayData.length > 5 ? `, +${out.displayData.length - 5} more` : ""
          lines.push(`  display_data: ${display}${suffix}`)
        }
        if (out.errors && out.errors.length > 0) {
          for (const err of out.errors) {
            lines.push(
              `  error: ${sanitizeInline(err.ename)}: ${sanitizeInline(err.evalue)}`
            )
          }
        }
      }
      return {
        title: `ipynb_run ${input.mode} on ${input.filePath}`,
        output: truncateMarkdown(
          lines.join("\n"),
          MAX_RUN_RESPONSE_CHARS,
          "\n... (truncated: hard response limit reached)"
        ),
        metadata: {
          filePath: result.absPath,
          executedCells: result.executedCells.slice(0, 1_000),
          durationMs: result.durationMs,
          saved: result.saved,
          writeMode: result.writeMode,
          writeModeReason: result.writeModeReason
        }
      }
    } catch (err) {
      rethrowPermissionDenied(err)
      const message = truncate(
        sanitizeInline(stripAnsi(errorToMessage(err))),
        maxOutputChars,
        { key: "output", paramName: "maxOutputChars" }
      ).text
      return {
        title: `ipynb_run ${input.mode} on ${input.filePath} (error)`,
        output: `Error: ${message}\n\nTip: run ipynb_doctor to diagnose the environment.`,
        metadata: { error: true, message }
      }
    }
  }
})
