import { pathToFileURL } from "node:url"
import type { PluginOptions } from "./plugin-options.js"
import { resolvePythonPath } from "./plugin-options.js"
import { buildNotebookVirtualDocument, type NotebookVirtualDocument } from "./lsp.js"
import { makeNotebookFileService, makePathService } from "./services/index.js"
import { runToolEffect } from "./tool.js"

export interface LoadDocumentContext {
  readonly directory: string
  readonly worktree: string
  readonly allowOutsideWorktree?: boolean
  readonly options: PluginOptions
  readonly resolvePython?: boolean
}

export const loadNotebookDocument = async (
  context: LoadDocumentContext,
  filePath: string
): Promise<NotebookVirtualDocument> => {
  const paths = makePathService({
    directory: context.directory,
    worktree: context.worktree,
    platform: process.platform,
    allowOutsideWorktree: context.allowOutsideWorktree === true
  })
  const absolute = await runToolEffect(paths.resolve(filePath))
  await runToolEffect(paths.ensureInsideWorktree(absolute))
  const notebook = await runToolEffect(
    makeNotebookFileService(
      context.allowOutsideWorktree === true
        ? {}
        : { worktree: context.worktree }
    ).read(absolute)
  )
  const notebookUri = pathToFileURL(absolute).href
  let pythonPath: string | undefined
  if (context.resolvePython !== false) {
    try {
      pythonPath = resolvePythonPath(context.options)
    } catch {
      pythonPath = undefined
    }
  }
  return buildNotebookVirtualDocument(notebook, {
    filePath: absolute,
    notebookUri,
    cellUri: (cellIndex) => `${notebookUri}#cell=${cellIndex}`,
    ...(pythonPath === undefined ? {} : { pythonPath })
  })
}
