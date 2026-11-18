import { z } from "zod"
import { CellSchema, type CellRaw } from "./cell.js"
import { SourceSchema } from "./cell.js"

export const KernelSpecSchema = z
  .object({
    name: z.string().optional(),
    display_name: z.string().optional(),
    language: z.string().optional()
  })
  .passthrough()
export type KernelSpec = z.infer<typeof KernelSpecSchema>

export const LanguageInfoSchema = z
  .object({
    name: z.string()
  })
  .passthrough()
export type LanguageInfo = z.infer<typeof LanguageInfoSchema>

export const NotebookMetadataSchema = z
  .object({
    kernelspec: KernelSpecSchema.optional(),
    language_info: LanguageInfoSchema.optional(),
    authors: z.array(z.record(z.string(), z.unknown())).optional(),
    orig_nbformat: z.number().int().optional()
  })
  .passthrough()
export type NotebookMetadataRaw = z.infer<typeof NotebookMetadataSchema>

export const NotebookSchema = z
  .object({
    nbformat: z.number().int(),
    nbformat_minor: z.number().int(),
    metadata: NotebookMetadataSchema.default({}),
    cells: z.array(CellSchema)
  })
  .passthrough()
export type NotebookRaw = z.infer<typeof NotebookSchema>

export const normalizeSource = (source: z.infer<typeof SourceSchema>): string => {
  if (typeof source === "string") {
    return source
  }
  return source.join("")
}

export const cellSource = (cell: CellRaw): string => normalizeSource(cell.source)

const LINE_BREAK = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/g

export const splitSourceLines = (source: string): string[] => {
  const lines: string[] = []
  let start = 0
  LINE_BREAK.lastIndex = 0
  for (let match = LINE_BREAK.exec(source); match !== null; match = LINE_BREAK.exec(source)) {
    const end = match.index + match[0].length
    lines.push(source.slice(start, end))
    start = end
  }
  if (start < source.length) lines.push(source.slice(start))
  return lines
}

export const formatSourceLike = (
  previous: z.infer<typeof SourceSchema>,
  next: string
): z.infer<typeof SourceSchema> =>
  typeof previous === "string" ? next : splitSourceLines(next)

const defineOwn = (
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true
  })
}

const insertSorted = (
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void => {
  if (Object.prototype.hasOwnProperty.call(target, key)) return
  const entries = Object.entries(target)
  const index = entries.findIndex(([candidate]) => candidate > key)
  if (index === -1) {
    defineOwn(target, key, value)
    return
  }
  for (const [existing] of entries) delete target[existing]
  entries.splice(index, 0, [key, value])
  for (const [existing, existingValue] of entries) {
    defineOwn(target, existing, existingValue)
  }
}

export const applyNotebookDefaults = (raw: unknown): NotebookRaw => {
  const nb = raw as {
    metadata?: unknown
    cells: Array<Record<string, unknown>>
  }
  if (nb.metadata === undefined) {
    insertSorted(nb as Record<string, unknown>, "metadata", {})
  }
  for (const cell of nb.cells) {
    if (cell["cell_type"] === "code" && cell["outputs"] === undefined) {
      insertSorted(cell, "outputs", [])
    }
  }
  return raw as NotebookRaw
}
