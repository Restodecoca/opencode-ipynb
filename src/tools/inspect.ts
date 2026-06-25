import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices, type NotebookServices } from "../services/index.js"
import {
  formatInspectSummary,
  analyzeMissingPackagesForPython
} from "../services/NotebookInspectService.js"
import { errorToMessage } from "../domain/errors.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  includeMetadata: z.boolean().optional().describe("Include metadata summary in the output"),
  includeOutputsSummary: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include per-cell output summary in the table"),
  maxCells: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of cells to include in the table (default 200)"),
  checkMissingPackages: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "If true, attempt to detect code cells that import packages which are not installed in the user's Python environment. Requires a working Python interpreter (see ipynb_doctor). Off by default to keep inspect fast."
    )
}

const run = (services: NotebookServices, input: z.infer<z.ZodObject<typeof args>>) =>
  Effect.gen(function* () {
    const summary = yield* services.inspect.inspect(input.filePath, {
      includeMetadata: input.includeMetadata ?? false,
      includeOutputsSummary: input.includeOutputsSummary ?? true,
      maxCells: input.maxCells ?? 200
    })
    let missingPackageWarnings: ReadonlyArray<string> = []
    if (input.checkMissingPackages === true) {
      const probe = yield* services.python.probe()
      if (probe.from !== "none") {
        missingPackageWarnings = yield* analyzeMissingPackagesForPython(
          summary.notebook,
          probe.pythonPath,
          services.python.checkImport
        )
      }
    }
    return {
      output: formatInspectSummary({ ...summary, missingPackageWarnings }),
      metadata: {
        filePath: summary.filePath,
        displayPath: summary.displayPath,
        totalCells: summary.totalCells,
        truncated: summary.truncated,
        missingPackageWarnings
      }
    }
  })

export const ipynbInspectTool = tool({
  description:
    "Inspect a Jupyter Notebook (.ipynb) and return a compact summary (kernel, language, cell counts, output/error/large-output stats, cell table) without dumping the full JSON.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(run(services, input))
      return {
        title: `Inspect ${input.filePath}`,
        output: result.output,
        metadata: result.metadata
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Inspect ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
