import { Context, Effect } from "effect"
import {
  CellIndexOutOfBoundsError,
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import { NotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { PathService, type PathServiceShape } from "./PathService.js"
import { formatCellMarkdownDetailed, type MarkdownReadOptions } from "../format/markdown.js"
import type { CellRaw } from "../domain/cell.js"
import { cellSource } from "../domain/notebook.js"
import { DEFAULT_MAX_SOURCE_CHARS, DEFAULT_MAX_OUTPUT_CHARS } from "../utils/limits.js"
import type { ToolAttachment } from "@opencode-ai/plugin"

export interface ReadRangeRequest {
  readonly cellIndex?: number | undefined
  readonly start?: number | undefined
  readonly end?: number | undefined
  readonly includeOutputs?: boolean | undefined
  readonly includeErrors?: boolean | undefined
  readonly includeMetadata?: boolean | undefined
  readonly includeImages?: boolean | undefined
  readonly saveImages?: boolean | undefined
  readonly maxSourceChars?: number | undefined
  readonly maxOutputChars?: number | undefined
}

export interface ReadRangeResult {
  readonly displayPath: string
  readonly absPath: string
  readonly totalCells: number
  readonly rendered: string
  readonly indexes: ReadonlyArray<number>
  readonly attachments: ReadonlyArray<ToolAttachment>
}

export interface NotebookReadServiceShape {
  readonly readCell: (
    filePath: string,
    cellIndex: number,
    options?: Partial<ReadRangeRequest>
  ) => Effect.Effect<
    ReadRangeResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | PathOutsideWorktreeError
  >
  readonly readRange: (
    filePath: string,
    start: number,
    end: number,
    options?: Partial<ReadRangeRequest>
  ) => Effect.Effect<
    ReadRangeResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | PathOutsideWorktreeError
  >
}

export class NotebookReadService extends Context.Tag("@ipynb/NotebookReadService")<
  NotebookReadService,
  NotebookReadServiceShape
>() {}

const buildOptions = (req: Partial<ReadRangeRequest>): MarkdownReadOptions => ({
  includeOutputs: req.includeOutputs ?? false,
  includeErrors: req.includeErrors ?? true,
  includeMetadata: req.includeMetadata ?? false,
  maxSourceChars: req.maxSourceChars ?? DEFAULT_MAX_SOURCE_CHARS,
  saveImages: req.saveImages,
  output: {
    includeImages: req.includeImages ?? false,
    saveImages: req.saveImages,
    maxOutputChars: req.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  }
})

export const makeReadImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape
): NotebookReadServiceShape => {
  const readCells = (
    filePath: string,
    indexes: ReadonlyArray<number>,
    options?: Partial<ReadRangeRequest>
  ): Effect.Effect<
    ReadRangeResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | CellIndexOutOfBoundsError
    | PathOutsideWorktreeError
  > =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const notebook = yield* fileSvc.read(abs)
      const opts = buildOptions(options ?? {})
      const blocks: string[] = []
      const allAttachments: ToolAttachment[] = []
      for (const idx of indexes) {
        if (idx < 0 || idx >= notebook.cells.length) {
          return yield* new CellIndexOutOfBoundsError({
            message: `requested cell ${idx} but notebook has ${notebook.cells.length} cells`,
            filePath: abs,
            cellIndex: idx,
            total: notebook.cells.length
          })
        }
        const cell = notebook.cells[idx] as CellRaw
        const formatted = yield* Effect.promise(() => formatCellMarkdownDetailed(cell, idx, opts))
        blocks.push(formatted.rendered)
        for (const att of formatted.attachments) {
          allAttachments.push(att)
        }
      }
      const displayPath = pathSvc.toDisplay(abs)
      return {
        displayPath,
        absPath: abs,
        totalCells: notebook.cells.length,
        rendered: blocks.join("\n\n"),
        indexes,
        attachments: allAttachments
      }
    })

  return {
    readCell: (filePath, cellIndex, options) =>
      readCells(filePath, [cellIndex], options),
    readRange: (filePath, start, end, options) => {
      const lo = Math.max(0, Math.min(start, end))
      const hi = Math.max(start, end)
      const indexes: number[] = []
      for (let i = lo; i <= hi; i++) {
        indexes.push(i)
      }
      return readCells(filePath, indexes, options)
    }
  }
}

export { cellSource }
