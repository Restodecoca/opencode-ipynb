import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  cellIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("0-based index of the cell to delete")
}

export const ipynbCellDeleteTool = tool({
  description:
    "Delete a cell from a Jupyter Notebook by index. Asks permission before writing. Returns the deleted cell's type, a short preview of its source, and the new total cell count.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(
        services.edit.deleteCell(input.filePath, input.cellIndex)
      )
      const lines: string[] = []
      lines.push(
        `Deleted ${result.deletedType} cell at index [${result.deletedIndex}] from \`${result.displayPath}\`.`
      )
      lines.push(`Total cells: ${result.totalCells}`)
      lines.push("")
      lines.push("**Deleted source (preview):**")
      lines.push("```")
      lines.push(result.deletedPreview)
      lines.push("```")
      return {
        title: `Delete cell ${input.cellIndex} of ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          deletedIndex: result.deletedIndex,
          deletedType: result.deletedType,
          totalCells: result.totalCells
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Delete cell ${input.cellIndex} of ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
