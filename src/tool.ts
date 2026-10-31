import { Cause, Effect, Exit } from "effect"
import type { z } from "zod"
import { PermissionDeniedError } from "./domain/errors.js"

/**
 * Minimal tool contract used by the notebook implementations.
 *
 * The plugin is V2-only, but keeping this small internal helper lets every
 * tool declare zod args once and share the same result/context shape. The V2
 * adapter converts the zod args to JSON Schema and maps results to V2 content.
 */
export interface ToolContext {
  readonly sessionID: string
  readonly messageID: string
  readonly agent: string
  /** Current project directory for this session. */
  readonly directory: string
  /** Project worktree root for this session. */
  readonly worktree: string
  readonly abort: AbortSignal
  /** Options from this plugin instance. */
  readonly pluginOptions?: unknown
  /** Identity of the plugin instance, used to scope warm-kernel cleanup. */
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

/**
 * Run an Effect from a tool executor while preserving typed failures.
 *
 * `Effect.runPromiseExit` preserves the typed failure, so permission errors
 * can be rethrown as the V2 host expects.
 */
export const runToolEffect = async <A, E>(
  effect: Effect.Effect<A, E>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  if (failure._tag === "Some") throw failure.value
  throw Cause.squash(exit.cause)
}

/**
 * V2 permission.assert rejections must propagate to the host instead of being
 * converted into normal tool output. When the permission service preserved the
 * original host error, rethrow that; otherwise rethrow the tagged error.
 */
export const rethrowPermissionDenied = (error: unknown): void => {
  if (error instanceof PermissionDeniedError) {
    throw error.cause === undefined ? error : error.cause
  }
}
