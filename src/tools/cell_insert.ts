import { sanitizeInline } from "../utils/markdown-safe.js"
import { codeFence } from "../utils/fence.js"
import { z } from "zod"
import { rethrowPermissionDenied, runToolEffect, tool } from "../tool.js"
import type { ToolContext } from "../tool.js"
import { buildServices } from "../services/index.js"
import { assertReadPermission } from "./_readPermission.js"
import { errorToMessage } from "../domain/errors.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  cellType: z
    .enum(["code", "markdown", "raw"])
    .describe("Type of cell to insert"),
  source: z.string().describe("Source for the new cell"),
  index: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "0-based index where the new cell will be inserted. Omit or use a value >= total cells to append to the end."
    )
}

export const ipynbCellInsertTool = tool({
  description:
    "Insert a new cell into a Jupyter Notebook at the given index, or append to the end when index is omitted. The new cell starts with empty metadata; code cells also start with execution_count=null and outputs=[]. Asks permission before writing. Returns the new cell's index and the new total cell count.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context, { warningSink: context.warningSink })
    try {
      await assertReadPermission(context, input.filePath)
      const result = await runToolEffect(
        services.edit.insertCell(
          input.filePath,
          input.cellType,
          input.source,
          input.index
        )
      )
      const lines: string[] = []
      lines.push(
        `Inserted new ${result.cellType} cell at index [${result.cellIndex}] of \`${sanitizeInline(result.displayPath)}\`.`
      )
      lines.push(`Total cells: ${result.totalCells}`)
      lines.push("")
      lines.push("**Preview (first line):**")
      const preview = result.preview.length > 0 ? result.preview : "(empty)"
      const fence = codeFence(preview)
      lines.push(fence)
      lines.push(preview)
      lines.push(fence)
      return {
        title: `Insert cell into ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          cellIndex: result.cellIndex,
          cellType: result.cellType,
          totalCells: result.totalCells,
          writeMode: result.writeMode,
          writeModeReason: result.writeModeReason
        }
      }
    } catch (err) {
      rethrowPermissionDenied(err)
      const message = errorToMessage(err)
      return {
        title: `Insert cell into ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
