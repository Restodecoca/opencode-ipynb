import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  fromIndex: z
    .number()
    .int()
    .nonnegative()
    .describe("0-based index of the cell to move"),
  toIndex: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "0-based final index of the cell after the move. Values >= total cells are clamped to the last valid index."
    )
}

export const ipynbCellMoveTool = tool({
  description:
    "Move a cell within a Jupyter Notebook from one index to another. Asks permission before writing. Returns the original and final index plus the (unchanged) total cell count.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(
        services.edit.moveCell(
          input.filePath,
          input.fromIndex,
          input.toIndex
        )
      )
      const lines: string[] = []
      lines.push(
        `Moved cell from [${result.fromIndex}] to [${result.toIndex}] in \`${result.displayPath}\`.`
      )
      lines.push(`Total cells: ${result.totalCells} (unchanged)`)
      return {
        title: `Move cell ${input.fromIndex} to ${input.toIndex} in ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          fromIndex: result.fromIndex,
          toIndex: result.toIndex,
          totalCells: result.totalCells
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Move cell ${input.fromIndex} to ${input.toIndex} in ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
