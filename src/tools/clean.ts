import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  clearOutputs: z.boolean().optional().default(true).describe("Clear all cell outputs (default: true)"),
  clearExecutionCount: z
    .boolean()
    .optional()
    .default(true)
    .describe("Reset execution_count of all code cells (default: true)"),
  stripWidgetState: z
    .boolean()
    .optional()
    .default(true)
    .describe("Remove Jupyter widget state from metadata (default: true)"),
  stripLargeImages: z
    .boolean()
    .optional()
    .default(false)
    .describe("Remove large base64-encoded images from cell outputs (default: false)"),
  normalizeSource: z
    .boolean()
    .optional()
    .default(true)
    .describe("Normalize source arrays to strings before saving (default: true)")
}

export const ipynbCleanTool = tool({
  description:
    "Clean a Jupyter Notebook for Git/review by clearing outputs, execution counts, and widget state. Validates the notebook before and after, asks permission before writing, and returns a summary of what was changed.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(
        services.clean.clean(input.filePath, {
          clearOutputs: input.clearOutputs,
          clearExecutionCount: input.clearExecutionCount,
          stripWidgetState: input.stripWidgetState,
          stripLargeImages: input.stripLargeImages,
          normalizeSource: input.normalizeSource
        })
      )
      const lines: string[] = []
      lines.push(`Cleaned \`${result.displayPath}\`.`)
      lines.push(`Affected cells: ${result.affectedCells}`)
      lines.push(`Removed outputs: ${result.removedOutputs}`)
      lines.push(`Removed execution_count: ${result.removedExecutionCounts}`)
      lines.push(`Removed widget state entries: ${result.removedWidgets}`)
      lines.push(`Removed large images: ${result.removedImages}`)
      return {
        title: `Clean ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          affectedCells: result.affectedCells,
          removedOutputs: result.removedOutputs,
          removedExecutionCounts: result.removedExecutionCounts,
          removedWidgets: result.removedWidgets,
          removedImages: result.removedImages
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Clean ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
