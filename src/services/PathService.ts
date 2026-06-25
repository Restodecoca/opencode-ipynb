import { Context, Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import { PathOutsideWorktreeError, NotebookNotFoundError } from "../domain/errors.js"
import {
  hasIpynbExtension,
  isAbsolutePath,
  makeRelative,
  normalizeSlashes,
  resolveAgainstBase,
  toForwardSlashes
} from "../utils/paths.js"

export interface PathEnv {
  readonly directory: string
  readonly worktree: string
  readonly platform: NodeJS.Platform
  readonly allowOutsideWorktree?: boolean | undefined
}

export interface PathServiceShape {
  readonly env: PathEnv
  readonly resolve: (inputPath: string) => Effect.Effect<string, never>
  readonly relative: (absPath: string) => Effect.Effect<string, never>
  readonly ensureInsideWorktree: (absPath: string) => Effect.Effect<void, PathOutsideWorktreeError>
  readonly ensureExists: (absPath: string) => Effect.Effect<void, NotebookNotFoundError>
  readonly ensureIpynb: (
    absPath: string
  ) => Effect.Effect<{ absPath: string; warned: boolean }, never>
  readonly toDisplay: (absPath: string) => string
}

export class PathService extends Context.Tag("@ipynb/PathService")<PathService, PathServiceShape>() {}

const pathNorm = (p: string, platform: NodeJS.Platform): string => {
  if (!p) {
    return p
  }
  const resolved = path.resolve(p)
  return normalizeSlashes(resolved, platform)
}

const buildPathService = (env: PathEnv): PathServiceShape => {
  const worktreeResolved = pathNorm(env.worktree, env.platform)
  const directoryResolved = pathNorm(env.directory, env.platform)
  const allowOutside = env.allowOutsideWorktree === true

  const insideWorktree = (abs: string): boolean => {
    const norm = pathNorm(abs, env.platform)
    if (norm === worktreeResolved) {
      return true
    }
    const rel = path.relative(worktreeResolved, norm)
    if (!rel) {
      return true
    }
    return !rel.startsWith("..") && !path.isAbsolute(rel)
  }

  return {
    env,
    resolve: (inputPath) =>
      Effect.sync(() => {
        if (!isAbsolutePath(inputPath)) {
          return resolveAgainstBase({
            inputPath,
            base: directoryResolved,
            platform: env.platform
          })
        }
        return pathNorm(inputPath, env.platform)
      }),
    relative: (absPath) =>
      Effect.sync(() => {
        const norm = pathNorm(absPath, env.platform)
        return makeRelative(worktreeResolved, norm, {
          platform: env.platform,
          relativeFn: (from, to) => path.relative(from, to)
        })
      }),
    ensureInsideWorktree: (absPath) =>
      Effect.try({
        try: () => {
          if (allowOutside) {
            return
          }
          if (!insideWorktree(absPath)) {
            throw new PathOutsideWorktreeError({
              message: "path resolves outside of the worktree",
              filePath: absPath,
              worktree: worktreeResolved
            })
          }
        },
        catch: (err) => {
          if (err instanceof PathOutsideWorktreeError) {
            return err
          }
          return new PathOutsideWorktreeError({
            message: err instanceof Error ? err.message : String(err),
            filePath: absPath,
            worktree: worktreeResolved
          })
        }
      }),
    ensureExists: (absPath) =>
      Effect.try({
        try: () => {
          if (!fs.existsSync(absPath)) {
            throw new NotebookNotFoundError({
              message: "file does not exist",
              filePath: absPath
            })
          }
        },
        catch: (err) => {
          if (err instanceof NotebookNotFoundError) {
            return err
          }
          return new NotebookNotFoundError({
            message: err instanceof Error ? err.message : String(err),
            filePath: absPath
          })
        }
      }),
    ensureIpynb: (absPath) =>
      Effect.sync(() => {
        if (hasIpynbExtension(absPath)) {
          return { absPath, warned: false }
        }
        return { absPath, warned: true }
      }),
    toDisplay: (absPath) => toForwardSlashes(pathNorm(absPath, env.platform))
  }
}

export const makePathService = buildPathService
