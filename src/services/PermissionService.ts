import { Effect } from "effect"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import type { ToolContext } from "../tool.js"
import { PermissionDeniedError } from "../domain/errors.js"
import { pathInside } from "../utils/paths.js"
import { type WarningSink, warningFrom } from "../utils/warnings.js"

const isMissingPath = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

const reportUnlessMissing = (
  sink: WarningSink | undefined,
  context: string,
  error: unknown
): void => {
  if (!isMissingPath(error)) sink?.add(warningFrom("permission-alias", error, context))
}

export interface AliasResolutionOptions {
  readonly warningSink?: WarningSink | undefined
}

export const resolveDeepReal = async (
  target: string,
  options: AliasResolutionOptions = {}
): Promise<string> => {
  const sink = options.warningSink
  const suffix: string[] = []
  let current = target
  let reported = false
  while (true) {
    const real = await fsp.realpath(current).catch((error: unknown) => {
      if (!reported) {
        reported = true
        reportUnlessMissing(sink, `resolving ${current}`, error)
      }
      return undefined
    })
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
  bases: ReadonlyArray<string> = [],
  options: AliasResolutionOptions = {}
): Promise<ReadonlyArray<string>> => {
  const sink = options.warningSink
  const base = bases[0] ?? process.cwd()
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(base, filePath)
  const resolved = await resolveDeepReal(absolute, { warningSink: sink })
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
    const realRoot = await fsp.realpath(root).catch((error: unknown) => {
      reportUnlessMissing(sink, `resolving the base ${root}`, error)
      return undefined
    })
    if (realRoot !== undefined) roots.add(path.resolve(realRoot))
    for (const rootAbs of roots) {
      for (const candidate of [absolute, resolved]) {
        if (!pathInside(rootAbs, candidate)) continue
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

export interface PermissionServiceOptions {
  readonly warningSink?: WarningSink | undefined
}

const build = (
  ctx: ToolContext,
  options: PermissionServiceOptions = {}
): PermissionServiceShape => {
  const sink = options.warningSink
  return {
    aliases: (filePath) =>
      Effect.promise(() =>
        permissionAliases(filePath, [ctx.directory, ctx.worktree], {
          warningSink: sink
        })
      ),
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
  }
}

export const makePermissionService = build
