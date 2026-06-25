import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
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
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(
        services.edit.insertCell(
          input.filePath,
          input.cellType,
          input.source,
          input.index
        )
      )
      const lines: string[] = []
      lines.push(
        `Inserted new ${result.cellType} cell at index [${result.cellIndex}] of \`${result.displayPath}\`.`
      )
      lines.push(`Total cells: ${result.totalCells}`)
      lines.push("")
      lines.push("**Preview (first line):**")
      lines.push("```")
      lines.push(result.preview.length > 0 ? result.preview : "(empty)")
      lines.push("```")
      return {
        title: `Insert cell into ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          cellIndex: result.cellIndex,
          cellType: result.cellType,
          totalCells: result.totalCells
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Insert cell into ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
