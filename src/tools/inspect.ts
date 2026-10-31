import { z } from "zod"
import { rethrowPermissionDenied, runToolEffect, tool } from "../tool.js"
import { Effect } from "effect"
import type { ToolContext } from "../tool.js"
import { buildServices, type NotebookServices } from "../services/index.js"
import {
  formatInspectSummary,
  analyzeMissingPackagesForPython
} from "../services/NotebookInspectService.js"
import { errorToMessage, PermissionDeniedError } from "../domain/errors.js"
import { assertReadPermission } from "./_readPermission.js"
import { permissionAliases } from "../services/PermissionService.js"
import { pythonInterpreterResources } from "../services/PythonService.js"
import { MAX_DIAGNOSTICS_METADATA } from "../utils/limits.js"

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

const run = (
  services: NotebookServices,
  input: z.infer<z.ZodObject<typeof args>>,
  signal?: AbortSignal
) =>
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
        if (
          !pythonInterpreterResources(services.pythonPath).includes(
            probe.pythonPath
          )
        ) {
          yield* services.permission.ask({
            kind: "shell",
            action: "ipynb_inspect_python",
            patterns: [probe.pythonPath],
            always: [probe.pythonPath],
            metadata: { filePath: summary.filePath, pythonPath: probe.pythonPath }
          })
        }
        missingPackageWarnings = yield* analyzeMissingPackagesForPython(
          summary.notebook,
          probe.pythonPath,
          services.python.checkImport,
          services.python.checkImports,
          signal
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
        missingPackageWarnings: (() => {
          let bytes = 0
          const out: string[] = []
          for (const warning of missingPackageWarnings.slice(
            0,
            MAX_DIAGNOSTICS_METADATA
          )) {
            if (bytes + warning.length > 200_000) break
            bytes += warning.length
            out.push(warning)
          }
          return out
        })()
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
      await assertReadPermission(context, input.filePath)
      if (
        input.checkMissingPackages === true &&
        services.pythonPathError !== undefined
      ) {
        const message = `Invalid pythonPath: ${services.pythonPathError}`
        return {
          title: `Inspect ${input.filePath} (error)`,
          output: `Error: ${message}`,
          metadata: { error: true, message }
        }
      }
      if (input.checkMissingPackages === true) {
        const configured = services.pythonPath
        const patterns = await permissionAliases(input.filePath, [
          context.directory,
          context.worktree
        ])
        try {
          await context.ask({
            permission: "shell",
            patterns: [
              ...pythonInterpreterResources(configured),
              ...patterns
            ],
            always: [...patterns],
            metadata: {
              filePath: input.filePath,
              action: "ipynb_inspect_missing_packages"
            }
          })
        } catch (err) {
          throw new PermissionDeniedError({
            message: err instanceof Error ? err.message : String(err),
            action: "shell",
            cause: err
          })
        }
      }
      const result = await runToolEffect(run(services, input, context.abort))
      return {
        title: `Inspect ${input.filePath}`,
        output: result.output,
        metadata: result.metadata
      }
    } catch (err) {
      rethrowPermissionDenied(err)
      const message = errorToMessage(err)
      return {
        title: `Inspect ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
