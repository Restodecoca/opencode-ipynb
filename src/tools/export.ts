import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"
import { DEFAULT_MAX_EXPORT_CHARS } from "../utils/limits.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  format: z
    .enum(["markdown", "python", "summary"])
    .describe("Export format: markdown, python, or summary"),
  includeOutputs: z.boolean().optional().default(false).describe("For markdown: include outputs"),
  includeErrors: z
    .boolean()
    .optional()
    .default(true)
    .describe("For markdown: include error tracebacks (default: true)"),
  outputPath: z
    .string()
    .optional()
    .describe("Optional path to write the export to. If omitted, returns content in the tool output.")
}

export const ipynbExportTool = tool({
  description:
    "Export a Jupyter Notebook to markdown, python, or a textual summary. Optionally write the result to a file (after permission).",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(
        services.export.export(input.filePath, {
          format: input.format,
          includeOutputs: input.includeOutputs ?? false,
          includeErrors: input.includeErrors ?? true,
          outputPath: input.outputPath,
          maxExportChars: DEFAULT_MAX_EXPORT_CHARS
        })
      )
      const head = result.writtenTo
        ? `Exported ${result.cellCount} cells from \`${result.displayPath}\` to \`${result.writtenTo}\` (${result.format}).`
        : `Exported ${result.cellCount} cells from \`${result.displayPath}\` as ${result.format} (no file written).`
      const body = input.outputPath ? `${head}\n\n(File written successfully.)` : `${head}\n\n${result.rendered}`
      return {
        title: `Export ${input.filePath} as ${input.format}`,
        output: body,
        metadata: {
          filePath: result.absPath,
          format: result.format,
          cellCount: result.cellCount,
          writtenTo: result.writtenTo,
          length: result.rendered.length
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Export ${input.filePath} as ${input.format} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
