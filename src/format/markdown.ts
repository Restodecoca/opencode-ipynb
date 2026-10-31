import { truncate } from "../utils/truncate.js"
import { cellSource } from "../domain/notebook.js"
import type { CellRaw, CodeCellRaw, MarkdownCellRaw, RawCellRaw } from "../domain/cell.js"
import { formatOutputs, formatOutputsDetailed, type FormattedOutput, type OutputFormatOptions } from "./outputs.js"
import type { ToolAttachment } from "../tool.js"
import { formatAttachment } from "../utils/attachments.js"
import { isAttachableImageMime } from "../utils/mime.js"
import { codeFence } from "../utils/fence.js"
import { sanitizeTerminal } from "../utils/ansi.js"
import { truncateMarkdown } from "../utils/markdown-safe.js"

export interface MarkdownReadOptions {
  readonly includeOutputs: boolean
  readonly includeErrors: boolean
  readonly includeMetadata: boolean
  readonly maxSourceChars: number
  readonly includeFullTraceback?: boolean | undefined
  readonly saveImages?: boolean | undefined
  readonly output: Partial<OutputFormatOptions>
}

export interface FormattedCell {
  readonly rendered: string
  readonly attachments: ReadonlyArray<ToolAttachment>
}

const defaultReadOpts = (override: Partial<MarkdownReadOptions> = {}): MarkdownReadOptions => {
  const merged: MarkdownReadOptions = {
    includeOutputs: false,
    includeErrors: true,
    includeMetadata: false,
    maxSourceChars: 12_000,
    includeFullTraceback: undefined,
    saveImages: undefined,
    output: {},
    ...override
  }
  const outputOverrides: { -readonly [K in keyof OutputFormatOptions]?: OutputFormatOptions[K] } = {
    ...merged.output
  }
  if (merged.saveImages !== undefined) {
    outputOverrides.saveImages = merged.saveImages
  }
  if (merged.includeFullTraceback !== undefined) {
    outputOverrides.includeFullTraceback = merged.includeFullTraceback
  }
  if (Object.keys(outputOverrides).length === 0) {
    return merged
  }
  return {
    ...merged,
    output: outputOverrides
  }
}

interface CellCollector {
  attachments: ToolAttachment[]
}

const formatCodeCell = (cell: CodeCellRaw, index: number, opts: MarkdownReadOptions): string => {
  const lines: string[] = []
  lines.push(`### Cell [${index}]`)
  lines.push(`Type: code`)
  lines.push(`Execution: ${cell.execution_count ?? "not run"}`)
  if (opts.includeMetadata && Object.keys(cell.metadata).length > 0) {
    const metadata = truncate(JSON.stringify(cell.metadata, null, 2), opts.maxSourceChars, {
      key: "json",
      paramName: "maxSourceChars"
    })
    const fence = codeFence(metadata.text)
    lines.push("Metadata:")
    lines.push(`${fence}json`)
    lines.push(metadata.text)
    lines.push(fence)
  }
  const source = cellSource(cell)
  const t = truncate(sanitizeTerminal(source), opts.maxSourceChars, {
    key: "source",
    paramName: "maxSourceChars"
  })
  lines.push("")
  lines.push("Source:")
  const fence = codeFence(t.text)
  lines.push(`${fence}python`)
  lines.push(t.text)
  lines.push(fence)
  if (opts.includeOutputs) {
    const outputs = opts.includeErrors
      ? cell.outputs
      : cell.outputs.filter((output) => output["output_type"] !== "error")
    const formatted = formatOutputs({ ...cell, outputs }, opts.output)
    if (formatted && formatted !== "(no output)") {
      lines.push("")
      lines.push("Outputs:")
      lines.push("")
      lines.push(formatted)
    }
  } else if (opts.includeErrors) {
    const errOutputs = cell.outputs.filter((o) => o["output_type"] === "error")
    if (errOutputs.length > 0) {
      lines.push("")
      lines.push("Errors:")
      lines.push("")
      lines.push(formatOutputs({ ...cell, outputs: errOutputs }, { ...opts.output, maxOutputChars: opts.output.maxOutputChars ?? 6_000 }))
    }
  }
  return lines.join("\n")
}

