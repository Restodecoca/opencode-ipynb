import { z } from "zod"
import {
  rethrowPermissionDenied,
  tool,
  type ToolContext
} from "../tool.js"
import {
  diagnoseNotebook,
  diagnosticFallbackTempPath,
  diagnosticTempPath,
  isPyrightAvailable
} from "../notebook-diagnostics.js"
import { loadNotebookDocument } from "../load-document.js"
import {
  materializeVirtualDocument,
  materializedPath
} from "../virtual-materialize.js"
import { resolvePythonPath } from "../plugin-options.js"
import { resolveToolOptions } from "./_resolveOptions.js"
import { errorToMessage, PermissionDeniedError } from "../domain/errors.js"
import { assertReadPermission } from "./_readPermission.js"
import { permissionAliases } from "../services/PermissionService.js"
import { MAX_READ_RESPONSE_CHARS } from "../utils/limits.js"
import { capDiagnosticMetadata } from "../utils/metadata.js"
import { sanitizeInline, truncateMarkdown } from "../utils/markdown-safe.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  operation: z
    .enum(["diagnostics", "materialize"])
    .optional()
    .default("diagnostics")
    .describe(
      "diagnostics runs pyright and maps errors to cells; materialize writes the notebook's virtual .py into the project so the lsp tool from opencode-v2-lsp-support can answer hover, goToDefinition, findReferences, and documentSymbol per cell"
    ),
  maxOutputChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of output characters to return (default 6000)")
}

