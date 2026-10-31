/**
 * Minimal notebook shape accepted by the virtual-document builder.
 *
 * It is structurally compatible with the plugin's parsed `NotebookRaw`, but
 * keeping it local means the `opencode-ipynb/lsp` entry has no zod/Effect
 * dependency and stays lightweight for third-party LSP plugins.
 */
export interface NotebookLike {
  readonly metadata: {
    readonly language_info?: unknown
    readonly kernelspec?: unknown
  }
  readonly cells: ReadonlyArray<{
    readonly cell_type: string
    readonly source: string | ReadonlyArray<string>
  }>
}

/**
 * A code cell projected into the notebook's virtual document.
 *
 * Line numbers are zero-based, matching LSP positions. `startLine` is the
 * first virtual line for the cell and `endLine` is exclusive.
 */
export interface NotebookCellDocument {
  readonly cellIndex: number
  readonly cellType: "code" | "markdown" | "raw"
  /** LSP language id for this cell (`python`, `markdown`, `plaintext`). */
  readonly languageId: string
  /** Cell source, useful for native LSP 3.17 notebook sync. */
  readonly text: string
  /** Stable cell document URI when the caller provides one. */
  readonly uri?: string
  readonly startLine: number
  readonly endLine: number
  readonly lineCount: number
}

/**
 * A single virtual document containing the notebook's code cells.
 *
 * Language servers do not understand `.ipynb` JSON, so tools can send `text`
 * as a normal document and use `cells` to map positions back to the notebook.
 * This is intentionally provider-agnostic: pyright, jedi-language-server, or a
 * future OpenCode notebook LSP can all consume it.
 */
export interface NotebookVirtualDocument {
  readonly filePath: string
  /** Notebook URI (for clients that model notebook documents explicitly). */
  readonly notebookUri?: string
  readonly languageId: string
  /** Native language file extension from kernel metadata, e.g. `.py`. */
  readonly fileExtension?: string
  /** Jupyter kernelspec name, when present, so an LSP can select the right env. */
  readonly kernelName?: string
  /** Configured Python interpreter, when the plugin has one. */
  readonly pythonPath?: string
  readonly text: string
  readonly cells: ReadonlyArray<NotebookCellDocument>
}

export interface CellPosition {
  readonly cellIndex: number
  readonly line: number
  readonly character: number
}

export interface VirtualPosition {
  readonly line: number
  readonly character: number
}

export interface VirtualDocumentOptions {
  readonly filePath?: string
  /** Include markdown/raw cells in the concatenated text. Defaults to false. */
  readonly includeMarkdown?: boolean
  /** Python interpreter configured for this plugin instance. */
  readonly pythonPath?: string
  /** URI representing the notebook itself. */
  readonly notebookUri?: string
  /** Stable URI for a cell document (native LSP 3.17 notebook sync). */
  readonly cellUri?: (cellIndex: number) => string
}

export interface PositionMapper {
  readonly toCellPosition: (line: number, character: number) => CellPosition | undefined
  readonly toVirtualPosition: (
    cellIndex: number,
    line: number,
    character: number
  ) => VirtualPosition | undefined
}

const languageIdFor = (notebook: NotebookLike): string => {
  const languageInfo = notebook.metadata.language_info as
    | { name?: unknown }
    | undefined
  const kernelspec = notebook.metadata.kernelspec as
    | { language?: unknown }
    | undefined
  const name =
    (typeof languageInfo?.name === "string" && languageInfo.name) ||
    (typeof kernelspec?.language === "string" && kernelspec.language) ||
    "python"
  return normalizeLanguageId(name)
}

const normalizeLanguageId = (name: string): string => {
  const value = name.trim().toLowerCase()
  if (value === "python3" || value === "python 3" || value === "ipython") {
    return "python"
  }
  return value
}

const defaultExtensionFor = (languageId: string): string | undefined => {
  switch (languageId) {
    case "python":
      return ".py"
    case "r":
      return ".r"
    case "julia":
      return ".jl"
    case "javascript":
      return ".js"
    case "typescript":
      return ".ts"
    default:
      return undefined
  }
}

const kernelNameFor = (notebook: NotebookLike): string | undefined => {
  const kernelspec = notebook.metadata.kernelspec as
    | { name?: unknown }
    | undefined
  return typeof kernelspec?.name === "string" && kernelspec.name.length > 0
    ? kernelspec.name
    : undefined
}

