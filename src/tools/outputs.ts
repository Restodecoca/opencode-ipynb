import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage, NotebookNotImplementedError } from "../domain/errors.js"
import { resolveToolOptions } from "./_resolveOptions.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  operation: z
    .enum(["list", "read", "read_error", "clear_cell", "clear_all"])
    .describe(
      "Output operation: list (default), read (cellIndex), read_error (cellIndex), clear_cell (cellIndex), clear_all"
    ),
  cellIndex: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Required for read/read_error/clear_cell"),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("For list: zero-based start index for pagination (ignored for other operations)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("For list: max number of entries to return; <=0 means no limit (capped at 500). Ignored for other operations"),
  includeImages: z
    .boolean()
    .optional()
    .default(false)
    .describe("For read: include image payloads (not yet supported; will still be omitted)"),
  maxOutputChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "For read: maximum number of output characters per cell; falls back to ipynb.defaultMaxOutputChars, then 6000"
    )
}

export const ipynbOutputsTool = tool({
  description:
    "Work with cell outputs: list (with pagination), read (per-cell), read_error, clear_cell, clear_all. Always asks permission before clearing. Images and base64 payloads are omitted by default.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      if (input.operation === "list") {
        const list = await Effect.runPromise(
          services.output.listOutputs(input.filePath, input.offset, input.limit)
        )
        const lines: string[] = []
        lines.push(`Outputs in \`${list.displayPath}\`:`)
        lines.push("")
        if (list.entries.length === 0) {
          lines.push(list.total === 0 ? "(no code cells with outputs)" : "(no entries in this page)")
        } else {
          lines.push("| cell | type | #outputs | hasError | hasImage | total bytes |")
          lines.push("| --- | --- | --- | --- | --- | --- |")
          for (const e of list.entries) {
            lines.push(
              `| ${e.cellIndex} | ${e.cellType} | ${e.outputCount} | ${e.hasError ? "yes" : "no"} | ${e.hasImage ? "yes" : "no"} | ${e.totalBytes} |`
            )
          }
        }
        const total = list.total
        const offset = list.offset ?? 0
        const limit = list.limit ?? 0
        if (total > limit && total > 0) {
          const first = offset + 1
          const last = Math.min(offset + list.entries.length, total)
          lines.push("")
          lines.push(`(showing entries ${first}..${last} of ${total})`)
        }
        return {
          title: `List outputs in ${input.filePath}`,
          output: lines.join("\n"),
          metadata: {
            filePath: list.displayPath,
            count: list.entries.length,
            offset,
            limit,
            total
          }
        }
      }

      if (input.operation === "read") {
        if (input.cellIndex === undefined) {
          throw new Error("cellIndex is required for read operation")
        }
        const pluginOpts = resolveToolOptions()
        const result = await Effect.runPromise(
          services.output.readOutputs(input.filePath, {
            cellIndex: input.cellIndex,
            includeImages: input.includeImages ?? false,
            maxOutputChars: input.maxOutputChars ?? pluginOpts.defaultMaxOutputChars
          })
        )
        return {
          title: `Read outputs of cell [${input.cellIndex}] in ${input.filePath}`,
          output: result.rendered,
          metadata: { cellIndex: result.cellIndex, count: result.outputCount }
        }
      }

      if (input.operation === "read_error") {
        if (input.cellIndex === undefined) {
          throw new Error("cellIndex is required for read_error operation")
        }
        const result = await Effect.runPromise(
          services.output.readError(input.filePath, input.cellIndex)
        )
        return {
          title: `Read error of cell [${input.cellIndex}] in ${input.filePath}`,
          output: result.rendered,
          metadata: { cellIndex: result.cellIndex, hasError: result.hasError }
        }
      }

      if (input.operation === "clear_cell") {
        if (input.cellIndex === undefined) {
          throw new Error("cellIndex is required for clear_cell operation")
        }
        const result = await Effect.runPromise(
          services.output.clearCellOutputs(input.filePath, input.cellIndex)
        )
        return {
          title: `Clear outputs of cell [${input.cellIndex}] in ${input.filePath}`,
          output: `Cleared ${result.clearedCells} cell(s); removed ${result.removedOutputs} output(s) and ${result.removedExecutionCounts} execution_count(s).`,
          metadata: result
        }
      }

      if (input.operation === "clear_all") {
        const result = await Effect.runPromise(
          services.output.clearAllOutputs(input.filePath)
        )
        return {
          title: `Clear all outputs in ${input.filePath}`,
          output: `Cleared ${result.clearedCells} cell(s); removed ${result.removedOutputs} output(s) and ${result.removedExecutionCounts} execution_count(s).`,
          metadata: result
        }
      }

      throw new NotebookNotImplementedError({
        message: `unknown operation ${String(input.operation)}`,
        feature: `ipynb_outputs ${String(input.operation)}`
      })
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `ipynb_outputs ${input.operation} on ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
