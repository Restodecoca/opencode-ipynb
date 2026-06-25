import { Context, Effect } from "effect"
import {
  CellIndexOutOfBoundsError,
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
import { DiffService, type DiffServiceShape } from "./DiffService.js"
import { cellSource, type NotebookRaw } from "../domain/notebook.js"
import type { CellRaw, CodeCellRaw, MarkdownCellRaw, RawCellRaw } from "../domain/cell.js"
import { firstLine, truncatePreview } from "../utils/truncate.js"
import { unwrapFiberFailure } from "../utils/fiber.js"

export interface EditRequest {
  readonly cellIndex: number
  readonly source: string
  readonly clearOutputs?: "auto" | "always" | "never"
}

export interface EditResult {
  readonly displayPath: string
  readonly absPath: string
  readonly cellIndex: number
  readonly cellType: "code" | "markdown" | "raw"
  readonly clearedOutputs: boolean
  readonly diff: string
  readonly oldPreview: string
  readonly newPreview: string
  readonly notebook: NotebookRaw
}

export interface InsertResult {
  readonly displayPath: string
  readonly absPath: string
  readonly cellIndex: number
  readonly cellType: "code" | "markdown" | "raw"
  readonly totalCells: number
  readonly preview: string
}

export interface DeleteResult {
  readonly displayPath: string
  readonly absPath: string
  readonly deletedIndex: number
  readonly deletedType: "code" | "markdown" | "raw"
  readonly deletedPreview: string
  readonly totalCells: number
}

export interface MoveResult {
  readonly displayPath: string
  readonly absPath: string
  readonly fromIndex: number
  readonly toIndex: number
  readonly totalCells: number
}

export type CellType = "code" | "markdown" | "raw"

export type EditCellError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | CellIndexOutOfBoundsError
  | NotebookWriteError
  | PathOutsideWorktreeError
  | PermissionDeniedError

export type InsertCellError = EditCellError
export type DeleteCellError = EditCellError
export type MoveCellError = EditCellError

export interface NotebookEditServiceShape {
  readonly editCell: (
    filePath: string,
    request: EditRequest
  ) => Effect.Effect<
    EditResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
  readonly insertCell: (
    filePath: string,
    cellType: CellType,
    source: string,
    index: number | undefined
  ) => Effect.Effect<
    InsertResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
  readonly deleteCell: (
    filePath: string,
    cellIndex: number
  ) => Effect.Effect<
    DeleteResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
  readonly moveCell: (
    filePath: string,
    fromIndex: number,
    toIndex: number
  ) => Effect.Effect<
    MoveResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
}

export class NotebookEditService extends Context.Tag("@ipynb/NotebookEditService")<
  NotebookEditService,
  NotebookEditServiceShape
>() {}

const buildNewCell = (cellType: CellType, source: string): CellRaw => {
  if (cellType === "code") {
    const cell: CodeCellRaw = {
      cell_type: "code",
      metadata: {},
      execution_count: null,
      source,
      outputs: []
    }
    return cell
  }
  if (cellType === "markdown") {
    const cell: MarkdownCellRaw = {
      cell_type: "markdown",
      metadata: {},
      source
    }
    return cell
  }
  const cell: RawCellRaw = {
    cell_type: "raw",
    metadata: {},
    source
  }
  return cell
}

const makeEditImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
  diffSvc: DiffServiceShape,
  permSvc: PermissionServiceShape
): NotebookEditServiceShape => {
  const editCell = (
    filePath: string,
    request: EditRequest
  ): Effect.Effect<
    EditResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const idx = request.cellIndex
            if (idx < 0 || idx >= notebook.cells.length) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested cell ${idx} but notebook has ${notebook.cells.length} cells`,
                filePath: abs,
                cellIndex: idx,
                total: notebook.cells.length
              })
            }
            const cell = notebook.cells[idx] as CellRaw
            const oldSource = cellSource(cell)
            const newSource = request.source
            const diff = diffSvc.cellDiff(oldSource, newSource)
            const oldPreview = truncatePreview(oldSource, 400)
            const newPreview = truncatePreview(newSource, 400)
            const mode = request.clearOutputs ?? "auto"
            const clearedOutputs = mode === "always" || (mode === "auto" && cell.cell_type === "code" && oldSource !== newSource)

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_edit",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                cellIndex: idx,
                cellType: cell.cell_type,
                oldPreview,
                newPreview,
                diff
              }
            })

            const newCell: CellRaw = (() => {
              if (cell.cell_type === "code") {
                const code = cell as CodeCellRaw
                if (clearedOutputs) {
                  return {
                    ...code,
                    source: newSource,
                    outputs: [],
                    execution_count: null
                  }
                }
                return { ...code, source: newSource }
              }
              if (cell.cell_type === "markdown") {
                const md = cell as MarkdownCellRaw
                return { ...md, source: newSource }
              }
              const raw = cell as RawCellRaw
              return { ...raw, source: newSource }
            })()

            const cells = notebook.cells.slice()
            cells[idx] = newCell
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              cellIndex: idx,
              cellType: cell.cell_type,
              clearedOutputs,
              diff,
              oldPreview,
              newPreview,
              notebook: newNotebook
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<EditCellError>)
        )
    })

  const insertCell = (
    filePath: string,
    cellType: CellType,
    source: string,
    index: number | undefined
  ): Effect.Effect<
    InsertResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const total = notebook.cells.length

            if (index !== undefined && index < 0) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested cell index ${index} but it must be non-negative`,
                filePath: abs,
                cellIndex: index,
                total
              })
            }

            const targetIdx = index === undefined || index >= total ? total : index
            const newCell = buildNewCell(cellType, source)
            const preview = firstLine(source)

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_insert",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                cellType,
                requestedIndex: index,
                cellIndex: targetIdx,
                totalCells: total + 1,
                preview
              }
            })

            const cells = notebook.cells.slice()
            cells.splice(targetIdx, 0, newCell)
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              cellIndex: targetIdx,
              cellType,
              totalCells: total + 1,
              preview
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<InsertCellError>)
        )
    })

  const deleteCell = (
    filePath: string,
    cellIndex: number
  ): Effect.Effect<
    DeleteResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const total = notebook.cells.length

            if (cellIndex < 0 || cellIndex >= total) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested cell ${cellIndex} but notebook has ${total} cells`,
                filePath: abs,
                cellIndex,
                total
              })
            }

            const cell = notebook.cells[cellIndex] as CellRaw
            const cellType = cell.cell_type
            const deletedPreview = truncatePreview(cellSource(cell), 80)

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_delete",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                cellIndex,
                cellType,
                deletedPreview,
                totalCells: total - 1
              }
            })

            const cells = notebook.cells.slice()
            cells.splice(cellIndex, 1)
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              deletedIndex: cellIndex,
              deletedType: cellType,
              deletedPreview,
              totalCells: total - 1
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<DeleteCellError>)
        )
    })

  const moveCell = (
    filePath: string,
    fromIndex: number,
    toIndex: number
  ): Effect.Effect<
    MoveResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      return yield* fileSvc
        .withFileLock(
          abs,
          Effect.gen(function* () {
            const notebook = yield* fileSvc.read(abs)
            const total = notebook.cells.length

            if (fromIndex < 0 || fromIndex >= total) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested fromIndex ${fromIndex} but notebook has ${total} cells`,
                filePath: abs,
                cellIndex: fromIndex,
                total
              })
            }

            if (toIndex < 0) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested toIndex ${toIndex} but it must be non-negative`,
                filePath: abs,
                cellIndex: toIndex,
                total
              })
            }

            const clampedTo = Math.min(toIndex, total - 1)
            const displayPath = pathSvc.toDisplay(abs)

            if (fromIndex === clampedTo) {
              return {
                displayPath,
                absPath: abs,
                fromIndex,
                toIndex: clampedTo,
                totalCells: total
              }
            }

            const cell = notebook.cells[fromIndex] as CellRaw

            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_move",
              patterns: [abs],
              always: [abs],
              metadata: {
                filePath: abs,
                fromIndex,
                toIndex: clampedTo,
                totalCells: total
              }
            })

            const cells = notebook.cells.slice()
            cells.splice(fromIndex, 1)
            cells.splice(clampedTo, 0, cell)
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* fileSvc.writeAtomic(abs, newNotebook)

            return {
              displayPath,
              absPath: abs,
              fromIndex,
              toIndex: clampedTo,
              totalCells: total
            }
          })
        )
        .pipe(
          Effect.mapError(unwrapFiberFailure<MoveCellError>)
        )
    })

  return { editCell, insertCell, deleteCell, moveCell }
}

export { makeEditImpl }
