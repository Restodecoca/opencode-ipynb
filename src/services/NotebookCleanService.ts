import { Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  NotebookWriteError,
  PathOutsideWorktreeError,
  PermissionDeniedError
} from "../domain/errors.js"
import type { NotebookFileServiceShape } from "./NotebookFileService.js"
import { assertRevisionUnchanged, contentHash, pinRealPath } from "./revision.js"
import type { PathServiceShape } from "./PathService.js"
import {
  type PermissionServiceShape
} from "./PermissionService.js"
import type { CellRaw, CodeCellRaw } from "../domain/cell.js"
import type { NotebookRaw } from "../domain/notebook.js"

export interface CleanOptions {
  readonly clearOutputs: boolean
  readonly clearExecutionCount: boolean
  readonly stripWidgetState: boolean
  readonly stripLargeImages: boolean
  readonly normalizeSource: boolean
  readonly largeImageThresholdBytes: number
}

export interface CleanResult {
  readonly displayPath: string
  readonly absPath: string
  readonly affectedCells: number
  readonly removedOutputs: number
  readonly removedExecutionCounts: number
  readonly removedWidgets: number
  readonly removedImages: number
  readonly notebook: NotebookRaw
}

export interface NotebookCleanServiceShape {
  readonly clean: (
    filePath: string,
    options?: Partial<CleanOptions>
  ) => Effect.Effect<
    CleanResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
}

export type CleanError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | NotebookWriteError
  | PathOutsideWorktreeError
  | PermissionDeniedError

const defaultOptions: CleanOptions = {
  clearOutputs: true,
  clearExecutionCount: true,
  stripWidgetState: true,
  stripLargeImages: false,
  normalizeSource: true,
  largeImageThresholdBytes: 100_000
}

const normalizeCellSource = <T extends CellRaw>(cell: T): { readonly cell: T; readonly changed: boolean } => {
  if (Array.isArray(cell.source)) {
    return { cell: { ...cell, source: cell.source.join("") } as T, changed: true }
  }
  return { cell, changed: false }
}

const hasWidgetState = (metadata: unknown): boolean => {
  if (!metadata || typeof metadata !== "object") return false
  const m = metadata as Record<string, unknown>
  if ("widgets" in m) return true
  const j = m["jupyter"]
  return (
    j !== null &&
    typeof j === "object" &&
    ("outputs" in (j as Record<string, unknown>) ||
      "widgets" in (j as Record<string, unknown>))
  )
}

const stripWidget = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...metadata }
  if ("jupyter" in next) {
    const j = next["jupyter"]
    if (j && typeof j === "object") {
      const jn = { ...(j as Record<string, unknown>) }
      delete jn["outputs"]
      delete jn["widgets"]
      next["jupyter"] = jn
    }
  }
  if ("widgets" in next) {
    delete next["widgets"]
  }
  return next
}

const makeCleanImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
  permSvc: PermissionServiceShape
): NotebookCleanServiceShape => ({
  clean: (filePath, options) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const pinned = yield* pinRealPath(abs)
      return yield* fileSvc
        .withFileLock(
          pinned,
          Effect.gen(function* () {
            const snapshot = yield* fileSvc.readWithText(pinned)
            const notebook = snapshot.notebook
            const revision = contentHash(snapshot.text)
            const opts: CleanOptions = { ...defaultOptions, ...(options ?? {}) }
            const displayPath = pathSvc.toDisplay(abs)

            let affected = 0
            let removedOutputs = 0
            let removedExec = 0
            let removedWidgets = 0
            let removedImages = 0

            const cells = notebook.cells.map((cell) => {
              const normalized = opts.normalizeSource
                ? normalizeCellSource(cell)
                : { cell, changed: false }
              if (normalized.cell.cell_type !== "code") {
                let touched = normalized.changed
                let nextCell = normalized.cell
                if (opts.stripWidgetState && hasWidgetState(nextCell.metadata)) {
                  removedWidgets++
                  const newMeta = stripWidget(nextCell.metadata)
                  nextCell = { ...nextCell, metadata: newMeta } as typeof nextCell
                  touched = true
                }
                if (touched) {
                  affected++
                }
                return nextCell
              }

              const newCell: CodeCellRaw = { ...normalized.cell }
              let touched = normalized.changed

              if (opts.clearOutputs && newCell.outputs.length > 0) {
                removedOutputs += newCell.outputs.length
                newCell.outputs = []
                touched = true
              }

              if (opts.clearExecutionCount && newCell.execution_count !== null) {
                removedExec++
                newCell.execution_count = null
                touched = true
              }

              if (opts.stripLargeImages) {
                const filtered: typeof newCell.outputs = []
                for (const out of newCell.outputs) {
                  const data = (out as { data?: unknown }).data
                  if (data && typeof data === "object") {
                    const newData: Record<string, unknown> = {}
                    let strippedImage = false
                    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
                      if (k.startsWith("image/") && typeof v === "string" && v.length * 0.75 > opts.largeImageThresholdBytes) {
                        strippedImage = true
                      } else {
                        newData[k] = v
                      }
                    }
                    if (strippedImage) {
                      removedImages++
                      touched = true
                    }
                    filtered.push({ ...out, data: newData } as typeof out)
                  } else {
                    filtered.push(out)
                  }
                }
                newCell.outputs = filtered
              }

              if (opts.stripWidgetState && hasWidgetState(newCell.metadata)) {
                removedWidgets++
                newCell.metadata = stripWidget(newCell.metadata)
                touched = true
              }

              if (touched) {
                affected++
              }
              return newCell
            })

            let notebookMetadata = notebook.metadata
            if (
              opts.stripWidgetState &&
              notebookMetadata !== null &&
              typeof notebookMetadata === "object" &&
              "widgets" in (notebookMetadata as Record<string, unknown>)
            ) {
              removedWidgets++
              const { widgets: _widgets, ...rest } =
                notebookMetadata as Record<string, unknown>
              notebookMetadata = rest as NotebookRaw["metadata"]
            }
            const newNotebook: NotebookRaw = {
              ...notebook,
              metadata: notebookMetadata,
              cells
            }

            if (affected === 0 && removedWidgets === 0) {
              return {
                displayPath,
                absPath: abs,
                affectedCells: 0,
                removedOutputs: 0,
                removedExecutionCounts: 0,
                removedWidgets: 0,
                removedImages: 0,
                notebook
              }
            }

            const lexicalPaths = yield* permSvc.aliases(abs)
            const pinnedPaths = yield* permSvc.aliases(pinned)
            const permissionPaths = [
              ...new Set([...lexicalPaths, ...pinnedPaths])
            ]
            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_clean",
              patterns: permissionPaths,
              always: permissionPaths,
              metadata: {
                filePath: abs,
                affected,
                removedOutputs,
                removedExecutionCounts: removedExec,
                removedWidgets,
                removedImages,
                options: opts
              }
            })

            yield* assertRevisionUnchanged(fileSvc, pinned, revision)
            yield* fileSvc.writeAtomic(pinned, newNotebook, {
              noFollowFinal: true
            })

            return {
              displayPath,
              absPath: abs,
              affectedCells: affected,
              removedOutputs,
              removedExecutionCounts: removedExec,
              removedWidgets,
              removedImages,
              notebook: newNotebook
            }
          })
        )
    })
})

export { makeCleanImpl }
