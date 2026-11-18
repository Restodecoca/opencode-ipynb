import { sanitizeInline } from "../utils/markdown-safe.js"
import { z } from "zod"
import { rethrowPermissionDenied, runToolEffect, tool } from "../tool.js"
import type { ToolContext } from "../tool.js"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  cellIndex: z.number().int().nonnegative().describe("Index of the cell to edit"),
  source: z.string().describe("New source for the cell (will replace existing source)"),
  clearOutputs: z
    .enum(["auto", "always", "never"])
    .optional()
    .default("auto")
    .describe(
      "Whether to clear outputs and execution_count: 'auto' (clear if source changed), 'always', or 'never'"
    )
}

export const ipynbEditTool = tool({
  description:
    "Edit a single cell of a Jupyter Notebook safely (cellIndex is 0-based). Validates before and after, preserves metadata, asks permission before writing, and returns a concise confirmation. For code cells, the default 'auto' mode clears outputs and execution_count when the source changes.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context, { warningSink: context.warningSink })
    try {
      const result = await runToolEffect(
        services.edit.editCell(input.filePath, {
          cellIndex: input.cellIndex,
          source: input.source,
          clearOutputs: input.clearOutputs
        })
      )
      const output = `Edited cell [${result.cellIndex}] of \`${sanitizeInline(result.displayPath)}\` (${result.cellType}). Outputs cleared: ${result.clearedOutputs ? "yes" : "no"}.`
      return {
        title: `Edit cell ${input.cellIndex} of ${input.filePath}`,
        output,
        metadata: {
          filePath: result.absPath,
          cellIndex: result.cellIndex,
          cellType: result.cellType,
          clearedOutputs: result.clearedOutputs,
          changed: result.changed,
          writeMode: result.writeMode,
          writeModeReason: result.writeModeReason
        }
      }
    } catch (err) {
      rethrowPermissionDenied(err)
      const message = errorToMessage(err)
      return {
        title: `Edit cell ${input.cellIndex} of ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
