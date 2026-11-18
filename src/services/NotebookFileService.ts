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
import { MAX_JSON_DEPTH, type PatchFailureReason, type WriteMode } from "../utils/json.js"
import { pathInside } from "../utils/paths.js"
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
import { afterRenameHook, beforeRenameHook } from "../utils/rename-hook.js"

export interface NotebookFileServiceOptions {
  readonly worktree?: string
  readonly warningSink?: WarningSink | undefined
  readonly signal?: AbortSignal | undefined
}

// A parent-directory swap can move the temp file along with the directory, so
// the writer's remembered path stops existing. The temp name carries a UUID, so
// it is unambiguous: look in the original directory, its parent, and each
// sibling directory of the parent (a swapped directory is normally a sibling).
// Bounded and cheap compared with losing the full notebook as a hidden .tmp.
const locateTemp = async (
  known: string,
  base: string,
  sink: WarningSink | undefined
): Promise<string | undefined> => {
  const exists = (candidate: string): Promise<boolean> =>
    fsp.stat(candidate).then(
      (stat) => stat.isFile(),
      () => false
    )
  if (await exists(known)) return known
  const parent = path.dirname(known)
  const grandParent = path.dirname(parent)
  const candidates = [path.join(grandParent, base)]
  const siblings = await fsp.readdir(grandParent, { withFileTypes: true }).catch((error: unknown) => {
    sink?.add(
      warningFrom(
        "temp-unlink",
        error,
        `could not list ${grandParent} while looking for ${base}`
      )
    )
    return []
  })
  for (const entry of siblings) {
    if (entry.isDirectory()) candidates.push(path.join(grandParent, entry.name, base))
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
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
      readonly trusted?: boolean
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
  const abortSignal = options.signal
  const assertNotAborted = (): void => {
    if (abortSignal?.aborted === true) {
      throw new NotebookValidationError({
        message: "the request was cancelled; nothing was changed",
        filePath: "",
        issues: ["the tool call was cancelled by the host"]
      })
    }
  }
  const resolveInside = async (filePath: string): Promise<string> => {
    if (worktree === undefined) return filePath
    const root = await realpathWithRetry(worktree).catch(() => worktree)
    const real = await realpathWithRetry(filePath)
    if (!pathInside(root, real)) {
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
          if (root !== undefined && !pathInside(root, target)) {
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
        const describe = (
          issue: { path: PropertyKey[]; message: string; code?: string; errors?: unknown },
          prefix: string
        ): string[] => {
          const path = [prefix, ...issue.path.map(String)].filter(Boolean).join(".")
          if (issue.code === "invalid_union" && Array.isArray(issue.errors)) {
            const nested = (issue.errors as Array<Array<{ path: PropertyKey[]; message: string; code?: string; errors?: unknown }>>)
              .flat()
              .flatMap((inner) => describe(inner, path))
            return nested.length > 0 ? nested : [`${path || "<root>"}: ${issue.message}`]
          }
          return [`${path || "<root>"}: ${issue.message}`]
        }
        const issues = parsed.error.issues.flatMap((issue) => describe(issue, ""))
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
      readonly trusted?: boolean
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
      const rewrite = yield* Effect.try({
        try: () =>
          previousText === undefined
            ? { text: stringifyNotebook(notebook, format), mode: "fallback" as const, reason: undefined }
            : rewriteNotebookTextDetailed(previousText, notebook, format),
        catch: (error) =>
          new NotebookValidationError({
            message:
              error instanceof RangeError
                ? `notebook nesting exceeds the supported depth of ${MAX_JSON_DEPTH}`
                : `the notebook cannot be serialized to JSON: ${error instanceof Error ? error.message : String(error)}`,
            filePath,
            issues: [
              error instanceof RangeError
                ? "reduce the nesting of the metadata or output values and retry"
                : "remove values JSON cannot represent (undefined, BigInt, cyclic references) and retry"
            ]
          })
      })
      if (rewrite.reason === "too-deep") {
        return yield* new NotebookValidationError({
          message: `notebook nesting exceeds the supported depth of ${MAX_JSON_DEPTH}`,
          filePath,
          issues: [
            "reduce the nesting of the metadata or output values and retry"
          ]
        })
      }
      const serialized = rewrite.text
      if (Buffer.byteLength(serialized, "utf8") > MAX_NOTEBOOK_BYTES) {
        return yield* new NotebookValidationError({
          message: `refusing to write a notebook larger than ${MAX_NOTEBOOK_BYTES} bytes`,
          filePath,
          issues: ["split the notebook or reduce large outputs"]
        })
      }
      if (options?.trusted !== true) {
        yield* validateNotebookShape(notebook, filePath)
      }
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
            if (ancestorReal === undefined || !pathInside(root, ancestorReal)) {
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
                  if (!pathInside(root!, real)) {
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
          if (root !== undefined && fileReal !== undefined && !pathInside(root, fileReal)) {
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
          // The parent-swap branch below can move the temp to a new directory
          // before the replace fails; cleanup must unlink wherever it actually
          // lives, or the full notebook content is left behind as a hidden .tmp.
          let liveTmp = tmp
          const extraCleanup: string[] = []
          try {
            if (options?.previousText !== undefined) {
              let current: string | undefined
              try {
                current = await fsp.readFile(target, { encoding: "utf8" })
              } catch (revisionError) {
                const code = (revisionError as NodeJS.ErrnoException).code
                if (code !== "ENOENT" && code !== "ENOTDIR") {
                  warningSink?.add(
                    warningFrom(
                      "revision-check",
                      revisionError,
                      "could not verify the notebook revision before writing"
                    )
                  )
                  throw new NotebookValidationError({
                    message:
                      "the notebook revision could not be verified before the write",
                    filePath,
                    issues: [
                      "the file could not be read; fix its permissions or remove it explicitly"
                    ]
                  })
                }
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
            assertNotAborted()
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
            const freshDir = await probeRealpath(warningSink, path.dirname(target))
            await beforeRenameHook(target)
            if (freshDir === undefined) {
              throw new NotebookWriteError({
                message: "the notebook directory disappeared before the write",
                filePath
              })
            }
            if (root !== undefined && !pathInside(root, freshDir)) {
              throw new PathOutsideWorktreeError({
                message: "path resolves outside of the worktree (symlink swap)",
                filePath,
                worktree: root
              })
            }
            const rechecked = await probeRealpath(warningSink, path.dirname(target))
            if (rechecked === undefined || (root !== undefined && !pathInside(root, rechecked))) {
              throw new PathOutsideWorktreeError({
                message: "path resolves outside of the worktree (symlink swap)",
                filePath,
                worktree: root ?? ""
              })
            }
            const freshTarget = path.join(rechecked, path.basename(target))
            if (freshTarget !== target) {
              const besideFresh = path.join(freshDir, path.basename(tmp))
              const moved = await fsp.rename(tmp, besideFresh).then(
                () => {
                  liveTmp = besideFresh
                  return besideFresh
                },
                () => tmp
              )
              // If the temp could not follow the directory (the parent is gone
              // or a different filesystem), it is still at the original path in
              // the moved-aside directory; record every place it may live so the
              // failure cleanup removes it.
              extraCleanup.push(path.join(path.dirname(target), path.basename(tmp)))
              await replaceFile(moved, freshTarget, warningSink)
            } else {
              await replaceFile(tmp, target, warningSink)
            }
            await afterRenameHook(freshTarget)
            const finalStat = await fsp.stat(freshTarget).catch((error: unknown) => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                warningSink?.add(
                  warningFrom(
                    "revision-check",
                    error,
                    `inspecting ${freshTarget} after the write`
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
            if (finalStat === undefined) {
              throw new NotebookValidationError({
                message: "the notebook disappeared right after the write",
                filePath,
                issues: [
                  "another process removed the file; re-create it and retry the edit"
                ]
              })
            }
            if (
              tempStat !== undefined &&
              tempStat.ino === finalStat.ino
            ) {
              const landed = await fsp.readFile(freshTarget, "utf8").catch((error: unknown) => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                  warningSink?.add(
                    warningFrom("revision-check", error, `reading ${freshTarget} after the write`)
                  )
                }
                return undefined
              })
              if (landed !== undefined && landed !== serialized) {
                throw new NotebookValidationError({
                  message:
                    "another process rewrote the notebook right after the write",
                  filePath,
                  issues: [
                    "the notebook was written concurrently; re-read it and retry the edit"
                  ]
                })
              }
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
            const known = [...new Set([liveTmp, tmp, ...extraCleanup])]
            const found = new Set<string>()
            for (const candidate of known) {
              try {
                await fsp.unlink(candidate)
                found.add(candidate)
              } catch (unlinkError) {
                const code = (unlinkError as NodeJS.ErrnoException).code
                if (code !== "ENOENT") {
                  warningSink?.add(
                    warningFrom("temp-unlink", unlinkError, `left ${candidate}`)
                  )
                  found.add(candidate)
                }
              }
            }
            // A parent swap can leave a second copy behind (the symlink target and
            // the moved-aside directory). Sweep by the unique temp name every time,
            // not only when the remembered paths failed to unlink.
            const base = path.basename(tmp)
            const relocated = await locateTemp(tmp, base, warningSink)
            if (relocated !== undefined && !found.has(relocated)) {
              try {
                await fsp.unlink(relocated)
                found.add(relocated)
              } catch (unlinkError) {
                warningSink?.add(
                  warningFrom("temp-unlink", unlinkError, `left ${relocated}`)
                )
              }
            }
            if (found.size === 0 && relocated === undefined) {
              warningSink?.add(
                warningFrom(
                  "temp-unlink",
                  new Error(`could not locate ${base} to remove it`),
                  `a temp file from the failed write may remain in the worktree`
                )
              )
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
