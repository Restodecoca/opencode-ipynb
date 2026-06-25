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
    nbformat_minor: z.number().int().optional(),
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
