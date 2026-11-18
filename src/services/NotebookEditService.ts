import { Effect } from "effect"
import {
  CellIndexOutOfBoundsError,
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  NotebookWriteError,
  PathOutsideWorktreeError,
  PermissionDeniedError
} from "../domain/errors.js"
import type { NotebookFileServiceShape, WriteMode } from "./NotebookFileService.js"
import type { PatchFailureReason } from "../utils/json.js"
import { assertRevisionUnchanged, contentHash, pinRealPath } from "./revision.js"
import { randomUUID } from "node:crypto"
import type { PathServiceShape } from "./PathService.js"
import {
  type PermissionServiceShape
} from "./PermissionService.js"
import { cellSource, formatSourceLike, type NotebookRaw } from "../domain/notebook.js"
import type { CellRaw, CodeCellRaw, MarkdownCellRaw, RawCellRaw, Source } from "../domain/cell.js"
import { firstLine, truncatePreview } from "../utils/truncate.js"

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
  readonly changed: boolean
  readonly notebook: NotebookRaw
  readonly writeMode: WriteMode | undefined
  readonly writeModeReason?: PatchFailureReason | undefined
}

export interface InsertResult {
  readonly displayPath: string
  readonly absPath: string
  readonly cellIndex: number
  readonly cellType: "code" | "markdown" | "raw"
  readonly totalCells: number
  readonly preview: string
  readonly writeMode: WriteMode
  readonly writeModeReason?: PatchFailureReason | undefined
}

export interface DeleteResult {
  readonly displayPath: string
  readonly absPath: string
  readonly deletedIndex: number
  readonly deletedType: "code" | "markdown" | "raw"
  readonly deletedPreview: string
  readonly totalCells: number
  readonly writeMode: WriteMode
  readonly writeModeReason?: PatchFailureReason | undefined
}

