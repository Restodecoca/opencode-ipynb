import { Context, Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  NotebookWriteError,
  PathOutsideWorktreeError,
  PermissionDeniedError
} from "../domain/errors.js"
import { NotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { PathService, type PathServiceShape } from "./PathService.js"
import { PermissionService, type PermissionServiceShape } from "./PermissionService.js"
import type { CellRaw, CodeCellRaw } from "../domain/cell.js"
import type { NotebookRaw } from "../domain/notebook.js"
import { unwrapFiberFailure } from "../utils/fiber.js"

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

export class NotebookCleanService extends Context.Tag("@ipynb/NotebookCleanService")<
  NotebookCleanService,
  NotebookCleanServiceShape
>() {}

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

const isWidget = (metadata: unknown): boolean => {
  if (!metadata || typeof metadata !== "object") {
    return false
  }
  const m = metadata as Record<string, unknown>
  if ("jupyter" in m) {
    const j = m["jupyter"]
    if (j && typeof j === "object" && "outputs" in (j as Record<string, unknown>)) {
      const outs = (j as { outputs?: unknown }).outputs
      if (outs && typeof outs === "object") {
        return true
      }
    }
  }
  return false
}

const stripWidget = (metadata: Record<string, unknown>): Record<string, unknown> => {
  const next = { ...metadata }
  if ("jupyter" in next) {
    const j = next["jupyter"]
    if (j && typeof j === "object") {
      const jn = { ...(j as Record<string, unknown>) }
      delete jn["outputs"]
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
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
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
                if (opts.stripWidgetState && isWidget(nextCell.metadata)) {
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

              if (opts.stripWidgetState && isWidget(newCell.metadata)) {
                removedWidgets++
                newCell.metadata = stripWidget(newCell.metadata)
                touched = true
              }

              if (touched) {
                affected++
              }
              return newCell
            })

            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_clean",
              patterns: [abs],
              always: [abs],
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

            yield* fileSvc.writeAtomic(abs, newNotebook)

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
        .pipe(
          Effect.mapError(unwrapFiberFailure<CleanError>)
        )
    })
})

export { makeCleanImpl }
