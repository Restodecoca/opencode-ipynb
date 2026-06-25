import { Context, Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { PermissionDeniedError } from "../domain/errors.js"

export type PermissionKind = "edit" | "bash" | "read"

export interface PermissionRequest {
  readonly kind: PermissionKind
  readonly action: string
  readonly patterns: ReadonlyArray<string>
  readonly always: ReadonlyArray<string>
  readonly metadata: Record<string, unknown>
}

export interface PermissionServiceShape {
  readonly ask: (req: PermissionRequest) => Effect.Effect<void, PermissionDeniedError>
}

export class PermissionService extends Context.Tag("@ipynb/PermissionService")<
  PermissionService,
  PermissionServiceShape
>() {}

const build = (ctx: ToolContext): PermissionServiceShape => ({
  ask: (req) =>
    Effect.tryPromise({
      try: async () => {
        await ctx.ask({
          permission: req.kind,
          patterns: [...req.patterns],
          always: [...req.always],
          metadata: {
            ...req.metadata,
            action: req.action
          }
        })
      },
      catch: (err) =>
        new PermissionDeniedError({
          message: err instanceof Error ? err.message : String(err),
          action: req.action
        })
    })
})

export const makePermissionService = build
