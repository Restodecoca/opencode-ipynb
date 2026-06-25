import { firstLine, truncatePreview } from "../utils/truncate.js"
import { humanBytes, isImageMime } from "../utils/mime.js"
import { DEFAULT_INSPECT_PREVIEW_CHARS, DEFAULT_MAX_IMAGE_NOTICE_COUNT } from "../utils/limits.js"
import type { CellRaw } from "../domain/cell.js"
import { cellSource } from "../domain/notebook.js"

export interface CellInspection {
  index: number
  cellType: "code" | "markdown" | "raw"
  executionCount: number | null
  sourceLines: number
  hasOutputs: boolean
  hasError: boolean
  hasLargeOutput: boolean
  hasImage: boolean
  firstLine: string
  outputSummary: string
}

const outputTextToString = (value: unknown): string =>
  Array.isArray(value) ? value.map(String).join("") : String(value ?? "")

export const inspectCell = (cell: CellRaw, index: number): CellInspection => {
  const cellType = cell.cell_type
  const source = cellSource(cell)
  const lines = source.split("\n")
  const first = firstLine(source) || "(empty)"

  if (cellType === "code") {
    const outputs = cell.outputs
    const hasOutputs = outputs.length > 0
    const hasError = outputs.some((o) => o["output_type"] === "error")
    let totalBytes = 0
    let hasLarge = false
    let hasImg = false
    let imageCount = 0
    let streamSummary = ""
    let errorSummary = ""

    for (const out of outputs) {
      const ot = out["output_type"]
      if (ot === "stream") {
        const text = outputTextToString(out["text"])
        streamSummary += text.slice(0, 200) + (text.length > 200 ? "..." : "")
      } else if (ot === "error") {
        const ename = String(out["ename"] ?? "")
        const evalue = String(out["evalue"] ?? "")
        errorSummary = `${ename}: ${evalue}`
      } else if (ot === "display_data" || ot === "execute_result") {
        const data = out["data"] as Record<string, unknown> | undefined
        if (data) {
          for (const [mime, value] of Object.entries(data)) {
            if (isImageMime(mime)) {
              hasImg = true
              imageCount++
              if (typeof value === "string") {
                totalBytes += Math.floor((value.length * 3) / 4)
              }
            } else {
              const s = typeof value === "string" ? value : JSON.stringify(value)
              totalBytes += s.length
            }
          }
        }
      }
    }

    if (totalBytes > 50_000) {
      hasLarge = true
    }

    const summaryParts: string[] = []
    if (hasOutputs) {
      summaryParts.push(`${outputs.length} output${outputs.length > 1 ? "s" : ""}`)
    }
    if (streamSummary) {
      const cleaned = streamSummary.replace(/\n/g, " ")
      summaryParts.push(
        `stream: ${cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned}`
      )
    }
    if (errorSummary) {
      summaryParts.push(`error: ${truncatePreview(errorSummary, 80)}`)
    }
    if (hasImg) {
      const shown = Math.min(imageCount, DEFAULT_MAX_IMAGE_NOTICE_COUNT)
      const suffix = imageCount > shown ? "+" : ""
      summaryParts.push(`${imageCount} image${imageCount > 1 ? "s" : ""} (${humanBytes(totalBytes)})${suffix}`)
    }
    if (hasLarge) {
      summaryParts.push("large")
    }

    return {
      index,
      cellType: "code",
      executionCount: cell.execution_count,
      sourceLines: lines.length,
      hasOutputs,
      hasError,
      hasLargeOutput: hasLarge,
      hasImage: hasImg,
      firstLine: truncatePreview(first, DEFAULT_INSPECT_PREVIEW_CHARS),
      outputSummary: summaryParts.join(" | ") || "(no output)"
    }
  }

  return {
    index,
    cellType,
    executionCount: null,
    sourceLines: lines.length,
    hasOutputs: false,
    hasError: false,
    hasLargeOutput: false,
    hasImage: false,
    firstLine: truncatePreview(first, DEFAULT_INSPECT_PREVIEW_CHARS),
    outputSummary: "-"
  }
}