const fileExtensionFor = (notebook: NotebookLike): string | undefined => {
  const languageInfo = notebook.metadata.language_info as
    | { file_extension?: unknown }
    | undefined
  if (
    typeof languageInfo?.file_extension === "string" &&
    languageInfo.file_extension.length > 0
  ) {
    return languageInfo.file_extension
  }
  return defaultExtensionFor(languageIdFor(notebook))
}

const normalizeSource = (source: string): string =>
  source.replace(/\r\n?/g, "\n")

const sourceOf = (cell: NotebookLike["cells"][number]): string =>
  normalizeSource(
    typeof cell.source === "string" ? cell.source : cell.source.join("")
  )

const cellType = (cell: NotebookLike["cells"][number]): NotebookCellDocument["cellType"] => {
  switch (cell.cell_type) {
    case "code":
    case "markdown":
    case "raw":
      return cell.cell_type
    default:
      return "code"
  }
}

const languageIdForCell = (
  type: NotebookCellDocument["cellType"],
  notebookLanguage: string
): string => {
  if (type === "markdown") return "markdown"
  if (type === "raw") return "plaintext"
  return notebookLanguage
}

/**
 * Build a virtual document from a parsed notebook.
 *
 * Code cells are separated by a newline, which preserves the cell-local line
 * count and lets `toCellPosition`/`toVirtualPosition` map both directions.
 * Each cell also carries its own text and optional URI so a client that
 * supports LSP 3.17 notebook synchronization can use cell documents directly.
 */
export const buildNotebookVirtualDocument = (
  notebook: NotebookLike,
  options: VirtualDocumentOptions = {}
): NotebookVirtualDocument => {
  const blocks: string[] = []
  const cells: NotebookCellDocument[] = []
  const languageId = languageIdFor(notebook)
  const kernelName = kernelNameFor(notebook)
  const fileExtension = fileExtensionFor(notebook)
  let nextLine = 0

  notebook.cells.forEach((cell, cellIndex) => {
    const type = cellType(cell)
    if (type !== "code" && options.includeMarkdown !== true) return
    const source = sourceOf(cell)
    const lineCount = source.split("\n").length
    const startLine = nextLine
    const uri = options.cellUri?.(cellIndex)
    blocks.push(source)
    cells.push({
      cellIndex,
      cellType: type,
      languageId: languageIdForCell(type, languageId),
      text: source,
      startLine,
      endLine: startLine + lineCount,
      lineCount,
      ...(uri === undefined ? {} : { uri })
    })
    nextLine = startLine + lineCount
  })

  return {
    filePath: options.filePath ?? "",
    ...(options.notebookUri === undefined ? {} : { notebookUri: options.notebookUri }),
    languageId,
    ...(fileExtension === undefined ? {} : { fileExtension }),
    ...(kernelName === undefined ? {} : { kernelName }),
    ...(options.pythonPath === undefined ? {} : { pythonPath: options.pythonPath }),
    text: blocks.join("\n"),
    cells
  }
}

/** Map a zero-based position in the virtual document back to a cell position. */
export const toCellPosition = (
  document: NotebookVirtualDocument,
  line: number,
  character: number
): CellPosition | undefined => {
  const cell = document.cells.find(
    (candidate) => line >= candidate.startLine && line < candidate.endLine
  )
  if (!cell) return undefined
  return {
    cellIndex: cell.cellIndex,
    line: line - cell.startLine,
    character
  }
}

/** Map a zero-based position inside a cell to the virtual document. */
export const toVirtualPosition = (
  document: NotebookVirtualDocument,
  cellIndex: number,
  line: number,
  character: number
): VirtualPosition | undefined => {
  const cell = document.cells.find((candidate) => candidate.cellIndex === cellIndex)
  if (!cell || line < 0 || line >= cell.lineCount) return undefined
  return { line: cell.startLine + line, character }
}

/** Convenience mapper bound to a built document. */
export const makePositionMapper = (
  document: NotebookVirtualDocument
): PositionMapper => ({
  toCellPosition: (line, character) => toCellPosition(document, line, character),
  toVirtualPosition: (cellIndex, line, character) =>
    toVirtualPosition(document, cellIndex, line, character)
})