const formatCodeCellDetailed = async (
  cell: CodeCellRaw,
  index: number,
  opts: MarkdownReadOptions,
  collector: CellCollector
): Promise<string> => {
  const lines: string[] = []
  lines.push(`### Cell [${index}]`)
  lines.push(`Type: code`)
  lines.push(`Execution: ${cell.execution_count ?? "not run"}`)
  if (opts.includeMetadata && Object.keys(cell.metadata).length > 0) {
    const metadata = truncate(JSON.stringify(cell.metadata, null, 2), opts.maxSourceChars, {
      key: "json",
      paramName: "maxSourceChars"
    })
    const fence = codeFence(metadata.text)
    lines.push("Metadata:")
    lines.push(`${fence}json`)
    lines.push(metadata.text)
    lines.push(fence)
  }
  const source = cellSource(cell)
  const t = truncate(sanitizeTerminal(source), opts.maxSourceChars, {
    key: "source",
    paramName: "maxSourceChars"
  })
  lines.push("")
  lines.push("Source:")
  const fence = codeFence(t.text)
  lines.push(`${fence}python`)
  lines.push(t.text)
  lines.push(fence)
  if (opts.includeOutputs) {
    const outputs = opts.includeErrors
      ? cell.outputs
      : cell.outputs.filter((output) => output["output_type"] !== "error")
    const formatted: FormattedOutput = await formatOutputsDetailed(
      { ...cell, outputs },
      opts.output
    )
    if (formatted.rendered && formatted.rendered !== "(no output)") {
      lines.push("")
      lines.push("Outputs:")
      lines.push("")
      lines.push(formatted.rendered)
    }
    collector.attachments.push(...formatted.attachments)
  } else if (opts.includeErrors) {
    const errOutputs = cell.outputs.filter((o) => o["output_type"] === "error")
    if (errOutputs.length > 0) {
      const formatted: FormattedOutput = await formatOutputsDetailed(
        { ...cell, outputs: errOutputs },
        { ...opts.output, maxOutputChars: opts.output.maxOutputChars ?? 6_000 }
      )
      lines.push("")
      lines.push("Errors:")
      lines.push("")
      lines.push(formatted.rendered)
      collector.attachments.push(...formatted.attachments)
    }
  }
  return lines.join("\n")
}

const formatMarkdownCell = (cell: MarkdownCellRaw, index: number, opts: MarkdownReadOptions): string => {
  const lines: string[] = []
  lines.push(`### Cell [${index}]`)
  lines.push(`Type: markdown`)
  if (opts.includeMetadata && Object.keys(cell.metadata).length > 0) {
    const metadata = truncate(JSON.stringify(cell.metadata, null, 2), opts.maxSourceChars, {
      key: "json",
      paramName: "maxSourceChars"
    })
    const fence = codeFence(metadata.text)
    lines.push("Metadata:")
    lines.push(`${fence}json`)
    lines.push(metadata.text)
    lines.push(fence)
  }
  const source = cellSource(cell)
  const text = truncateMarkdown(
    sanitizeTerminal(source),
    opts.maxSourceChars,
    "\n... (source truncated, use maxSourceChars to increase)"
  )
  lines.push("")
  lines.push(text)
  return lines.join("\n")
}

const formatRawCell = (cell: RawCellRaw, index: number, opts: MarkdownReadOptions): string => {
  const lines: string[] = []
  lines.push(`### Cell [${index}]`)
  lines.push(`Type: raw`)
  if (opts.includeMetadata && Object.keys(cell.metadata).length > 0) {
    const metadata = truncate(JSON.stringify(cell.metadata, null, 2), opts.maxSourceChars, {
      key: "json",
      paramName: "maxSourceChars"
    })
    const fence = codeFence(metadata.text)
    lines.push("Metadata:")
    lines.push(`${fence}json`)
    lines.push(metadata.text)
    lines.push(fence)
  }
  const source = cellSource(cell)
  const text = truncateMarkdown(
    sanitizeTerminal(source),
    opts.maxSourceChars,
    "\n... (source truncated, use maxSourceChars to increase)"
  )
  lines.push("")
  const fence = codeFence(text)
  lines.push(fence)
  lines.push(text)
  lines.push(fence)
  return lines.join("\n")
}

export const formatCellMarkdown = (
  cell: CellRaw,
  index: number,
  optsInput: Partial<MarkdownReadOptions> = {}
): string => {
  const opts = defaultReadOpts(optsInput)
  if (cell.cell_type === "code") {
    return formatCodeCell(cell, index, opts)
  }
  if (cell.cell_type === "markdown") {
    return formatMarkdownCell(cell, index, opts)
  }
  return formatRawCell(cell, index, opts)
}

export const formatCellMarkdownDetailed = async (
  cell: CellRaw,
  index: number,
  optsInput: Partial<MarkdownReadOptions> = {}
): Promise<FormattedCell> => {
  const opts = defaultReadOpts(optsInput)
  const collector: CellCollector = { attachments: [] }
  if (cell.cell_type === "code") {
    const rendered = await formatCodeCellDetailed(cell, index, opts, collector)
    return { rendered, attachments: collector.attachments }
  }
  if (cell.cell_type === "markdown") {
    const rendered = formatMarkdownCell(cell, index, opts)
    if (
      (opts.output.includeImages === true || opts.saveImages === true) &&
      cell.attachments !== undefined
    ) {
      for (const [name, data] of Object.entries(cell.attachments)) {
        if (data === null || typeof data !== "object") continue
        for (const [mime, value] of Object.entries(data as Record<string, unknown>)) {
          if (isAttachableImageMime(mime) && typeof value === "string") {
            collector.attachments.push(formatAttachment(mime, value, name))
          }
        }
      }
    }
    return { rendered, attachments: collector.attachments }
  }
  const rendered = formatRawCell(cell, index, opts)
  if (
    (opts.output.includeImages === true || opts.saveImages === true) &&
    cell.attachments !== undefined
  ) {
    for (const [name, data] of Object.entries(cell.attachments)) {
      if (data === null || typeof data !== "object") continue
      for (const [mime, value] of Object.entries(data as Record<string, unknown>)) {
        if (isAttachableImageMime(mime) && typeof value === "string") {
          collector.attachments.push(formatAttachment(mime, value, name))
        }
      }
    }
  }
  return { rendered, attachments: collector.attachments }
}
