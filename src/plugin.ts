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
import { bestEffort, makeWarningSink } from "./utils/warnings.js"
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
      const sink = makeWarningSink()
      try {
        await bestEffort(sink, "cleanup", "hook dispose", () => hookRegistration.dispose())
        await bestEffort(sink, "cleanup", "rpc dispose", () => rpcRegistration.dispose())
        await bestEffort(sink, "cleanup", "tool dispose", () => registration.dispose())
        await bestEffort(sink, "sidecar-cleanup", "virtual documents", () =>
          cleanupVirtualDocuments(context.location.directory)
        )
      } finally {
        for (const warning of sink.drain()) {
          console.warn(
            `[opencode-ipynb] ${warning.source}: ${warning.message}` +
              (warning.detail === undefined ? "" : ` (${warning.detail})`)
          )
        }
        await disposeSharedKernelManager(context)
      }
    }
  }
}

export default plugin
