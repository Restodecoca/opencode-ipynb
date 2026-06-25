import { z } from "zod"

export const StreamOutputSchema = z
  .object({
    output_type: z.literal("stream"),
    name: z.union([z.literal("stdout"), z.literal("stderr")]),
    text: z.union([z.string(), z.array(z.string())])
  })
  .passthrough()
export type StreamOutputRaw = z.infer<typeof StreamOutputSchema>

export const DisplayDataOutputSchema = z
  .object({
    output_type: z.literal("display_data"),
    data: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough()
export type DisplayDataOutputRaw = z.infer<typeof DisplayDataOutputSchema>

export const ExecuteResultOutputSchema = z
  .object({
    output_type: z.literal("execute_result"),
    execution_count: z.union([z.number().int(), z.null()]),
    data: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())])),
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .passthrough()
export type ExecuteResultOutputRaw = z.infer<typeof ExecuteResultOutputSchema>

export const ErrorOutputSchema = z
  .object({
    output_type: z.literal("error"),
    ename: z.string(),
    evalue: z.string(),
    traceback: z.array(z.string())
  })
  .passthrough()
export type ErrorOutputRaw = z.infer<typeof ErrorOutputSchema>

export const CellOutputSchema = z.union([
  StreamOutputSchema,
  DisplayDataOutputSchema,
  ExecuteResultOutputSchema,
  ErrorOutputSchema
])
export type CellOutputRaw = z.infer<typeof CellOutputSchema>

export type CellOutputKind = "stream" | "display_data" | "execute_result" | "error" | "unknown"

export const detectOutputKind = (raw: Record<string, unknown>): CellOutputKind => {
  const ot = raw["output_type"]
  if (ot === "stream" || ot === "display_data" || ot === "execute_result" || ot === "error") {
    return ot
  }
  return "unknown"
}
