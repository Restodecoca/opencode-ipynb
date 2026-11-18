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
import type { NotebookFileServiceShape } from "./NotebookFileService.js"
import { assertRevisionUnchanged, contentHash, pinRealPath } from "./revision.js"
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  MAX_READ_RESPONSE_CHARS
} from "../utils/limits.js"
import type { PathServiceShape } from "./PathService.js"
import {
  type PermissionServiceShape
} from "./PermissionService.js"
import { formatOutputs, type OutputFormatOptions } from "../format/outputs.js"
import type { CellRaw, CodeCellRaw } from "../domain/cell.js"

export type OutputOperation = "list" | "read" | "read_error" | "clear_cell" | "clear_all"

export interface OutputListEntry {
  readonly cellIndex: number
  readonly cellType: "code" | "markdown" | "raw"
  readonly outputCount: number
  readonly hasError: boolean
  readonly hasImage: boolean
  readonly totalBytes: number
}

export interface ListOutputsResult {
  readonly displayPath: string
  readonly entries: ReadonlyArray<OutputListEntry>
  readonly total: number
  readonly offset?: number | undefined
  readonly limit?: number | undefined
}

export interface OutputReadRequest {
  readonly cellIndex: number
  readonly includeImages: boolean
  readonly maxOutputChars: number
}

export interface OutputReadResult {
  readonly displayPath: string
  readonly cellIndex: number
  readonly rendered: string
  readonly outputCount: number
}

export interface OutputErrorResult {
  readonly displayPath: string
  readonly cellIndex: number
  readonly hasError: boolean
  readonly rendered: string
}

export interface ClearOutputsResult {
  readonly displayPath: string
  readonly absPath: string
  readonly clearedCells: number
  readonly removedOutputs: number
  readonly removedExecutionCounts: number
}

export interface NotebookOutputServiceShape {
  readonly listOutputs: (
    filePath: string,
    offset?: number | undefined,
    limit?: number | undefined
  ) => Effect.Effect<
    ListOutputsResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | PathOutsideWorktreeError
  >
  readonly readOutputs: (
    filePath: string,
    request: OutputReadRequest
  ) => Effect.Effect<
    OutputReadResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | PathOutsideWorktreeError
  >
  readonly readError: (
    filePath: string,
    cellIndex: number,
    maxOutputChars?: number
  ) => Effect.Effect<
    OutputErrorResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | PathOutsideWorktreeError
  >
  readonly clearCellOutputs: (
    filePath: string,
    cellIndex: number
  ) => Effect.Effect<
    ClearOutputsResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
  readonly clearAllOutputs: (
    filePath: string
  ) => Effect.Effect<
    ClearOutputsResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
}

export type ClearCellOutputsError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | CellIndexOutOfBoundsError
  | NotebookWriteError
  | PathOutsideWorktreeError
  | PermissionDeniedError

export type ClearAllOutputsError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | NotebookWriteError
  | PathOutsideWorktreeError
  | PermissionDeniedError

const baseOpts = (req: Partial<OutputFormatOptions>): OutputFormatOptions => ({
  includeImages: false,
  maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
  maxTracebackChars: 8_000,
  ...req
})

const DEFAULT_OUTPUT_LIST_LIMIT = 50
const MAX_OUTPUT_LIST_LIMIT = 500

const paginate = <T>(
  entries: ReadonlyArray<T>,
  offset: number | undefined,
  limit: number | undefined
): { page: ReadonlyArray<T>; total: number; offset: number; limit: number } => {
  const total = entries.length
  const effectiveOffset = Math.max(0, Math.floor(offset ?? 0))
  const rawLimit = limit ?? DEFAULT_OUTPUT_LIST_LIMIT
  if (rawLimit <= 0) {
    const page =
      effectiveOffset >= total
        ? []
        : entries.slice(effectiveOffset, effectiveOffset + MAX_OUTPUT_LIST_LIMIT)
    return {
      page,
      total,
      offset: effectiveOffset,
      limit: Math.max(0, Math.min(MAX_OUTPUT_LIST_LIMIT, total - effectiveOffset))
    }
  }
  const effectiveLimit = Math.min(Math.max(1, Math.floor(rawLimit)), MAX_OUTPUT_LIST_LIMIT)
  const page = effectiveOffset >= total ? [] : entries.slice(effectiveOffset, effectiveOffset + effectiveLimit)
  return { page, total, offset: effectiveOffset, limit: effectiveLimit }
}

const makeOutputImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
  permSvc: PermissionServiceShape
): NotebookOutputServiceShape => {
  return {
  listOutputs: (filePath, offset, limit) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const notebook = yield* fileSvc.read(abs)
      const entries: OutputListEntry[] = []
      for (let i = 0; i < notebook.cells.length; i++) {
        const cell = notebook.cells[i] as CellRaw
        if (cell.cell_type !== "code") {
          continue
        }
        const code = cell as CodeCellRaw
        let totalBytes = 0
        let hasImage = false
        let hasError = false
        for (const out of code.outputs) {
          if (out["output_type"] === "error") {
            hasError = true
          }
          const data = out["data"] as Record<string, unknown> | undefined
          if (data) {
            for (const [k, v] of Object.entries(data)) {
              if (k.startsWith("image/")) {
                hasImage = true
                if (typeof v === "string") {
                  totalBytes += Math.floor((v.length * 3) / 4)
                }
              } else if (typeof v === "string") {
                totalBytes += Buffer.byteLength(v, "utf8")
              } else {
                totalBytes += Buffer.byteLength(JSON.stringify(v), "utf8")
              }
            }
          }
          const text = out["text"]
          if (typeof text === "string") {
            totalBytes += Buffer.byteLength(text, "utf8")
          } else if (Array.isArray(text)) {
            for (const t of text) {
              if (typeof t === "string") {
                totalBytes += Buffer.byteLength(t, "utf8")
              }
            }
          }
        }
        entries.push({
          cellIndex: i,
          cellType: "code",
          outputCount: code.outputs.length,
          hasError,
          hasImage,
          totalBytes
        })
      }
      const { page, total, offset: effOffset, limit: effLimit } = paginate(entries, offset, limit)
      return {
        displayPath: pathSvc.toDisplay(abs),
        entries: page,
        total,
        offset: effOffset,
        limit: effLimit
      }
    }),
  readOutputs: (filePath, request) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
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
      if (cell.cell_type !== "code") {
        return {
          displayPath: pathSvc.toDisplay(abs),
          cellIndex: idx,
          rendered: "(cell is not a code cell, no outputs)",
          outputCount: 0
        }
      }
      const code = cell as CodeCellRaw
      const rendered = formatOutputs(
        code,
        baseOpts({
          includeImages: request.includeImages,
          maxOutputChars: Math.min(
            request.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
            MAX_READ_RESPONSE_CHARS
          ),
          hardCap:
            (request.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS) >
            MAX_READ_RESPONSE_CHARS
        })
      )
      return {
        displayPath: pathSvc.toDisplay(abs),
        cellIndex: idx,
        rendered,
        outputCount: code.outputs.length
      }
    }),
  readError: (filePath, cellIndex, maxOutputChars) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const notebook = yield* fileSvc.read(abs)
      if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
        return yield* new CellIndexOutOfBoundsError({
          message: `requested cell ${cellIndex} but notebook has ${notebook.cells.length} cells`,
          filePath: abs,
          cellIndex,
          total: notebook.cells.length
        })
      }
      const cell = notebook.cells[cellIndex] as CellRaw
      if (cell.cell_type !== "code") {
        return {
          displayPath: pathSvc.toDisplay(abs),
          cellIndex,
          hasError: false,
          rendered: "(not a code cell)"
        }
      }
      const code = cell as CodeCellRaw
      const errors = code.outputs.filter((o) => o["output_type"] === "error")
      if (errors.length === 0) {
        return {
          displayPath: pathSvc.toDisplay(abs),
          cellIndex,
          hasError: false,
          rendered: "(no error in this cell)"
        }
      }
      const rendered = formatOutputs(
        { ...code, outputs: errors },
        baseOpts({
          maxOutputChars: Math.min(
            maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
            MAX_READ_RESPONSE_CHARS
          ),
          hardCap:
            (maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS) >
            MAX_READ_RESPONSE_CHARS
        })
      )
      return {
        displayPath: pathSvc.toDisplay(abs),
        cellIndex,
        hasError: true,
        rendered
      }
    }),
  clearCellOutputs: (filePath, cellIndex) =>
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
            if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
              return yield* new CellIndexOutOfBoundsError({
                message: `requested cell ${cellIndex} but notebook has ${notebook.cells.length} cells`,
                filePath: abs,
                cellIndex,
                total: notebook.cells.length
              })
            }
            const cell = notebook.cells[cellIndex] as CellRaw
            if (cell.cell_type !== "code") {
              return {
                displayPath: pathSvc.toDisplay(abs),
                absPath: abs,
                clearedCells: 0,
                removedOutputs: 0,
                removedExecutionCounts: 0
              }
            }
            const code = cell as CodeCellRaw
            const removedOutputs = code.outputs.length
            const removedExec = code.execution_count !== null ? 1 : 0
            if (removedOutputs === 0 && removedExec === 0) {
              return {
                displayPath: pathSvc.toDisplay(abs),
                absPath: abs,
                clearedCells: 0,
                removedOutputs: 0,
                removedExecutionCounts: 0
              }
            }
            const lexicalPaths = yield* permSvc.aliases(abs)
            const pinnedPaths = yield* permSvc.aliases(pinned)
            const permissionPaths = [
              ...new Set([...lexicalPaths, ...pinnedPaths])
            ]
            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_outputs_clear_cell",
              patterns: permissionPaths,
              always: permissionPaths,
              metadata: {
                filePath: abs,
                cellIndex,
                removedOutputs,
                removedExecutionCounts: removedExec
              }
            })
            const newCell: CodeCellRaw = { ...code, outputs: [], execution_count: null }
            const cells = notebook.cells.slice()
            cells[cellIndex] = newCell
            const newNotebook = { ...notebook, cells }
            yield* assertRevisionUnchanged(fileSvc, pinned, revision)
            yield* fileSvc.writeAtomic(pinned, newNotebook, {
              noFollowFinal: true,
              format: snapshot.format,
              previousText: snapshot.text
            })
            return {
              displayPath: pathSvc.toDisplay(abs),
              absPath: abs,
              clearedCells: 1,
              removedOutputs,
              removedExecutionCounts: removedExec
            }
          })
        )
    }),
  clearAllOutputs: (filePath) =>
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
            let cleared = 0
            let removedOutputs = 0
            let removedExec = 0
            const cells = notebook.cells.map((cell) => {
              if (cell.cell_type !== "code") {
                return cell
              }
              const code = cell as CodeCellRaw
              if (code.outputs.length === 0 && code.execution_count === null) {
                return cell
              }
              cleared++
              removedOutputs += code.outputs.length
              if (code.execution_count !== null) {
                removedExec++
              }
              return { ...code, outputs: [], execution_count: null }
            })
            if (cleared === 0) {
              return {
                displayPath: pathSvc.toDisplay(abs),
                absPath: abs,
                clearedCells: 0,
                removedOutputs: 0,
                removedExecutionCounts: 0
              }
            }
            const lexicalPaths = yield* permSvc.aliases(abs)
            const pinnedPaths = yield* permSvc.aliases(pinned)
            const permissionPaths = [
              ...new Set([...lexicalPaths, ...pinnedPaths])
            ]
            yield* permSvc.ask({
              kind: "edit",
              action: "ipynb_outputs_clear_all",
              patterns: permissionPaths,
              always: permissionPaths,
              metadata: {
                filePath: abs,
                cleared,
                removedOutputs,
                removedExecutionCounts: removedExec
              }
            })
            const newNotebook = { ...notebook, cells }
            yield* assertRevisionUnchanged(fileSvc, pinned, revision)
            yield* fileSvc.writeAtomic(pinned, newNotebook, {
              noFollowFinal: true,
              format: snapshot.format,
              previousText: snapshot.text
            })
            return {
              displayPath: pathSvc.toDisplay(abs),
              absPath: abs,
              clearedCells: cleared,
              removedOutputs,
              removedExecutionCounts: removedExec
            }
          })
        )
    })
  }
}

export { makeOutputImpl }