export const ipynbLspTool = tool({
  description:
    "Run on-demand Python diagnostics (pyright) on a Jupyter Notebook, or materialize its virtual Python document for LSP navigation. Diagnostics are mapped back to cell/line positions. With operation='materialize', the tool writes a small .py sidecar next to the notebook and returns its path plus the cell-to-line map; then call the lsp tool from opencode-v2-lsp-support (hover, goToDefinition, findReferences, documentSymbol) on that path using 1-based line/character positions.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    context.abort.throwIfAborted()
    const pluginOpts = resolveToolOptions(context)
    try {
      await assertReadPermission(context, input.filePath)
    } catch (error) {
      rethrowPermissionDenied(error)
      throw error
    }
    let pythonPath: string | undefined
    try {
      if (input.operation !== "materialize") {
        pythonPath = resolvePythonPath(pluginOpts)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        title: `ipynb_lsp ${input.filePath} (error)`,
        output: `Error: Invalid pythonPath: ${message}`,
        metadata: { error: true, message }
      }
    }
    try {
      const document = await loadNotebookDocument(
        {
          directory: context.directory,
          worktree: context.worktree,
          allowOutsideWorktree: pluginOpts.allowOutsideWorktree === true,
          options: pluginOpts,
          resolvePython: input.operation !== "materialize"
        },
        input.filePath
      )
      const absolute = document.filePath
      if (document.languageId !== "python") {
        return {
          title: `ipynb_lsp ${input.filePath}`,
          output: `ipynb_lsp currently supports Python notebooks only (detected language: ${sanitizeInline(document.languageId)}).`,
          metadata: { filePath: absolute, notebookDiagnostics: [], skipped: "unsupported-language" }
        }
      }
      if (input.operation === "materialize") {
        context.abort.throwIfAborted()
        const materializeLspPaths = await permissionAliases(absolute, [
          context.directory,
          context.worktree
        ])
        try {
          await context.ask({
            permission: "lsp",
            patterns: [...materializeLspPaths],
            always: [...materializeLspPaths],
            metadata: { filePath: absolute, operation: "materialize" }
          })
        } catch (err) {
          throw new PermissionDeniedError({
            message: err instanceof Error ? err.message : String(err),
            action: "lsp",
            cause: err
          })
        }
        const virtualPath = materializedPath(absolute, context.directory)
        const sidecarPaths = await permissionAliases(virtualPath, [
          context.directory,
          context.worktree
        ])
        try {
          await context.ask({
            permission: "edit",
            patterns: [...sidecarPaths],
            always: [...sidecarPaths],
            metadata: { filePath: absolute, operation: "materialize" }
          })
        } catch (err) {
          throw new PermissionDeniedError({
            message: err instanceof Error ? err.message : String(err),
            action: "edit",
            cause: err
          })
        }
        const materialized = await materializeVirtualDocument(
          document,
          context.directory,
          context.warningSink === undefined ? undefined : { warningSink: context.warningSink }
        )
        const lines = [
          `Virtual Python document: ${sanitizeInline(materialized.path)}`,
          "Call the lsp tool from opencode-v2-lsp-support with this path. Positions are 1-based.",
          "Cell map:"
        ]
        for (const cell of materialized.cells) {
          const range =
            cell.startLine === cell.endLine
              ? `line ${cell.startLine}`
              : `lines ${cell.startLine}-${cell.endLine}`
          lines.push(`- cell ${cell.cellIndex} (${cell.cellType}): ${range}`)
        }
        const text = lines.join("\n")
        const max = Math.min(
          input.maxOutputChars ?? 6_000,
          MAX_READ_RESPONSE_CHARS
        )
        const output =
          max >= MAX_READ_RESPONSE_CHARS
            ? truncateMarkdown(
                text,
                max,
                "\n... (truncated: hard response limit reached)"
              )
            : text.length > max
              ? `${text.slice(0, max)}\n... (truncated, use maxOutputChars to increase)`
              : text
        return {
          title: `ipynb_lsp materialize ${input.filePath}`,
          output,
          metadata: {
            filePath: absolute,
            virtualPath: materialized.path,
            cells: materialized.cells.slice(0, 1_000),
            ...(materialized.warnings === undefined ||
            materialized.warnings.length === 0
              ? {}
              : { notebookWarnings: materialized.warnings })
          }
        }
      }
      const lspPaths = await permissionAliases(absolute, [
        context.directory,
        context.worktree
      ])
      try {
        await context.ask({
          permission: "lsp",
          patterns: [...lspPaths],
          always: [...lspPaths],
          metadata: { filePath: absolute, operation: "diagnostics" }
        })
      } catch (err) {
        throw new PermissionDeniedError({
          message: err instanceof Error ? err.message : String(err),
          action: "lsp",
          cause: err
        })
      }
      if (
        !(await isPyrightAvailable(
          pluginOpts.pyrightPath,
          pluginOpts.diagnosticsTimeoutMs,
          context.abort,
          context.warningSink === undefined ? undefined : { warningSink: context.warningSink }
        ))
      ) {
        return {
          title: `ipynb_lsp ${input.filePath}`,
          output:
            "pyright was not found. Install it (for example `uv tool install pyright` or `npm i -g pyright`) or set the plugin `pyrightPath` option.",
          metadata: {
            filePath: absolute,
            notebookDiagnostics: [],
            skipped: "pyright-not-found"
          }
        }
      }
      const tempFile = diagnosticTempPath(absolute)
      const fallbackTemp = diagnosticFallbackTempPath(absolute)
      const tempPaths = await permissionAliases(tempFile, [
        context.directory,
        context.worktree
      ])
      try {
        await context.ask({
          permission: "edit",
          patterns: [...tempPaths],
          always: [...tempPaths],
          metadata: { filePath: absolute, operation: "diagnostics-temp" }
        })
      } catch (err) {
        throw new PermissionDeniedError({
          message: err instanceof Error ? err.message : String(err),
          action: "edit",
          cause: err
        })
      }
      const fallbackPaths = await permissionAliases(fallbackTemp, [
        context.directory,
        context.worktree
      ])
      const result = await diagnoseNotebook({
        filePath: absolute,
        document,
        displayPath: input.filePath,
        tempFilePath: tempFile,
        ownedTempFile: true,
        ...(context.warningSink === undefined
          ? {}
          : { warningSink: context.warningSink }),
        requestFallbackPermission: async () => {
          try {
            await context.ask({
              permission: "edit",
              patterns: [...fallbackPaths],
              always: [...fallbackPaths],
              metadata: {
                filePath: absolute,
                operation: "diagnostics-temp-fallback"
              }
            })
          } catch (err) {
            throw new PermissionDeniedError({
              message: err instanceof Error ? err.message : String(err),
              action: "edit",
              cause: err
            })
          }
        },
        ...(pythonPath === undefined ? {} : { pythonPath }),
        pyrightPath: pluginOpts.pyrightPath,
        timeoutMs: pluginOpts.diagnosticsTimeoutMs,
        signal: context.abort
      })
      if (result.skipped !== undefined) {
        const message =
          result.skipped === "pyright-not-found"
            ? "pyright was not found. Install it (for example `uv tool install pyright` or `npm i -g pyright`) or set the plugin `pyrightPath` option."
            : result.skipped === "timeout"
              ? `Diagnostics timed out after ${pluginOpts.diagnosticsTimeoutMs}ms; no conclusion was reached.`
              : result.skipped === "aborted"
                ? "Diagnostics were aborted; no conclusion was reached."
                : result.skipped === "not-analyzed"
                  ? "pyright analyzed zero files. Its configuration likely excludes this sidecar; adjust `exclude`/`include` so diagnostics are meaningful."
                  : result.skipped === "temp-unwritable"
                    ? "Neither the notebook directory nor the system temp directory is writable for the diagnostics temp file."
                    : result.skipped === "unsafe-shell-command"
                      ? "Diagnostics were skipped: the pyright command or one of its arguments contains characters a shell would reinterpret (for example % or &). Rename pyright, or the notebook directory, so the command line is free of shell metacharacters."
                      : "Diagnostics failed (pyright returned invalid output or could not run); no conclusion was reached."
        return {
          title: `ipynb_lsp ${input.filePath}`,
          output: message,
          metadata: {
            filePath: absolute,
            notebookDiagnostics: [],
            skipped: result.skipped,
            error: result.skipped !== "pyright-not-found"
          }
        }
      }
      const max = Math.min(
        input.maxOutputChars ?? 6_000,
        MAX_READ_RESPONSE_CHARS
      )
      const output =
        max >= MAX_READ_RESPONSE_CHARS
          ? truncateMarkdown(
              result.text,
              max,
              "\n... (truncated: hard response limit reached)"
            )
          : result.text.length > max
            ? `${result.text.slice(0, max)}\n... (truncated, use maxOutputChars to increase)`
            : result.text || "No errors found."
      return {
        title: `ipynb_lsp ${input.filePath}`,
        output,
        metadata: {
          filePath: absolute,
          notebookDiagnostics: capDiagnosticMetadata(result.diagnostics),
          ...(result.warnings === undefined ? {} : { warnings: result.warnings }),
          ...(result.skipped === undefined ? {} : { skipped: result.skipped })
        }
      }
    } catch (err) {
      rethrowPermissionDenied(err)
      const message = errorToMessage(err)
      return {
        title: `ipynb_lsp ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
