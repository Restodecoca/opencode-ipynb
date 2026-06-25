import { z } from "zod"

export const SourceSchema = z.union([z.string(), z.array(z.string())])
export type Source = z.infer<typeof SourceSchema>

export const CellMetadataSchema = z.record(z.string(), z.unknown())
export type CellMetadata = z.infer<typeof CellMetadataSchema>

export const CodeCellSchema = z
  .object({
    cell_type: z.literal("code"),
    id: z.string().optional(),
    metadata: CellMetadataSchema,
    execution_count: z.union([z.number().int().nullable(), z.null()]),
    source: SourceSchema,
    outputs: z.array(z.record(z.string(), z.unknown())).default([])
  })
  .passthrough()
export type CodeCellRaw = z.infer<typeof CodeCellSchema>

export const MarkdownCellSchema = z
  .object({
    cell_type: z.literal("markdown"),
    id: z.string().optional(),
    metadata: CellMetadataSchema,
    source: SourceSchema,
    attachments: z.record(z.string(), z.unknown()).optional()
  })
  .passthrough()
export type MarkdownCellRaw = z.infer<typeof MarkdownCellSchema>

export const RawCellSchema = z
  .object({
    cell_type: z.literal("raw"),
    id: z.string().optional(),
    metadata: CellMetadataSchema,
    source: SourceSchema
  })
  .passthrough()
export type RawCellRaw = z.infer<typeof RawCellSchema>

export const CellSchema = z.union([CodeCellSchema, MarkdownCellSchema, RawCellSchema])
export type CellRaw = z.infer<typeof CellSchema>
