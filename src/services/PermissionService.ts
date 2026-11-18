import { Effect } from "effect"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import type { ToolContext } from "../tool.js"
import { PermissionDeniedError } from "../domain/errors.js"

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

export const resolveDeepReal = async (target: string): Promise<string> => {
  const suffix: string[] = []
  let current = target
  while (true) {
    const real = await fsp.realpath(current).catch(() => undefined)
    if (real !== undefined) {
      return suffix.length === 0 ? real : path.join(real, ...suffix)
    }
    const parent = path.dirname(current)
    if (parent === current) return target
    suffix.unshift(path.basename(current))
    current = parent
  }
}

export const permissionAliases = async (
  filePath: string,
  bases: ReadonlyArray<string> = []
): Promise<ReadonlyArray<string>> => {
  const base = bases[0] ?? process.cwd()
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(base, filePath)
  const real = await fsp.realpath(absolute).catch(() => undefined)
  const resolved = real ?? (await resolveDeepReal(absolute))
  const out = new Set<string>([absolute])
  const addWithSlashes = (value: string): void => {
    out.add(value)
    const forward = value.replace(/\\/g, "/")
    if (forward !== value) out.add(forward)
  }
  addWithSlashes(absolute)
  if (resolved !== absolute) addWithSlashes(resolved)
  for (const root of bases) {
    const roots = new Set<string>([path.resolve(root)])
    const realRoot = await fsp.realpath(root).catch(() => undefined)
    if (realRoot !== undefined) roots.add(path.resolve(realRoot))
    for (const rootAbs of roots) {
      for (const candidate of [absolute, resolved]) {
        if (!inside(rootAbs, candidate)) continue
        const relative = path.relative(rootAbs, candidate)
        if (relative.length > 0) addWithSlashes(relative)
      }
    }
  }
  return [...out]
}

export type PermissionKind = "edit" | "shell" | "read"

export interface PermissionRequest {
  readonly kind: PermissionKind
  readonly action: string
  readonly patterns: ReadonlyArray<string>
  readonly always: ReadonlyArray<string>
  readonly metadata: Record<string, unknown>
}

export interface PermissionServiceShape {
  readonly ask: (req: PermissionRequest) => Effect.Effect<void, PermissionDeniedError>
  readonly aliases: (
    filePath: string
  ) => Effect.Effect<ReadonlyArray<string>, never>
}

const build = (ctx: ToolContext): PermissionServiceShape => ({
  aliases: (filePath) =>
    Effect.promise(() => permissionAliases(filePath, [ctx.directory, ctx.worktree])),
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
          action: req.action,
          cause: err
        })
    })
})

export const makePermissionService = build
