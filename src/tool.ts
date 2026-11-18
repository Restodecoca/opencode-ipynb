import { Cause, Effect, Exit } from "effect"
import type { z } from "zod"
import { PermissionDeniedError } from "./domain/errors.js"

export interface ToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  readonly directory: string
  readonly worktree: string
  readonly abort: AbortSignal
  readonly pluginOptions?: unknown
  readonly pluginScope?: object
  metadata(input: {
    title?: string
    metadata?: Record<string, any>
  }): void
  ask(input: ToolAskInput): Promise<void>
}

export interface ToolAskInput {
  readonly permission: string
  readonly patterns: string[]
  readonly always: string[]
  readonly metadata: Record<string, any>
}

export interface ToolAttachment {
  readonly type: "file"
  readonly mime: string
  readonly url: string
  readonly filename?: string
}

export type ToolResult =
  | string
  | {
      readonly title?: string
      readonly output: string
      readonly metadata?: Record<string, any>
      readonly attachments?: ToolAttachment[]
    }

export interface ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> {
  readonly description: string
  readonly args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext
  ): Promise<ToolResult>
}

export type AnyToolDefinition = ToolDefinition<z.ZodRawShape>

export const tool = <Args extends z.ZodRawShape>(
  definition: ToolDefinition<Args>
): ToolDefinition<Args> => definition

export const runToolEffect = async <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") throw failure.value
  throw Cause.squash(exit.cause)
}

export const rethrowPermissionDenied = (error: unknown): void => {
  if (error instanceof PermissionDeniedError) {
    throw error.cause === undefined ? error : error.cause
  }
}
