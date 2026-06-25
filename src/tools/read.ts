import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolAttachment, ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"
import { resolveToolOptions } from "./_resolveOptions.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file"),
  cellIndex: z.number().int().nonnegative().optional().describe("Index of a single cell to read"),
  start: z.number().int().nonnegative().optional().describe("Start index for a range read"),
  end: z.number().int().nonnegative().optional().describe("End index (inclusive) for a range read"),
  includeOutputs: z.boolean().optional().default(false).describe("Include output payloads (default: false)"),
  includeErrors: z.boolean().optional().default(true).describe("Include error tracebacks from code cells (default: true)"),
  includeMetadata: z.boolean().optional().default(false).describe("Include per-cell metadata JSON"),
  includeImages: z
    .boolean()
    .optional()
    .default(false)
    .describe("Include image payloads as attachments (default: false)"),
  maxSourceChars: z
    .number()
    .int()
    .positive()
    .optional()
    .default(12_000)
    .describe("Maximum number of source characters per cell"),
  maxOutputChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum number of output characters per cell; falls back to ipynb.defaultMaxOutputChars, then 6000"
    )
}

const readArgsSchema = z.object(args).superRefine((input, ctx) => {
  const hasCell = input.cellIndex !== undefined
  const hasStart = input.start !== undefined
  const hasEnd = input.end !== undefined

  if (!hasCell && !hasStart && !hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either cellIndex or both start and end",
      path: ["cellIndex"]
    })
    return
  }
  if (hasCell && (hasStart || hasEnd)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "cellIndex cannot be combined with start or end; pick one mode",
      path: ["cellIndex"]
    })
    return
  }
  if (hasCell) return
  // Range mode: both start and end must be present and start <= end.
  if (!hasStart || !hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Range reads require both start and end",
      path: hasStart ? ["end"] : ["start"]
    })
    return
  }
  if ((input.start ?? 0) > (input.end ?? 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `start (${input.start}) must be <= end (${input.end})`,
      path: ["start"]
    })
  }
})

export const ipynbReadTool = tool({
  description:
    "Read a single cell or a range of cells from a Jupyter Notebook. Returns markdown with source, errors, and optional output payloads. Images/base64 are omitted by default; set includeImages=true to receive image attachments.",
  args,
  async execute(rawInput, context: ToolContext) {
    const parsed = readArgsSchema.safeParse(rawInput)
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")
      return {
        title: `Read ${String(rawInput.filePath ?? "")} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
    const input = parsed.data
    const services = buildServices(context)
    try {
      const pluginOpts = resolveToolOptions()
      const requestOptions = {
        ...input,
        saveImages: input.includeImages,
        maxOutputChars: input.maxOutputChars ?? pluginOpts.defaultMaxOutputChars
      }
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          if (input.cellIndex !== undefined) {
            return yield* services.read.readCell(input.filePath, input.cellIndex, requestOptions)
          }
          if (input.start !== undefined && input.end !== undefined) {
            return yield* services.read.readRange(input.filePath, input.start, input.end, requestOptions)
          }
          throw new Error("Provide either cellIndex or both start and end")
        })
      )
      const toolResult: {
        title: string
        output: string
        metadata: Record<string, unknown>
        attachments?: ToolAttachment[]
      } = {
        title: `Read ${input.filePath}`,
        output: result.rendered,
        metadata: {
          filePath: result.absPath,
          displayPath: result.displayPath,
          totalCells: result.totalCells,
          indexes: result.indexes
        }
      }
      if (result.attachments.length > 0) {
        toolResult.attachments = [...result.attachments]
      }
      return toolResult
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `Read ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
