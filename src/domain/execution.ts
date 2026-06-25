import { z } from "zod"

export const EnvReportSchema = z.object({
  kernelDisplayName: z.string().nullable(),
  kernelName: z.string().nullable(),
  language: z.string().nullable(),
  pythonVersion: z.string(),
  pythonExecutable: z.string(),
  platform: z.string(),
  pipFreeze: z.array(z.string())
})
export type EnvReport = z.infer<typeof EnvReportSchema>

export const RunRequestSchema = z.object({
  filePath: z.string(),
  mode: z.union([
    z.literal("cell"),
    z.literal("range"),
    z.literal("all"),
    z.literal("from"),
    z.literal("env")
  ]),
  cellIndex: z.number().int().optional(),
  start: z.number().int().optional(),
  end: z.number().int().optional(),
  kernel: z.string().optional(),
  timeoutMs: z.number().int().optional(),
  save: z.boolean().optional(),
  workingDirectory: z.string().optional(),
  maxOutputChars: z.number().int().optional()
})
export type RunRequest = z.infer<typeof RunRequestSchema>

export const CellExecutionSummarySchema = z.object({
  cellIndex: z.number().int(),
  status: z.union([z.literal("ok"), z.literal("error"), z.literal("timeout"), z.literal("skipped")]),
  executionCount: z.number().int().nullable().optional(),
  durationMs: z.number().int().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  resultPreview: z.string().optional(),
  displayData: z
    .array(
      z.object({
        mime: z.string(),
        sizeBytes: z.number().int()
      })
    )
    .optional(),
  rawOutputs: z.array(z.record(z.string(), z.unknown())).optional(),
  errors: z
    .array(
      z.object({
        ename: z.string(),
        evalue: z.string(),
        traceback: z.array(z.string())
      })
    )
    .optional()
})
export type CellExecutionSummary = z.infer<typeof CellExecutionSummarySchema>

export const RunResponseSchema = z.object({
  success: z.boolean(),
  executedCells: z.array(z.number().int()),
  durationMs: z.number().int(),
  saved: z.boolean().optional(),
  outputs: z.array(CellExecutionSummarySchema),
  env: EnvReportSchema.optional(),
  error: z
    .object({
      kind: z.string(),
      cellIndex: z.number().int(),
      ename: z.string(),
      evalue: z.string(),
      traceback: z.array(z.string())
    })
    .optional()
})
export type RunResponse = z.infer<typeof RunResponseSchema>
