import { truncate, truncatePreview } from "../utils/truncate.js"
import { humanBytes, isImageMime, estimateBase64Bytes } from "../utils/mime.js"
import { stripAnsi } from "../utils/ansi.js"
import { formatAttachment } from "../utils/attachments.js"
import { detectOutputKind } from "../domain/output.js"
import type { CellRaw } from "../domain/cell.js"
import type { NotebookRaw } from "../domain/notebook.js"
import { cellSource } from "../domain/notebook.js"
import { analyzeExecutionOrder } from "../services/NotebookInspectService.js"
import type { ToolAttachment } from "@opencode-ai/plugin"

export interface OutputFormatOptions {
  readonly includeImages: boolean
  readonly saveImages?: boolean | undefined
  readonly maxOutputChars: number
  readonly maxTracebackChars: number
  readonly includeFullTraceback?: boolean | undefined
}

const defaultOpts = (override: Partial<OutputFormatOptions> = {}): OutputFormatOptions => ({
  includeImages: false,
  maxOutputChars: 6_000,
  maxTracebackChars: 8_000,
  ...override
})

export interface FormattedOutput {
  readonly rendered: string
  readonly attachments: ReadonlyArray<ToolAttachment>
}

const imageNotice = (mime: string, value: string): string => {
  const bytes = estimateBase64Bytes(value)
  return `${mime}, ${humanBytes(bytes)}, omitted by default`
}

const formatStream = (text: string, max: number): string => {
  const t = truncate(text, max, { key: "stream", paramName: "maxOutputChars" })
  return `\`\`\`\n${t.text}\n\`\`\``
}

const outputTextToString = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join("") : String(value ?? "")

const shouldSaveImage = (optsInput: Partial<OutputFormatOptions>): boolean => {
  if (optsInput.includeImages === true) {
    return true
  }
  if (optsInput.includeImages === undefined && optsInput.saveImages === true) {
    return true
  }
  return false
}

const formatDisplay = (
  data: Record<string, unknown>,
  opts: OutputFormatOptions
): string => {
  const lines: string[] = []
  for (const [mime, value] of Object.entries(data)) {
    if (isImageMime(mime)) {
      if (typeof value === "string") {
        if (opts.includeImages) {
          lines.push(`- ${mime}: (base64 omitted in v0.1; image attachment not yet supported)`)
        } else {
          lines.push(`- ${imageNotice(mime, value)}`)
        }
      } else {
        lines.push(`- ${mime}: (unsupported value type)`)
      }
    } else if (typeof value === "string") {
      const t = truncate(value, opts.maxOutputChars, { key: "output", paramName: "maxOutputChars" })
      lines.push(`- ${mime}:`)
      lines.push(`\`\`\``)
      lines.push(t.text)
      lines.push(`\`\`\``)
    } else {
      const t = truncate(JSON.stringify(value, null, 2), opts.maxOutputChars, { key: "json", paramName: "maxOutputChars" })
      lines.push(`- ${mime}: \`\`\`json\n${t.text}\n\`\`\``)
    }
  }
  return lines.join("\n")
}

interface DisplayCollector {
  attachments: ToolAttachment[]
}

const formatDisplayWithAttachments = async (
  data: Record<string, unknown>,
  opts: OutputFormatOptions,
  optsInput: Partial<OutputFormatOptions>,
  collector: DisplayCollector
): Promise<string> => {
  const lines: string[] = []
  for (const [mime, value] of Object.entries(data)) {
    if (isImageMime(mime)) {
      if (typeof value === "string") {
        if (shouldSaveImage(optsInput)) {
          const att = formatAttachment(mime, value)
          collector.attachments.push(att)
          lines.push(`- ${mime}: (attached as image, ${humanBytes(Buffer.byteLength(value, "base64"))})`)
        } else {
          lines.push(`- ${imageNotice(mime, value)}`)
        }
      } else {
        lines.push(`- ${mime}: (unsupported value type)`)
      }
    } else if (typeof value === "string") {
      const t = truncate(value, opts.maxOutputChars, { key: "output", paramName: "maxOutputChars" })
      lines.push(`- ${mime}:`)
      lines.push(`\`\`\``)
      lines.push(t.text)
      lines.push(`\`\`\``)
    } else {
      const t = truncate(JSON.stringify(value, null, 2), opts.maxOutputChars, { key: "json", paramName: "maxOutputChars" })
      lines.push(`- ${mime}: \`\`\`json\n${t.text}\n\`\`\``)
    }
  }
  return lines.join("\n")
}

const formatError = (
  ename: string,
  evalue: string,
  traceback: ReadonlyArray<string>,
  maxChars: number,
  includeFullTraceback?: boolean
): string => {
  const cleaned = traceback.map(stripAnsi).join("\n").trim()
  const lines: string[] = [`**${ename}**: ${evalue}`]
  if (cleaned.length === 0) {
    return lines.join("\n")
  }
  if (includeFullTraceback) {
    lines.push("")
    lines.push("```")
    lines.push(cleaned)
    lines.push("```")
  } else {
    const t = truncate(cleaned, maxChars, { key: "traceback", paramName: "maxTracebackChars" })
    lines.push("")
    lines.push("```")
    lines.push(t.text)
    lines.push("```")
  }
  return lines.join("\n")
}

