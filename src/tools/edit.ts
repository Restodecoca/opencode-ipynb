import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
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
    "Edit a single cell of a Jupyter Notebook safely. Validates before and after, preserves metadata, asks permission before writing, and returns a textual diff of the cell source. For code cells, the default 'auto' mode clears outputs and execution_count when the source changes.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(
        services.edit.editCell(input.filePath, {
          cellIndex: input.cellIndex,
          source: input.source,
          clearOutputs: input.clearOutputs
        })
      )
      const lines: string[] = []
      lines.push(`Edited cell [${result.cellIndex}] of \`${result.displayPath}\` (${result.cellType}).`)
      lines.push(`Outputs cleared: ${result.clearedOutputs ? "yes" : "no"}`)
      lines.push("")
      lines.push("**Old source (preview):**")
      lines.push("```")
      lines.push(result.oldPreview)
      lines.push("```")
      lines.push("")
      lines.push("**New source (preview):**")
      lines.push("```")
      lines.push(result.newPreview)
      lines.push("```")
      lines.push("")
      lines.push("**Diff:**")
      lines.push("```diff")
      lines.push(result.diff)
      lines.push("```")
      return {
        title: `Edit cell ${input.cellIndex} of ${input.filePath}`,
        output: lines.join("\n"),
        metadata: {
          filePath: result.absPath,
          cellIndex: result.cellIndex,
          cellType: result.cellType,
          clearedOutputs: result.clearedOutputs,
          diff: result.diff
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Edit cell ${input.cellIndex} of ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
