import { Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import * as fsp from "node:fs/promises"
import { constants as fsConstants, type Stats } from "node:fs"
import * as path from "node:path"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  NotebookWriteError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import { NotebookSchema, applyNotebookDefaults, type NotebookRaw } from "../domain/notebook.js"
import type { PatchFailureReason, WriteMode } from "../utils/json.js"
import { absoluteDriveRoot } from "../utils/paths.js"
import { realpathWithRetry } from "../utils/realpath.js"
import { type WarningSink, warningFrom } from "../utils/warnings.js"

export type { WriteMode }

export interface WriteOutcome {
  readonly mode: WriteMode
  readonly reason?: PatchFailureReason | undefined
}
import {
  DEFAULT_NOTEBOOK_FORMAT,
  detectNotebookFormat,
  rewriteNotebookTextDetailed,
  safeParseJson,
  stringifyNotebook,
  type NotebookFormat
} from "../utils/json.js"
import { MAX_NOTEBOOK_BYTES } from "../utils/limits.js"
import { replaceFile } from "../utils/atomic-replace.js"

interface NotebookFileServiceOptions {
  readonly worktree?: string
  readonly warningSink?: WarningSink | undefined
}

const isMissingPath = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

const reportLockFailure = (
  sink: WarningSink | undefined,
  context: string,
  error: unknown
): void => {
  if (!isMissingPath(error)) sink?.add(warningFrom("lock", error, context))
}

const probeRealpath = async (
  sink: WarningSink | undefined,
  target: string
): Promise<string | undefined> => {
  try {
    return await realpathWithRetry(target)
  } catch (error) {
    if (!isMissingPath(error)) {
      sink?.add(warningFrom("path-resolution", error, `resolving ${target}`))
    }
    return undefined
  }
}

const probeStat = async (
  sink: WarningSink | undefined,
  target: string
): Promise<Stats | undefined> => {
  try {
    return await fsp.stat(target)
  } catch (error) {
    if (!isMissingPath(error)) {
      sink?.add(warningFrom("path-resolution", error, `inspecting ${target}`))
    }
    return undefined
  }
}

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(
    absoluteDriveRoot(root),
    absoluteDriveRoot(target)
  )
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

const decodeNotebookBytes = (
  bytes: Uint8Array,
  filePath: string
): Effect.Effect<string, NotebookParseError> =>
  Effect.try({
    try: () => utf8Decoder.decode(bytes),
    catch: () =>
      new NotebookParseError({
        message: "the notebook is not valid UTF-8",
        filePath
      })
  })

export interface NotebookFileServiceShape {
  readonly read: (
    filePath: string
  ) => Effect.Effect<
    NotebookRaw,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | PathOutsideWorktreeError
  >
  readonly readText: (
    filePath: string
  ) => Effect.Effect<
    string,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | PathOutsideWorktreeError
  >
  readonly readWithText: (
    filePath: string
  ) => Effect.Effect<
    {
      readonly notebook: NotebookRaw
      readonly text: string
      readonly format: NotebookFormat
    },
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | PathOutsideWorktreeError
  >
  readonly writeAtomic: (
    filePath: string,
    notebook: NotebookRaw,
    options?: {
      readonly noFollowFinal?: boolean
      readonly format?: NotebookFormat
      readonly previousText?: string
    }
  ) => Effect.Effect<
    WriteOutcome,
    | NotebookParseError
    | NotebookValidationError
    | NotebookWriteError
    | PathOutsideWorktreeError
  >
  readonly withFileLock: <A, E, R>(
    filePath: string,
    program: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>
}

interface FileLock {
  readonly sem: Semaphore.Semaphore
  active: number
}

const locks = new Map<string, FileLock>()

const buildFileService = (
  options: NotebookFileServiceOptions = {}
): NotebookFileServiceShape => {
  const worktree = options.worktree
  const warningSink = options.warningSink
  const resolveInside = async (filePath: string): Promise<string> => {
    if (worktree === undefined) return filePath
    const root = await realpathWithRetry(worktree).catch(() => worktree)
    const real = await realpathWithRetry(filePath)
    if (!inside(root, real)) {
      throw new PathOutsideWorktreeError({
        message: "path resolves outside of the worktree (symlink)",
        filePath,
        worktree: root
      })
    }
    return real
  }

  const getOrCreateLock = (key: string): FileLock => {
    const existing = locks.get(key)
    if (existing) return existing
    const lock: FileLock = { sem: Semaphore.makeUnsafe(1), active: 0 }
    locks.set(key, lock)
    return lock
  }

  const readText = (
    filePath: string
  ): Effect.Effect<
    string,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | PathOutsideWorktreeError
  > =>
    Effect.tryPromise({
      try: async () => {
        try {
          const resolved = await resolveInside(filePath)
          const stat = await fsp.stat(resolved)
          if (!stat.isFile()) {
            throw new NotebookValidationError({
              message: "notebook path is not a regular file",
              filePath,
              issues: ["not a regular file"]
            })
          }
          if (stat.size > MAX_NOTEBOOK_BYTES) {
            throw new NotebookValidationError({
              message: `notebook exceeds the ${MAX_NOTEBOOK_BYTES} byte read limit`,
              filePath,
              issues: [`size=${stat.size}`]
            })
          }
          const noFollow =
            process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW
          const nonBlock =
            process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK
          const root =
            worktree === undefined
              ? undefined
              : await realpathWithRetry(worktree).catch(() => worktree)
          const target =
            worktree === undefined
              ? await realpathWithRetry(resolved).catch(() => resolved)
              : resolved
          if (root !== undefined && !inside(root, target)) {
            throw new PathOutsideWorktreeError({
              message: "path resolves outside of the worktree (symlink swap)",
              filePath,
              worktree: root
            })
          }
          const handle = await fsp.open(
            target,
            fsConstants.O_RDONLY | noFollow | nonBlock
          )
          try {
            const opened = await handle.stat()
            if (!opened.isFile()) {
              throw new NotebookValidationError({
                message: "notebook path is not a regular file",
                filePath,
                issues: ["not a regular file"]
              })
            }
            if (opened.size > MAX_NOTEBOOK_BYTES) {
              throw new NotebookValidationError({
                message: `notebook exceeds the ${MAX_NOTEBOOK_BYTES} byte read limit`,
                filePath,
                issues: [`size=${opened.size}`]
              })
            }
            const bytes = await handle.readFile()
            try {
              return utf8Decoder.decode(bytes)
            } catch {
              throw new NotebookParseError({
                message: "the notebook is not valid UTF-8",
                filePath
              })
            }
          } finally {
            await handle.close().catch((error: unknown) => {
              warningSink?.add(
                warningFrom("cleanup", error, `closing ${filePath}`)
              )
            })
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code === "ENOENT") {
            throw new NotebookNotFoundError({
              message: "file does not exist",
              filePath
            })
          }
          throw err
        }
      },
      catch: (err) =>
        err instanceof PathOutsideWorktreeError
          ? err
          : err instanceof NotebookNotFoundError
            ? err
            : err instanceof NotebookParseError
              ? err
              : err instanceof NotebookValidationError
                ? err
                : new NotebookValidationError({
                  message: `cannot read notebook: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                  filePath,
                  issues: [
                    (err as NodeJS.ErrnoException).code ??
                      "read failed"
                  ]
                })
    })

  const validateNotebookShape = (
    value: unknown,
    filePath: string
  ): Effect.Effect<NotebookRaw, NotebookValidationError> =>
    Effect.gen(function* () {
      const parsed = NotebookSchema.safeParse(value)
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join(".") || "<root>"}: ${i.message}`
        )
        return yield* new NotebookValidationError({
          message: "schema validation failed",
          filePath,
          issues
        })
      }
      const data = parsed.data
      if (data.nbformat < 4) {
        return yield* new NotebookValidationError({
          message: `unsupported nbformat ${data.nbformat} (must be >= 4)`,
          filePath,
          issues: [`nbformat ${data.nbformat} < 4`]
        })
      }
      for (const [idx, cell] of data.cells.entries()) {
        if (cell.cell_type === "code") {
          if (typeof cell.execution_count !== "number" && cell.execution_count !== null) {
            return yield* new NotebookValidationError({
              message: `code cell at index ${idx} has invalid execution_count`,
              filePath,
              issues: [`cells[${idx}].execution_count`]
            })
          }
        }
      }
      return data
    })

  const parseAndValidate = (
    text: string,
    filePath: string
  ): Effect.Effect<NotebookRaw, NotebookParseError | NotebookValidationError> =>
    Effect.gen(function* () {
      const raw = yield* safeParseJson(text, filePath)
      yield* validateNotebookShape(raw, filePath)
      return applyNotebookDefaults(raw)
    })

  const readExistingText = (
    filePath: string
  ): Effect.Effect<string | undefined, NotebookParseError | NotebookValidationError> =>
    Effect.gen(function* () {
      const outcome = yield* Effect.promise(async () => {
        try {
          const stat = await fsp.stat(filePath)
          if (!stat.isFile()) return { kind: "unreadable" as const, detail: "not a regular file" }
          if (stat.size > MAX_NOTEBOOK_BYTES) {
            return {
              kind: "unreadable" as const,
              detail: `size=${stat.size} exceeds the ${MAX_NOTEBOOK_BYTES} byte limit`
            }
          }
          const bytes = await fsp.readFile(filePath)
          return { kind: "read" as const, bytes }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === "ENOENT" || code === "ENOTDIR") {
            return { kind: "absent" as const }
          }
          return {
            kind: "unreadable" as const,
            detail: (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))
          }
        }
      })
      if (outcome.kind === "absent") return undefined
      if (outcome.kind === "unreadable") {
        return yield* new NotebookValidationError({
          message: "the existing notebook could not be read; refusing to overwrite it",
          filePath,
          issues: [outcome.detail, "fix the file permissions or remove the file explicitly"]
        })
      }
      return yield* decodeNotebookBytes(outcome.bytes, filePath)
    })

  const writeAtomic = (
    filePath: string,
    notebook: NotebookRaw,
    options?: {
      readonly noFollowFinal?: boolean
      readonly format?: NotebookFormat
      readonly previousText?: string
    }
  ): Effect.Effect<
    WriteOutcome,
    | NotebookParseError
    | NotebookValidationError
    | NotebookWriteError
    | PathOutsideWorktreeError
  > =>
    Effect.gen(function* () {
      const stored =
        options?.format !== undefined && options?.previousText !== undefined
          ? undefined
          : yield* readExistingText(filePath)
      const format = options?.format ?? (stored === undefined ? DEFAULT_NOTEBOOK_FORMAT : detectNotebookFormat(stored))
      const previousText = options?.previousText ?? stored
      const rewrite = previousText === undefined
        ? { text: stringifyNotebook(notebook, format), mode: "fallback" as const, reason: undefined }
        : rewriteNotebookTextDetailed(previousText, notebook, format)
      const serialized = rewrite.text
      if (Buffer.byteLength(serialized, "utf8") > MAX_NOTEBOOK_BYTES) {
        return yield* new NotebookValidationError({
          message: `refusing to write a notebook larger than ${MAX_NOTEBOOK_BYTES} bytes`,
          filePath,
          issues: ["split the notebook or reduce large outputs"]
        })
      }
      yield* validateNotebookShape(notebook, filePath)
      if (
        options?.previousText === undefined &&
        previousText !== undefined &&
        serialized === previousText
      ) {
        return rewrite
      }
      return yield* Effect.uninterruptible(
        Effect.tryPromise({
          try: async () => {
            const dir = path.dirname(filePath)
          const root =
            worktree === undefined
              ? undefined
              : (await probeRealpath(warningSink, worktree)) ?? worktree
          if (root !== undefined) {
            let probe = dir
            let ancestorReal: string | undefined
            for (let depth = 0; depth < 128; depth += 1) {
              ancestorReal = await probeRealpath(warningSink, probe)
              if (ancestorReal !== undefined) break
              const next = path.dirname(probe)
              if (next === probe) break
              probe = next
            }
            if (ancestorReal === undefined || !inside(root, ancestorReal)) {
              throw new PathOutsideWorktreeError({
                message: "path resolves outside of the worktree (symlink)",
                filePath,
                worktree: root
              })
            }
          }
          await fsp.mkdir(dir, { recursive: true })
          const dirReal =
            worktree === undefined
              ? (await probeRealpath(warningSink, dir)) ?? dir
              : await (async () => {
                  const real = await realpathWithRetry(dir)
                  if (!inside(root!, real)) {
                    throw new PathOutsideWorktreeError({
                      message: "path resolves outside of the worktree (symlink)",
                      filePath,
                      worktree: root!
                    })
                  }
                  return real
                })()
          const fileReal =
            options?.noFollowFinal === true
              ? undefined
              : await probeRealpath(warningSink, filePath)
          if (root !== undefined && fileReal !== undefined && !inside(root, fileReal)) {
            throw new PathOutsideWorktreeError({
              message: "path resolves outside of the worktree (symlink)",
              filePath,
              worktree: root
            })
          }
          const target = fileReal ?? path.join(dirReal, path.basename(filePath))
          const targetDir = path.dirname(target)
          const targetStat = await probeStat(warningSink, target)
          if (targetStat?.isDirectory()) {
            throw new NotebookWriteError({
              message: `cannot overwrite a directory: ${target}`,
              filePath
            })
          }
          const existingMode = targetStat?.mode !== undefined
            ? targetStat.mode & 0o777
            : undefined
          const tmp = path.join(
            targetDir,
            `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
          )
          try {
            if (options?.previousText !== undefined) {
              let current: string | undefined
              try {
                current = await fsp.readFile(target, { encoding: "utf8" })
              } catch (revisionError) {
                warningSink?.add(
                  warningFrom(
                    "revision-check",
                    revisionError,
                    "could not verify the notebook revision before writing"
                  )
                )
              }
              if (current !== undefined && current !== options.previousText) {
                throw new NotebookValidationError({
                  message: "notebook changed while the tool was editing it",
                  filePath,
                  issues: [
                    "the notebook was modified externally; re-read it and retry the edit"
                  ]
                })
              }
              if (current === options.previousText && serialized === previousText) {
                return rewrite
              }
            }
            const handle = await fsp.open(tmp, "wx", existingMode ?? 0o600)
            try {
              await handle.writeFile(serialized, "utf8")
              await handle.sync()
            } finally {
              await handle.close()
            }
            if (existingMode !== undefined) await fsp.chmod(tmp, existingMode)
            const tempStat = await fsp.stat(tmp).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                warningSink?.add(
                  warningFrom("revision-check", error, `inspecting ${tmp}`)
                )
              }
              return undefined
            })
            await replaceFile(tmp, target, warningSink)
            const finalStat = await fsp.stat(target).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                warningSink?.add(
                  warningFrom(
                    "revision-check",
                    error,
                    `inspecting ${target} after the write`
                  )
                )
              }
              return undefined
            })
            if (
              tempStat !== undefined &&
              finalStat !== undefined &&
              tempStat.ino !== 0 &&
              finalStat.ino !== 0 &&
              tempStat.ino !== finalStat.ino
            ) {
              throw new NotebookValidationError({
                message:
                  "another process replaced the notebook right after the write",
                filePath,
                issues: [
                  "the notebook was written concurrently; re-read it and retry the edit"
                ]
              })
            }
            if (previousText !== undefined && rewrite.mode !== "patched") {
              warningSink?.add(
                warningFrom(
                  "json-patch",
                  new Error(
                    `the notebook was rewritten from scratch instead of patched (${rewrite.reason ?? "fallback"})`
                  ),
                  `reformatted ${filePath}`
                )
              )
            }
          } catch (err) {
            try {
              await fsp.unlink(tmp)
            } catch (unlinkError) {
              if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
                warningSink?.add(
                  warningFrom("temp-unlink", unlinkError, `left ${tmp}`)
                )
              }
            }
            throw err
          }
          return rewrite
        },
        catch: (err) =>
          err instanceof PathOutsideWorktreeError
            ? err
            : err instanceof NotebookValidationError
              ? err
              : new NotebookWriteError({
                  message: err instanceof Error ? err.message : String(err),
                  filePath
                })
        })
      )
    })

  return {
    read: (filePath) =>
      Effect.gen(function* () {
        const text = yield* readText(filePath)
        return yield* parseAndValidate(text, filePath)
      }),
    readText,
    readWithText: (filePath) =>
      Effect.gen(function* () {
        const text = yield* readText(filePath)
        const notebook = yield* parseAndValidate(text, filePath)
        return { notebook, text, format: detectNotebookFormat(text) }
      }),
    writeAtomic,
    withFileLock: (filePath, program) =>
      Effect.gen(function* () {
        let lockFailureReported = false
        const reportLock = (context: string, error: unknown): void => {
          if (lockFailureReported) return
          lockFailureReported = true
          reportLockFailure(warningSink, context, error)
        }
        const key = yield* Effect.tryPromise({
          try: async () => {
            const real = await realpathWithRetry(filePath).catch((error: unknown) => {
              reportLock("resolving the lock key", error)
              return undefined
            })
            if (real !== undefined) return real
            const parent = await realpathWithRetry(path.dirname(filePath))
              .catch((error: unknown) => {
                reportLock("resolving the lock key parent", error)
                return path.dirname(filePath)
              })
            return path.join(parent, path.basename(filePath))
          },
          catch: (error) => {
            reportLock("resolving the lock key", error)
            return path.resolve(filePath)
          }
        }).pipe(
          Effect.orElseSucceed((error) => {
            reportLock("resolving the lock key", error)
            return path.resolve(filePath)
          })
        )
        const lock = getOrCreateLock(key)
        lock.active += 1
        return yield* lock.sem.withPermit(program).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lock.active -= 1
              if (lock.active === 0 && locks.get(key) === lock) {
                locks.delete(key)
              }
            })
          )
        )
      })
  }
}

export const makeNotebookFileService = buildFileService

export const _schemas: { readonly NotebookSchema: typeof NotebookSchema } = { NotebookSchema }
