import type { Plugin } from "@opencode/plugin"
import * as path from "node:path"
import { disposeSharedKernelManager, resolveOptionsFromEnv } from "./services/index.js"
import { registerV2Tools } from "./plugin-v2.js"
import { parsePluginOptions } from "./plugin-options.js"
import {
  diagnoseNotebook,
  diagnosticFallbackTempPath,
  diagnosticTempPath,
  isPyrightAvailable,
  sanitizeNotebookText
} from "./notebook-diagnostics.js"
import { loadNotebookDocument } from "./load-document.js"
import { permissionAliases } from "./services/PermissionService.js"
import { capDiagnosticMetadata } from "./utils/metadata.js"
import { PermissionDeniedError } from "./domain/errors.js"
import {
  cleanupVirtualDocuments,
  hasMaterializedDocument,
  materializedPath,
  refreshMaterializedDocument
} from "./virtual-materialize.js"
import { NotebookRpc } from "./rpc.js"
import { v2ToolRegistrations } from "./registrations.js"
import {
  appendResultText,
  changedNotebook,
  changesCode,
  diagnosableTools,
  toolName,
  type MutableResult
} from "./notebook-hooks.js"

const plugin: Plugin.Plugin = {
  id: "opencode-ipynb",
  async setup(context) {
    // V2 passes per-plugin-instance options through setup. The adapter puts
    // them on the tool context instead of process.env, so multiple projects
    // in one OpenCode server cannot leak settings into each other. Explicit
    // env vars still take precedence when options are resolved.
    // Validate and normalize options once per plugin instance. Invalid
    // options fail setup instead of being silently ignored at tool time.
    const options = parsePluginOptions(context.options)
    const effectiveOptions = resolveOptionsFromEnv(options)
    const registration = await registerV2Tools(
      context,
      v2ToolRegistrations,
      effectiveOptions
    )

    const loadDocument = (filePath: string) =>
      loadNotebookDocument(
        {
          directory: context.location.directory,
          worktree: context.location.project.directory,
          allowOutsideWorktree: effectiveOptions.allowOutsideWorktree === true,
          options: effectiveOptions
        },
        filePath
      )

    const rpcRegistration = await context.rpc.register(NotebookRpc, {
      document: async (input, rpcContext) => {
        try {
          const document = await loadDocument(
            (input as { filePath: string }).filePath
          )
          return {
            ...document,
            sanitizedText: sanitizeNotebookText(document)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const tag = (error as { _tag?: string } | undefined)?._tag
          if (tag === "PathOutsideWorktree") {
            return rpcContext.error("outside_worktree", message, { message })
          }
          if (tag === "NotebookNotFound") {
            return rpcContext.error("not_found", message, { message })
          }
          return rpcContext.error("invalid_notebook", message, { message })
        }
      }
    })

    const hookRegistration = await context.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return
      if (event.result?.metadata?.error === true) return
      if (!changedNotebook(event.tool, event.input, event.result?.metadata)) return
      const filePath = (event.input as { filePath?: unknown } | undefined)?.filePath
      if (typeof filePath !== "string") return
      // RPC invalidation is fire-and-forget. Diagnostics below are awaited
      // on purpose so the agent sees errors in the same tool result.
      void rpcRegistration.events.emit("changed", { filePath }).catch(() => {})

      const name = toolName(event.tool)
      const absoluteForMaterialized = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(context.location.directory, filePath)
      const codeChange = changesCode(name, event.result?.metadata)
      let document: Awaited<ReturnType<typeof loadDocument>> | undefined
      try {
        if (
          codeChange &&
          (await hasMaterializedDocument(
            context.location.directory,
            absoluteForMaterialized
          ))
        ) {
          document = await loadDocument(filePath)
          const sidecar = materializedPath(
            document.filePath,
            context.location.directory
          )
          const sidecarPaths = await permissionAliases(sidecar, [
            context.location.directory,
            context.location.project.directory
          ])
          await context.permission.assert({
            sessionID: event.sessionID as never,
            agent: event.agent as never,
            source: {
              type: "tool",
              messageID: event.messageID as never,
              id: event.id as never
            },
            action: "edit",
            resources: [...sidecarPaths],
            save: [...sidecarPaths],
            metadata: {
              filePath: document.filePath,
              operation: "materialize-refresh"
            }
          })
          await refreshMaterializedDocument(document, context.location.directory)
        }
      } catch (error) {
        // Refreshing the sidecar is best-effort, but a stale navigation file
        // is user-visible: report it in the same tool result.
        const result = event.result as MutableResult | undefined
        if (result) {
          const message =
            error instanceof Error ? error.message : String(error)
          appendResultText(
            result,
            `Notebook LSP sidecar was not refreshed: ${message}`
          )
        }
      }

      if (effectiveOptions.lspDiagnostics === false || !diagnosableTools.has(name)) {
        return
      }
      if (!codeChange) return
      let permissionDenied = false
      try {
        document ??= await loadDocument(filePath)
        if (document.languageId !== "python") return
        const displayPath =
          path.relative(context.location.directory, document.filePath) ||
          document.filePath
        const tempFile = diagnosticTempPath(document.filePath)
        const fallbackTemp = diagnosticFallbackTempPath(document.filePath)
        const tempPaths = await permissionAliases(tempFile, [
          context.location.directory,
          context.location.project.directory
        ])
        const fallbackPaths = await permissionAliases(fallbackTemp, [
          context.location.directory,
          context.location.project.directory
        ])
        const lspPaths = await permissionAliases(document.filePath, [
          context.location.directory,
          context.location.project.directory
        ])
        try {
          await context.permission.assert({
            sessionID: event.sessionID as never,
            agent: event.agent as never,
            source: {
              type: "tool",
              messageID: event.messageID as never,
              id: event.id as never
            },
            action: "lsp",
            resources: [...lspPaths],
            save: [...lspPaths],
            metadata: { filePath: document.filePath, operation: "diagnostics" }
          })
        } catch (error) {
          permissionDenied = true
          throw error
        }
        // Only spawn pyright after the host approved the lsp action.
        if (
          !(await isPyrightAvailable(
            effectiveOptions.pyrightPath,
            effectiveOptions.diagnosticsTimeoutMs
          ))
        ) {
          return
        }
        try {
          await context.permission.assert({
            sessionID: event.sessionID as never,
            agent: event.agent as never,
            source: {
              type: "tool",
              messageID: event.messageID as never,
              id: event.id as never
            },
            action: "edit",
            resources: [...tempPaths],
            save: [...tempPaths],
            metadata: { filePath: document.filePath, operation: "diagnostics-temp" }
          })
        } catch (error) {
          permissionDenied = true
          throw error
        }
        const diagnostics = await diagnoseNotebook({
          tempFilePath: tempFile,
          ownedTempFile: true,
          requestFallbackPermission: async () => {
            try {
              await context.permission.assert({
                sessionID: event.sessionID as never,
                agent: event.agent as never,
                source: {
                  type: "tool",
                  messageID: event.messageID as never,
                  id: event.id as never
                },
                action: "edit",
                resources: [...fallbackPaths],
                save: [...fallbackPaths],
                metadata: {
                  filePath: document!.filePath,
                  operation: "diagnostics-temp-fallback"
                }
              })
            } catch (error) {
              permissionDenied = true
              throw new PermissionDeniedError({
                message:
                  error instanceof Error ? error.message : String(error),
                action: "edit",
                cause: error
              })
            }
          },
          filePath: document.filePath,
          document,
          displayPath,
          where: name === "ipynb_edit" ? "this file" : displayPath,
          ...(document.pythonPath === undefined
            ? {}
            : { pythonPath: document.pythonPath }),
          pyrightPath: effectiveOptions.pyrightPath,
          timeoutMs: effectiveOptions.diagnosticsTimeoutMs
        })
        const result = event.result as MutableResult | undefined
        if (!result) return
        if (diagnostics.text.length > 0) appendResultText(result, diagnostics.text)
        else if (
          diagnostics.skipped !== undefined &&
          diagnostics.skipped !== "pyright-not-found"
        ) {
          appendResultText(
            result,
            `Notebook diagnostics unavailable: ${diagnostics.skipped}.`
          )
        }
        if (diagnostics.diagnostics.length > 0) {
          result.metadata = {
            ...(result.metadata ?? {}),
            notebookDiagnostics: capDiagnosticMetadata(
              diagnostics.diagnostics
            )
          }
        }
      } catch {
        // Diagnostics are best-effort; a broken pyright or denied permission
        // must not fail the edit. Make a denial visible instead of silently
        // pretending the notebook was checked.
        if (permissionDenied) {
          const result = event.result as MutableResult | undefined
          if (result) {
            appendResultText(
              result,
              "Notebook diagnostics skipped: permission denied."
            )
          }
        }
      }
    })

    return async () => {
      try {
        await hookRegistration.dispose().catch(() => {})
        await rpcRegistration.dispose().catch(() => {})
        await registration.dispose().catch(() => {})
        await cleanupVirtualDocuments(context.location.directory).catch(() => {})
      } finally {
        // Kill every live warm kernel even when a plugin contribution fails
        // to dispose. A sidecar cleanup error must not leak Python processes.
        await disposeSharedKernelManager(context)
      }
    }
  }
}

export default plugin
