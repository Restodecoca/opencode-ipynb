import { truncate } from "../utils/truncate.js"
import { cellSource } from "../domain/notebook.js"
import type { CellRaw, CodeCellRaw, MarkdownCellRaw, RawCellRaw } from "../domain/cell.js"
import { formatOutputs, formatOutputsDetailed, type FormattedOutput, type OutputFormatOptions } from "./outputs.js"
import type { ToolAttachment } from "@opencode-ai/plugin"
import type { SavedAttachment } from "../utils/attachments.js"

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
  readonly savedAttachments: ReadonlyArray<SavedAttachment>
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
  saved: SavedAttachment[]
}

const formatCodeCell = (cell: CodeCellRaw, index: number, opts: MarkdownReadOptions): string => {
  const lines: string[] = []
  lines.push(`### Cell [${index}]`)
  lines.push(`Type: code`)
  lines.push(`Execution: ${cell.execution_count ?? "not run"}`)
  if (opts.includeMetadata && Object.keys(cell.metadata).length > 0) {
    lines.push(`Metadata: \`\`\`json\n${JSON.stringify(cell.metadata, null, 2)}\n\`\`\``)
  }
  const source = cellSource(cell)
  const t = truncate(source, opts.maxSourceChars, { key: "source", paramName: "maxSourceChars" })
  lines.push("")
  lines.push("Source:")
  lines.push("```python")
  lines.push(t.text)
  lines.push("```")
  if (opts.includeOutputs) {
    const formatted = formatOutputs(cell, opts.output)
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
      lines.push(formatOutputs({ ...cell, outputs: errOutputs }, { ...opts.output, maxOutputChars: opts.maxSourceChars }))
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
    lines.push(`Metadata: \`\`\`json\n${JSON.stringify(cell.metadata, null, 2)}\n\`\`\``)
  }
  const source = cellSource(cell)
  const t = truncate(source, opts.maxSourceChars, { key: "source", paramName: "maxSourceChars" })
  lines.push("")
  lines.push("Source:")
  lines.push("```python")
  lines.push(t.text)
  lines.push("```")
  if (opts.includeOutputs) {
    const formatted: FormattedOutput = await formatOutputsDetailed(cell, opts.output)
    if (formatted.rendered && formatted.rendered !== "(no output)") {
      lines.push("")
      lines.push("Outputs:")
      lines.push("")
      lines.push(formatted.rendered)
    }
    collector.attachments.push(...formatted.attachments)
    collector.saved.push(...formatted.savedAttachments)
  } else if (opts.includeErrors) {
    const errOutputs = cell.outputs.filter((o) => o["output_type"] === "error")
    if (errOutputs.length > 0) {
      const formatted: FormattedOutput = await formatOutputsDetailed(
        { ...cell, outputs: errOutputs },
        { ...opts.output, maxOutputChars: opts.maxSourceChars }
      )
      lines.push("")
      lines.push("Errors:")
      lines.push("")
      lines.push(formatted.rendered)
      collector.attachments.push(...formatted.attachments)
      collector.saved.push(...formatted.savedAttachments)
    }
  }
  return lines.join("\n")
}

const formatMarkdownCell = (cell: MarkdownCellRaw, index: number, opts: MarkdownReadOptions): string => {
  const lines: string[] = []
  lines.push(`### Cell [${index}]`)
  lines.push(`Type: markdown`)
  if (opts.includeMetadata && Object.keys(cell.metadata).length > 0) {
    lines.push(`Metadata: \`\`\`json\n${JSON.stringify(cell.metadata, null, 2)}\n\`\`\``)
  }
  const source = cellSource(cell)
  const t = truncate(source, opts.maxSourceChars, { key: "source", paramName: "maxSourceChars" })
  lines.push("")
  lines.push(t.text)
  return lines.join("\n")
}

const formatRawCell = (cell: RawCellRaw, index: number, opts: MarkdownReadOptions): string => {
  const lines: string[] = []
  lines.push(`### Cell [${index}]`)
  lines.push(`Type: raw`)
  if (opts.includeMetadata && Object.keys(cell.metadata).length > 0) {
    lines.push(`Metadata: \`\`\`json\n${JSON.stringify(cell.metadata, null, 2)}\n\`\`\``)
  }
  const source = cellSource(cell)
  const t = truncate(source, opts.maxSourceChars, { key: "source", paramName: "maxSourceChars" })
  lines.push("")
  lines.push("```")
  lines.push(t.text)
  lines.push("```")
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
  const collector: CellCollector = { attachments: [], saved: [] }
  if (cell.cell_type === "code") {
    const rendered = await formatCodeCellDetailed(cell, index, opts, collector)
    return { rendered, attachments: collector.attachments, savedAttachments: collector.saved }
  }
  if (cell.cell_type === "markdown") {
    return { rendered: formatMarkdownCell(cell, index, opts), attachments: [], savedAttachments: [] }
  }
  return { rendered: formatRawCell(cell, index, opts), attachments: [], savedAttachments: [] }
}
