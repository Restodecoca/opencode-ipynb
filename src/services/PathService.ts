import { Effect } from "effect"
import { randomBytes } from "node:crypto"
import * as path from "node:path"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import { replaceFile } from "../utils/atomic-replace.js"
import {
  NotebookNotFoundError,
  NotebookWriteError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
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
  readonly writeFileSafe: (
    absPath: string,
    content: string,
    options?: { readonly noFollowFinal?: boolean }
  ) => Effect.Effect<void, PathOutsideWorktreeError | NotebookWriteError>
  readonly ensureIpynb: (
    absPath: string
  ) => Effect.Effect<{ absPath: string; warned: boolean }, never>
  readonly toDisplay: (absPath: string) => string
}

const pathNorm = (p: string, platform: NodeJS.Platform): string => {
  if (!p) {
    return p
  }
  const resolved = path.resolve(p)
  return platform === "win32" ? normalizeSlashes(resolved, platform) : resolved
}

const buildPathService = (env: PathEnv): PathServiceShape => {
  const worktreeResolved = pathNorm(env.worktree, env.platform)
  const directoryResolved = pathNorm(env.directory, env.platform)
  const allowOutside = env.allowOutsideWorktree === true

  const inside = (base: string, abs: string): boolean => {
    const norm = pathNorm(abs, env.platform)
    if (norm === base) {
      return true
    }
    const rel = path.relative(base, norm)
    if (!rel) {
      return true
    }
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  }

  const outsideError = (absPath: string, message: string): PathOutsideWorktreeError =>
    new PathOutsideWorktreeError({
      message,
      filePath: absPath,
      worktree: worktreeResolved
    })

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
      Effect.tryPromise({
        try: async () => {
          if (allowOutside) {
            return
          }
          const worktreeReal = await fs.promises
            .realpath(worktreeResolved)
            .catch(() => worktreeResolved)
          const assertPath = async (candidate: string, depth = 0): Promise<void> => {
            if (depth > 64) {
              throw outsideError(absPath, "path has too many symlink levels")
            }
            const real = await fs.promises.realpath(candidate).catch(() => undefined)
            if (real !== undefined) {
              if (!inside(worktreeReal, real)) {
                throw outsideError(absPath, "path resolves outside of the worktree (symlink)")
              }
              return
            }
            const isLink = await fs.promises
              .lstat(candidate)
              .then((stat) => stat.isSymbolicLink())
              .catch(() => false)
            if (isLink) {
              const target = await fs.promises.readlink(candidate).catch(() => undefined)
              if (target !== undefined) {
                await assertPath(path.resolve(path.dirname(candidate), target), depth + 1)
                return
              }
            }
            const parent = path.dirname(candidate)
            if (parent === candidate) return
            await assertPath(parent, depth + 1)
          }
          await assertPath(absPath)
        },
        catch: (err) => {
          if (err instanceof PathOutsideWorktreeError) {
            return err
          }
          return outsideError(
            absPath,
            err instanceof Error ? err.message : String(err)
          )
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
    writeFileSafe: (absPath, content, options) =>
      Effect.tryPromise({
        try: async () => {
          if (options?.noFollowFinal === true) {
            const existing = await fsp.lstat(absPath).catch(() => undefined)
            if (existing?.isSymbolicLink()) {
              throw new NotebookWriteError({
                message: "refusing to write through a symlink at the pinned target",
                filePath: absPath
              })
            }
          }
          const writeTarget = async (target: string): Promise<void> => {
            const targetDir = path.dirname(target)
            const temp = path.join(
              targetDir,
              `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
            )
            try {
              const existing = await fsp.lstat(target).catch(() => undefined)
              await fsp.writeFile(temp, content, {
                encoding: "utf8",
                flag: "wx",
                mode:
                  existing !== undefined && !existing.isSymbolicLink()
                    ? existing.mode & 0o777
                    : 0o600
              })
              if (existing !== undefined && !existing.isSymbolicLink()) {
                await fsp.chmod(temp, existing.mode & 0o777).catch(() => {})
              }
              if (existing?.isDirectory()) {
                throw new NotebookWriteError({
                  message: `cannot overwrite a directory: ${target}`,
                  filePath: absPath
                })
              }
              await replaceFile(temp, target)
            } catch (error) {
              await fsp.rm(temp, { force: true }).catch(() => {})
              throw error
            }
          }

          if (allowOutside) {
            const parent = path.dirname(absPath)
            await fsp.mkdir(parent, { recursive: true })
            const existingReal =
              options?.noFollowFinal === true
                ? undefined
                : await fsp.realpath(absPath).catch(() => undefined)
            const target = existingReal ?? absPath
            await writeTarget(target)
            return
          }

          const root = await fsp.realpath(worktreeResolved).catch(() => worktreeResolved)
          const parent = path.dirname(absPath)
          let probe = absPath
          let ancestorReal: string | undefined
          for (let depth = 0; depth < 128; depth += 1) {
            ancestorReal = await fsp.realpath(probe).catch(() => undefined)
            if (ancestorReal !== undefined) break
            const next = path.dirname(probe)
            if (next === probe) break
            probe = next
          }
          if (ancestorReal === undefined || !inside(root, ancestorReal)) {
            throw outsideError(
              absPath,
              "path resolves outside of the worktree (symlink)"
            )
          }
          await fsp.mkdir(parent, { recursive: true })
          const parentReal = await fsp.realpath(parent).catch(() => undefined)
          if (parentReal === undefined || !inside(root, parentReal)) {
            throw outsideError(
              absPath,
              "path resolves outside of the worktree (symlink)"
            )
          }
          const existingReal =
            options?.noFollowFinal === true
              ? undefined
              : await fsp.realpath(absPath).catch(() => undefined)
          if (existingReal !== undefined && !inside(root, existingReal)) {
            throw outsideError(
              absPath,
              "path resolves outside of the worktree (symlink)"
            )
          }
          const target =
            existingReal ?? path.join(parentReal, path.basename(absPath))
          await writeTarget(target)
        },
        catch: (err) =>
          err instanceof PathOutsideWorktreeError
            ? err
            : err instanceof NotebookWriteError
              ? err
              : new NotebookWriteError({
                  message: err instanceof Error ? err.message : String(err),
                  filePath: absPath
                })
      }),
    toDisplay: (absPath) => toForwardSlashes(pathNorm(absPath, env.platform))
  }
}

export const makePathService = buildPathService
