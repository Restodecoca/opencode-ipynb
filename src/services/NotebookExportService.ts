import { Context, Effect } from "effect"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
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
import { cellSource, type NotebookRaw } from "../domain/notebook.js"
import { formatNotebookAsMarkdown, formatNotebookAsPython } from "../format/diff.js"
import { truncate } from "../utils/truncate.js"
import { DEFAULT_MAX_EXPORT_CHARS } from "../utils/limits.js"
import { formatOutputs } from "../format/outputs.js"
import { detectOutputKind } from "../domain/output.js"
import type { CodeCellRaw } from "../domain/cell.js"

export type ExportFormat = "markdown" | "python" | "summary"

export interface ExportOptions {
  readonly format: ExportFormat
  readonly includeOutputs: boolean
  readonly includeErrors: boolean
  readonly outputPath: string | undefined
  readonly maxExportChars: number
}

export interface ExportResult {
  readonly displayPath: string
  readonly absPath: string
  readonly format: ExportFormat
  readonly writtenTo: string | undefined
  readonly rendered: string
  readonly cellCount: number
  readonly frontMatter?: string | undefined
}

export interface NotebookExportServiceShape {
  readonly export: (
    filePath: string,
    options: ExportOptions
  ) => Effect.Effect<
    ExportResult,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | NotebookWriteError
    | PathOutsideWorktreeError
    | PermissionDeniedError
  >
}

export class NotebookExportService extends Context.Tag("@ipynb/NotebookExportService")<
  NotebookExportService,
  NotebookExportServiceShape
>() {}

const yamlScalar = (s: string): string =>
  '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'

const buildFrontMatter = (params: {
  readonly displayPath: string
  readonly notebook: NotebookRaw
}): string => {
  const meta = params.notebook.metadata
  const kernelSpec = meta.kernelspec
  const kernel = kernelSpec?.display_name ?? kernelSpec?.name ?? "unknown"
  const language = meta.language_info?.name ?? "unknown"
  const allCells = params.notebook.cells
  const codeCells = allCells.filter((c) => c.cell_type === "code").length
  const markdownCells = allCells.filter((c) => c.cell_type === "markdown").length
  const rawCells = allCells.filter((c) => c.cell_type === "raw").length
  const lines = [
    "---",
    `source: ${yamlScalar(params.displayPath)}`,
    `kernel: ${yamlScalar(kernel)}`,
    `language: ${yamlScalar(language)}`,
    `cells: ${allCells.length}`,
    `code_cells: ${codeCells}`,
    `markdown_cells: ${markdownCells}`,
    `raw_cells: ${rawCells}`,
    "---"
  ]
  return lines.join("\n")
}

type SummaryCell = {
  readonly index: number
  readonly cell_type: "code" | "markdown" | "raw"
  readonly source: string
  readonly execution_count: number | null
  readonly output_count: number
}

const truncateFirstLine = (source: string, max = 120): string => {
  const first = source.split("\n")[0] ?? ""
  if (first.length <= max) return first
  return first.slice(0, max) + "..."
}