export const formatOutputs = (
  cell: CellRaw,
  optsInput: Partial<OutputFormatOptions> = {}
): string => {
  const opts = defaultOpts(optsInput)
  if (cell.cell_type !== "code") {
    return ""
  }
  const sections: string[] = []
  let stdout = ""
  let stderr = ""
  const displaySections: string[] = []
  const resultSections: string[] = []
  const errorSections: string[] = []

  for (const out of cell.outputs) {
    const kind = detectOutputKind(out)
    if (kind === "stream") {
      const name = String(out["name"] ?? "")
      const text = outputTextToString(out["text"])
      if (name === "stderr") {
        stderr += text
      } else {
        stdout += text
      }
    } else if (kind === "display_data") {
      const data = (out["data"] as Record<string, unknown> | undefined) ?? {}
      displaySections.push(formatDisplay(data, opts))
    } else if (kind === "execute_result") {
      const data = (out["data"] as Record<string, unknown> | undefined) ?? {}
      resultSections.push(formatDisplay(data, opts))
    } else if (kind === "error") {
      const ename = String(out["ename"] ?? "Error")
      const evalue = String(out["evalue"] ?? "")
      const traceback = Array.isArray(out["traceback"])
        ? (out["traceback"] as ReadonlyArray<string>)
        : []
      errorSections.push(formatError(ename, evalue, traceback, opts.maxTracebackChars, opts.includeFullTraceback))
    }
  }

  if (stdout) {
    sections.push(`- **stdout**:\n${formatStream(stdout, opts.maxOutputChars)}`)
  }
  if (stderr) {
    sections.push(`- **stderr**:\n${formatStream(stderr, opts.maxOutputChars)}`)
  }
  for (const d of displaySections) {
    sections.push(`- **display_data**:\n${d}`)
  }
  for (const r of resultSections) {
    sections.push(`- **execute_result**:\n${r}`)
  }
  for (const e of errorSections) {
    sections.push(`- **error**:\n${e}`)
  }

  if (sections.length === 0) {
    return "(no output)"
  }
  return sections.join("\n\n")
}

export const formatOutputsDetailed = async (
  cell: CellRaw,
  optsInput: Partial<OutputFormatOptions> = {}
): Promise<FormattedOutput> => {
  const opts = defaultOpts(optsInput)
  if (cell.cell_type !== "code") {
    return { rendered: "", attachments: [] }
  }
  const sections: string[] = []
  let stdout = ""
  let stderr = ""
  const displaySections: string[] = []
  const resultSections: string[] = []
  const errorSections: string[] = []
  const collector: DisplayCollector = { attachments: [] }

  for (const out of cell.outputs) {
    const kind = detectOutputKind(out)
    if (kind === "stream") {
      const name = String(out["name"] ?? "")
      const text = outputTextToString(out["text"])
      if (name === "stderr") {
        stderr += text
      } else {
        stdout += text
      }
    } else if (kind === "display_data") {
      const data = (out["data"] as Record<string, unknown> | undefined) ?? {}
      displaySections.push(await formatDisplayWithAttachments(data, opts, optsInput, collector))
    } else if (kind === "execute_result") {
      const data = (out["data"] as Record<string, unknown> | undefined) ?? {}
      resultSections.push(await formatDisplayWithAttachments(data, opts, optsInput, collector))
    } else if (kind === "error") {
      const ename = String(out["ename"] ?? "Error")
      const evalue = String(out["evalue"] ?? "")
      const traceback = Array.isArray(out["traceback"])
        ? (out["traceback"] as ReadonlyArray<string>)
        : []
      errorSections.push(formatError(ename, evalue, traceback, opts.maxTracebackChars, opts.includeFullTraceback))
    }
  }

  if (stdout) {
    sections.push(`- **stdout**:\n${formatStream(stdout, opts.maxOutputChars)}`)
  }
  if (stderr) {
    sections.push(`- **stderr**:\n${formatStream(stderr, opts.maxOutputChars)}`)
  }
  for (const d of displaySections) {
    sections.push(`- **display_data**:\n${d}`)
  }
  for (const r of resultSections) {
    sections.push(`- **execute_result**:\n${r}`)
  }
  for (const e of errorSections) {
    sections.push(`- **error**:\n${e}`)
  }

  if (sections.length === 0) {
    return { rendered: "(no output)", attachments: collector.attachments }
  }
  return {
    rendered: sections.join("\n\n"),
    attachments: collector.attachments
  }
}

export const formatNotebookDiagnostics = (notebook: NotebookRaw, filePath: string): string => {
  const lines: string[] = []
  lines.push(`Notebook: \`${filePath}\``)
  lines.push(`nbformat: ${notebook.nbformat}${notebook.nbformat_minor !== undefined ? `.${notebook.nbformat_minor}` : ""}`)
  const ks = notebook.metadata.kernelspec
  if (ks) {
    lines.push(`kernel: ${ks.display_name ?? ks.name ?? "?"}`)
  }
  const li = notebook.metadata.language_info
  if (li) {
    lines.push(`language: ${li.name}`)
  }
  const codeCells = notebook.cells.filter((c) => c.cell_type === "code")
  const mdCells = notebook.cells.filter((c) => c.cell_type === "markdown")
  const rawCells = notebook.cells.filter((c) => c.cell_type === "raw")
  const withOutputs = codeCells.filter((c) => c.outputs.length > 0).length
  const withErrors = codeCells.filter((c) => c.outputs.some((o) => o["output_type"] === "error")).length
  const missingExec = codeCells.filter((c) => c.execution_count === null).length
  const outOfOrder = analyzeExecutionOrder(notebook).length > 0 ? "yes" : "no"

  lines.push(`total cells: ${notebook.cells.length}`)
  lines.push(`code cells: ${codeCells.length}`)
  lines.push(`markdown cells: ${mdCells.length}`)
  lines.push(`raw cells: ${rawCells.length}`)
  lines.push(`cells with outputs: ${withOutputs}`)
  lines.push(`cells with errors: ${withErrors}`)
  lines.push(`execution counts missing: ${missingExec}`)
  lines.push(`execution counts out of order: ${outOfOrder}`)

  return lines.join("\n")
}

export const formatSourcePreview = (source: string, max: number): string => truncatePreview(source, max)