export interface MoveResult {
  readonly displayPath: string
  readonly absPath: string
  readonly fromIndex: number
  readonly toIndex: number
  readonly cellType: CellType
  readonly totalCells: number
  readonly writeMode: WriteMode | undefined
  readonly writeModeReason?: PatchFailureReason | undefined
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

const buildNewCell = (
  cellType: CellType,
  source: string,
  nbformatMinor: number,
  previousSource: Source | undefined
): CellRaw => {
  const id = nbformatMinor >= 5 ? { id: randomUUID() } : {}
  const shaped =
    previousSource === undefined ? source : formatSourceLike(previousSource, source)
  if (cellType === "code") {
    const cell: CodeCellRaw = {
      cell_type: "code",
      execution_count: null,
      ...id,
      metadata: {},
      outputs: [],
      source: shaped
    }
    return cell
  }
  if (cellType === "markdown") {
    const cell: MarkdownCellRaw = {
      cell_type: "markdown",
      ...id,
      metadata: {},
      source: shaped
    }
    return cell
  }
  const cell: RawCellRaw = {
    cell_type: "raw",
    ...id,
    metadata: {},
    source: shaped
  }
  return cell
}

const makeEditImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
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
      const pinned = yield* pinRealPath(abs)
      return yield* fileSvc
        .withFileLock(
          pinned,
          Effect.gen(function* () {
            const snapshot = yield* fileSvc.readWithText(pinned)
            const notebook = snapshot.notebook
            const revision = contentHash(snapshot.text)
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
            const newCellSource = formatSourceLike(cell.source, newSource)
            const displayPath = pathSvc.toDisplay(abs)
            const mode = request.clearOutputs ?? "auto"
            const sourceChanged = oldSource !== newSource
            const clearedOutputs =
              cell.cell_type === "code" &&
              (mode === "always" || (mode === "auto" && sourceChanged)) &&
              ((cell as CodeCellRaw).outputs.length > 0 ||
                (cell as CodeCellRaw).execution_count !== null)
            const changed = sourceChanged || clearedOutputs
            if (!changed) {
              return {
                displayPath,
                absPath: abs,
                cellIndex: idx,
                cellType: cell.cell_type,
                clearedOutputs: false,
                changed: false,
                notebook,
                writeMode: undefined
              }
            }

            const lexicalPaths = yield* permSvc.aliases(abs)
            const pinnedPaths = yield* permSvc.aliases(pinned)
            const permissionPaths = [
              ...new Set([...lexicalPaths, ...pinnedPaths])
            ]
            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_edit",
              patterns: permissionPaths,
              always: permissionPaths,
              metadata: {
                filePath: abs,
                cellIndex: idx,
                cellType: cell.cell_type
              }
            })

            const newCell: CellRaw = (() => {
              if (cell.cell_type === "code") {
                const code = cell as CodeCellRaw
                if (clearedOutputs) {
                  return {
                    ...code,
                    source: newCellSource,
                    outputs: [],
                    execution_count: null
                  }
                }
                return { ...code, source: newCellSource }
              }
              if (cell.cell_type === "markdown") {
                const md = cell as MarkdownCellRaw
                return { ...md, source: newCellSource }
              }
              const raw = cell as RawCellRaw
              return { ...raw, source: newCellSource }
            })()

            const cells = notebook.cells.slice()
            cells[idx] = newCell
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* assertRevisionUnchanged(fileSvc, pinned, revision)
            const write = yield* fileSvc.writeAtomic(pinned, newNotebook, {
              noFollowFinal: true,
              format: snapshot.format,
              previousText: snapshot.text
            })

            return {
              displayPath,
              absPath: abs,
              cellIndex: idx,
              cellType: cell.cell_type,
              clearedOutputs,
              changed: true,
              notebook: newNotebook,
              writeMode: write.mode,
              writeModeReason: write.reason
            }
          })
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
      const pinned = yield* pinRealPath(abs)
      return yield* fileSvc
        .withFileLock(
          pinned,
          Effect.gen(function* () {
            const snapshot = yield* fileSvc.readWithText(pinned)
            const notebook = snapshot.notebook
            const revision = contentHash(snapshot.text)
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
            const template = notebook.cells[0] as CellRaw | undefined
            const newCell = buildNewCell(
              cellType,
              source,
              notebook.nbformat_minor ?? 0,
              template?.source
            )
            const preview = firstLine(source).slice(0, 200)

            const lexicalPaths = yield* permSvc.aliases(abs)
            const pinnedPaths = yield* permSvc.aliases(pinned)
            const permissionPaths = [
              ...new Set([...lexicalPaths, ...pinnedPaths])
            ]
            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_insert",
              patterns: permissionPaths,
              always: permissionPaths,
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

            yield* assertRevisionUnchanged(fileSvc, pinned, revision)
            const write = yield* fileSvc.writeAtomic(pinned, newNotebook, {
              noFollowFinal: true,
              format: snapshot.format,
              previousText: snapshot.text
            })

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              cellIndex: targetIdx,
              cellType,
              totalCells: total + 1,
              preview,
              writeMode: write.mode,
              writeModeReason: write.reason
            }
          })
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
      const pinned = yield* pinRealPath(abs)
      return yield* fileSvc
        .withFileLock(
          pinned,
          Effect.gen(function* () {
            const snapshot = yield* fileSvc.readWithText(pinned)
            const notebook = snapshot.notebook
            const revision = contentHash(snapshot.text)
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

            const lexicalPaths = yield* permSvc.aliases(abs)
            const pinnedPaths = yield* permSvc.aliases(pinned)
            const permissionPaths = [
              ...new Set([...lexicalPaths, ...pinnedPaths])
            ]
            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_delete",
              patterns: permissionPaths,
              always: permissionPaths,
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

            yield* assertRevisionUnchanged(fileSvc, pinned, revision)
            const write = yield* fileSvc.writeAtomic(pinned, newNotebook, {
              noFollowFinal: true,
              format: snapshot.format,
              previousText: snapshot.text
            })

            const displayPath = pathSvc.toDisplay(abs)
            return {
              displayPath,
              absPath: abs,
              deletedIndex: cellIndex,
              deletedType: cellType,
              deletedPreview,
              totalCells: total - 1,
              writeMode: write.mode,
              writeModeReason: write.reason
            }
          })
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
      const pinned = yield* pinRealPath(abs)
      return yield* fileSvc
        .withFileLock(
          pinned,
          Effect.gen(function* () {
            const snapshot = yield* fileSvc.readWithText(pinned)
            const notebook = snapshot.notebook
            const revision = contentHash(snapshot.text)
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
            const cell = notebook.cells[fromIndex] as CellRaw
            const cellType = cell.cell_type

            if (fromIndex === clampedTo) {
              return {
                displayPath,
                absPath: abs,
                fromIndex,
                toIndex: clampedTo,
                cellType,
                totalCells: total,
                writeMode: undefined
              }
            }

            const lexicalPaths = yield* permSvc.aliases(abs)
            const pinnedPaths = yield* permSvc.aliases(pinned)
            const permissionPaths = [
              ...new Set([...lexicalPaths, ...pinnedPaths])
            ]
            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_cell_move",
              patterns: permissionPaths,
              always: permissionPaths,
              metadata: {
                filePath: abs,
                fromIndex,
                toIndex: clampedTo,
                cellType,
                totalCells: total
              }
            })

            const cells = notebook.cells.slice()
            cells.splice(fromIndex, 1)
            cells.splice(clampedTo, 0, cell)
            const newNotebook: NotebookRaw = { ...notebook, cells }

            yield* assertRevisionUnchanged(fileSvc, pinned, revision)
            const write = yield* fileSvc.writeAtomic(pinned, newNotebook, {
              noFollowFinal: true,
              format: snapshot.format,
              previousText: snapshot.text
            })

            return {
              displayPath,
              absPath: abs,
              fromIndex,
              toIndex: clampedTo,
              cellType,
              totalCells: total,
              writeMode: write.mode,
              writeModeReason: write.reason
            }
          })
        )
    })

  return { editCell, insertCell, deleteCell, moveCell }
}

export { makeEditImpl }