const buildSummary = (notebook: NotebookRaw): string => {
  const cells: SummaryCell[] = notebook.cells.map((cell, index) => {
    if (cell.cell_type === "code") {
      return {
        index,
        cell_type: "code",
        source: cellSource(cell),
        execution_count: cell.execution_count,
        output_count: cell.outputs.length
      }
    }
    return {
      index,
      cell_type: cell.cell_type,
      source: cellSource(cell),
      execution_count: null,
      output_count: 0
    }
  })

  const code = cells.filter((c) => c.cell_type === "code")
  const md = cells.filter((c) => c.cell_type === "markdown")
  const raw = cells.filter((c) => c.cell_type === "raw")

  const sortByIndex = (arr: SummaryCell[]): SummaryCell[] =>
    [...arr].sort((a, b) => a.index - b.index)

  const lines: string[] = []
  lines.push("# Notebook Summary")
  lines.push("")
  lines.push("## Counts")
  lines.push(`- total: ${cells.length}`)
  lines.push(`- code: ${code.length}`)
  lines.push(`- markdown: ${md.length}`)
  lines.push(`- raw: ${raw.length}`)
  lines.push("")

  if (code.length > 0) {
    lines.push("## Code cells")
    for (const c of sortByIndex(code)) {
      const first = truncateFirstLine(c.source)
      const exec = c.execution_count === null ? "null" : String(c.execution_count)
      lines.push(`- [${c.index}] | ${first} | exec=${exec} | outputs=${c.output_count}`)
    }
    lines.push("")
  }

  if (md.length > 0) {
    lines.push("## Markdown cells")
    for (const c of sortByIndex(md)) {
      const first = truncateFirstLine(c.source)
      lines.push(`- [${c.index}] | ${first}`)
    }
    lines.push("")
  }

  if (raw.length > 0) {
    lines.push("## Raw cells")
    for (const c of sortByIndex(raw)) {
      const first = truncateFirstLine(c.source)
      lines.push(`- [${c.index}] | ${first}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

const makeExportImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
  permSvc: PermissionServiceShape
): NotebookExportServiceShape => ({
  export: (filePath, options) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const notebook = yield* fileSvc.read(abs)
      const displayPath = pathSvc.toDisplay(abs)

      const cells = notebook.cells.map((cell) => ({
        cell_type: cell.cell_type,
        source: cellSource(cell)
      }))

      let rendered = ""
      let frontMatter: string | undefined
      if (options.format === "markdown") {
        const renderCellOutputs = options.includeOutputs || options.includeErrors
          ? (idx: number): string | undefined => {
              const c = notebook.cells[idx] as { cell_type: string; outputs?: unknown } | undefined
              if (!c || c.cell_type !== "code") return undefined
              const code = c as unknown as CodeCellRaw
              const outputs = options.includeOutputs
                ? options.includeErrors
                  ? code.outputs
                  : code.outputs.filter((out) => detectOutputKind(out) !== "error")
                : code.outputs.filter((out) => detectOutputKind(out) === "error")
              const section = formatOutputs({ ...code, outputs }, {
                includeImages: false,
                maxOutputChars: 2_000,
                maxTracebackChars: 4_000
              })
              if (!section || section === "(no output)") return undefined
              return section
            }
          : undefined
        rendered = formatNotebookAsMarkdown({
          cells,
          includeOutputs: options.includeOutputs,
          wrapOutputsInDetails: options.includeOutputs === true || options.includeErrors === true,
          renderCellOutputs
        })
        if (!options.includeOutputs) {
          frontMatter = buildFrontMatter({ displayPath, notebook })
          rendered = `${frontMatter}\n\n${rendered}`
        }
      } else if (options.format === "python") {
        rendered = formatNotebookAsPython({ cells })
      } else {
        rendered = buildSummary(notebook)
      }

      const truncated = truncate(rendered, options.maxExportChars, "truncated export")
      const finalRendered = truncated.text

      let writtenTo: string | undefined
      if (options.outputPath) {
        const outAbs = yield* pathSvc.resolve(options.outputPath)
        yield* pathSvc.ensureInsideWorktree(outAbs)
        yield* permSvc.ask({
          kind: "edit",
          action: "ipynb_export_write",
          patterns: [outAbs],
          always: [outAbs],
          metadata: {
            sourceFile: abs,
            outputPath: outAbs,
            format: options.format,
            cellCount: cells.length,
            length: finalRendered.length
          }
        })
        yield* Effect.tryPromise({
          try: async () => {
            await fsp.mkdir(path.dirname(outAbs), { recursive: true })
            await fsp.writeFile(outAbs, finalRendered, "utf8")
          },
          catch: (err) =>
            new NotebookWriteError({
              message: err instanceof Error ? err.message : String(err),
              filePath: outAbs
            })
        })
        writtenTo = pathSvc.toDisplay(outAbs)
      }

      const baseResult = {
        displayPath,
        absPath: abs,
        format: options.format,
        writtenTo,
        rendered: finalRendered,
        cellCount: cells.length
      }
      if (frontMatter !== undefined) {
        return { ...baseResult, frontMatter }
      }
      return baseResult
    })
})

export { makeExportImpl }
export { DEFAULT_MAX_EXPORT_CHARS }
