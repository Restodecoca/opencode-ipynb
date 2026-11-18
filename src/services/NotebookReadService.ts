import { Effect } from "effect"
import {
  CellIndexOutOfBoundsError,
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import type { NotebookFileServiceShape } from "./NotebookFileService.js"
import type { PathServiceShape } from "./PathService.js"
import { formatCellMarkdownDetailed, type MarkdownReadOptions } from "../format/markdown.js"
import type { CellRaw } from "../domain/cell.js"
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_SOURCE_CHARS,
  MAX_ATTACHMENT_BYTES,
  MAX_READ_CELLS,
  MAX_READ_RESPONSE_CHARS
} from "../utils/limits.js"
import { truncateMarkdown } from "../utils/markdown-safe.js"
import type { ToolAttachment } from "../tool.js"

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
  const loadNotebook = (filePath: string) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const notebook = yield* fileSvc.read(abs)
      return { abs, notebook }
    })

  const formatCells = (
    abs: string,
    notebook: { readonly cells: ReadonlyArray<unknown> },
    indexes: ReadonlyArray<number>,
    options?: Partial<ReadRangeRequest>
  ): Effect.Effect<
    ReadRangeResult,
    CellIndexOutOfBoundsError | NotebookParseError
  > =>
    Effect.gen(function* () {
      const opts = buildOptions(options ?? {})
      const blocks: string[] = []
      const allAttachments: ToolAttachment[] = []
      let attachmentBytes = 0
      let droppedAttachments = false
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
        const formatted = yield* Effect.tryPromise({
          try: () => formatCellMarkdownDetailed(cell, idx, opts),
          catch: (err) =>
            new NotebookParseError({
              message: `failed to format cell ${idx}: ${err instanceof Error ? err.message : String(err)}`,
              filePath: abs
            })
        })
        blocks.push(formatted.rendered)
        for (const att of formatted.attachments) {
          const bytes = Math.ceil(att.url.length * 0.75)
          if (attachmentBytes + bytes > MAX_ATTACHMENT_BYTES) {
            droppedAttachments = true
            break
          }
          attachmentBytes += bytes
          allAttachments.push(att)
        }
      }
      const displayPath = pathSvc.toDisplay(abs)
      const renderedBase = blocks.join("\n\n")
      const rendered = droppedAttachments
        ? `${renderedBase}\n\n(Some images were omitted: the ${MAX_ATTACHMENT_BYTES} byte attachment budget was exceeded.)`
        : renderedBase
      return {
        displayPath,
        absPath: abs,
        totalCells: notebook.cells.length,
        rendered: truncateMarkdown(
          rendered,
          MAX_READ_RESPONSE_CHARS,
          "\n... (truncated: hard response limit reached)"
        ),
        indexes,
        attachments: allAttachments
      }
    })

  return {
    readCell: (filePath, cellIndex, options) =>
      Effect.gen(function* () {
        const { abs, notebook } = yield* loadNotebook(filePath)
        return yield* formatCells(abs, notebook, [cellIndex], options)
      }),
    readRange: (filePath, start, end, options) =>
      Effect.gen(function* () {
        const { abs, notebook } = yield* loadNotebook(filePath)
        const lo = Math.max(0, Math.min(start, end))
        if (lo >= notebook.cells.length) {
          return yield* new CellIndexOutOfBoundsError({
            message: `requested range starts at ${lo} but notebook has ${notebook.cells.length} cells`,
            filePath: abs,
            cellIndex: lo,
            total: notebook.cells.length
          })
        }
        const hi = Math.min(
          Math.max(start, end),
          Math.max(0, notebook.cells.length - 1)
        )
        if (hi - lo + 1 > MAX_READ_CELLS) {
          return yield* new NotebookValidationError({
            message: `requested ${hi - lo + 1} cells; the maximum per read is ${MAX_READ_CELLS}`,
            filePath: abs,
            issues: [`read a smaller range or use ipynb_inspect`]
          })
        }
        const indexes: number[] = []
        for (let i = lo; i <= hi; i++) {
          indexes.push(i)
        }
        return yield* formatCells(abs, notebook, indexes, options)
      })
  }
}
