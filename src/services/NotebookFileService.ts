import { Effect, Semaphore } from "effect"
import { randomUUID } from "node:crypto"
import * as fsp from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  NotebookWriteError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import { NotebookSchema, applyNotebookDefaults, type NotebookRaw } from "../domain/notebook.js"
import {
  DEFAULT_NOTEBOOK_FORMAT,
  detectNotebookFormat,
  rewriteNotebookText,
  safeParseJson,
  stringifyNotebook,
  type NotebookFormat
} from "../utils/json.js"
import { MAX_NOTEBOOK_BYTES } from "../utils/limits.js"
import { replaceFile } from "../utils/atomic-replace.js"

interface NotebookFileServiceOptions {
  /** When set, real paths are pinned and checked against this worktree. */
  readonly worktree?: string
}

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

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
    NotebookNotFoundError | NotebookValidationError | PathOutsideWorktreeError
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
    void,
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

// The lock registry is module-scoped on purpose: buildServices() creates a
// fresh NotebookFileService for every tool call, so instance-local locks would
// not serialize concurrent edits of the same notebook.
interface FileLock {
  readonly sem: Semaphore.Semaphore
  active: number
}

const locks = new Map<string, FileLock>()

const buildFileService = (
  options: NotebookFileServiceOptions = {}
): NotebookFileServiceShape => {
  const worktree = options.worktree
  const resolveInside = async (filePath: string): Promise<string> => {
    if (worktree === undefined) return filePath
    const root = await fsp.realpath(worktree).catch(() => worktree)
    const real = await fsp.realpath(filePath)
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
    NotebookNotFoundError | NotebookValidationError | PathOutsideWorktreeError
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
          // Open without following the final path component and with
          // O_NONBLOCK: if the path is swapped to a FIFO between stat and
          // open, the open does not hang and fstat rejects it.
          const noFollow =
            process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW
          const nonBlock =
            process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK
          const root =
            worktree === undefined
              ? undefined
              : await fsp.realpath(worktree).catch(() => worktree)
          // When confinement is enabled, resolved is already the real path.
          // Opening it directly with O_NOFOLLOW rejects a link swapped in
          // after resolveInside. Without confinement, resolve the alias first.
          const target =
            worktree === undefined
              ? await fsp.realpath(resolved).catch(() => resolved)
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
            return await handle.readFile({ encoding: "utf8" })
          } finally {
            await handle.close().catch(() => {})
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

  const parseAndValidate = (
    text: string,
    filePath: string
  ): Effect.Effect<NotebookRaw, NotebookParseError | NotebookValidationError> =>
    Effect.gen(function* () {
      const raw = yield* safeParseJson(text, filePath)
      const parsed = NotebookSchema.safeParse(raw)
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
      return applyNotebookDefaults(raw)
    })

  const readExistingText = (
    filePath: string
  ): Effect.Effect<string | undefined, never> =>
    Effect.tryPromise({
      try: async () => {
        const stat = await fsp.stat(filePath)
        if (!stat.isFile() || stat.size > MAX_NOTEBOOK_BYTES) return undefined
        return await fsp.readFile(filePath, { encoding: "utf8" })
      },
      catch: () => undefined
    }).pipe(Effect.orElseSucceed(() => undefined))

  const writeAtomic = (
    filePath: string,
    notebook: NotebookRaw,
    options?: {
      readonly noFollowFinal?: boolean
      readonly format?: NotebookFormat
      readonly previousText?: string
    }
  ): Effect.Effect<
    void,
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
      const serialized =
        previousText === undefined
          ? stringifyNotebook(notebook, format)
          : rewriteNotebookText(previousText, notebook, format)
      if (Buffer.byteLength(serialized, "utf8") > MAX_NOTEBOOK_BYTES) {
        return yield* new NotebookValidationError({
          message: `refusing to write a notebook larger than ${MAX_NOTEBOOK_BYTES} bytes`,
          filePath,
          issues: ["split the notebook or reduce large outputs"]
        })
      }
      yield* parseAndValidate(serialized, filePath)
      yield* Effect.tryPromise({
        try: async () => {
          const dir = path.dirname(filePath)
          const root =
            worktree === undefined
              ? undefined
              : await fsp.realpath(worktree).catch(() => worktree)
          if (root !== undefined) {
            // Resolve the deepest existing ancestor before mkdir. This accepts
            // a lexical session path whose real target is inside the worktree
            // while still rejecting an ancestor symlink that escapes it.
            let probe = dir
            let ancestorReal: string | undefined
            for (let depth = 0; depth < 128; depth += 1) {
              ancestorReal = await fsp.realpath(probe).catch(() => undefined)
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
              ? await fsp.realpath(dir).catch(() => dir)
              : await (async () => {
                  const real = await fsp.realpath(dir)
                  if (!inside(root!, real)) {
                    throw new PathOutsideWorktreeError({
                      message: "path resolves outside of the worktree (symlink)",
                      filePath,
                      worktree: root!
                    })
                  }
                  return real
                })()
          // Resolve an existing target even without a worktree root so a
          // symlinked notebook is edited in place instead of replaced.
          const fileReal =
            options?.noFollowFinal === true
              ? undefined
              : await fsp.realpath(filePath).catch(() => undefined)
          if (root !== undefined && fileReal !== undefined && !inside(root, fileReal)) {
            throw new PathOutsideWorktreeError({
              message: "path resolves outside of the worktree (symlink)",
              filePath,
              worktree: root
            })
          }
          // Writing a symlink alias must update the target, not replace the
          // link with a second notebook.
          const target = fileReal ?? path.join(dirReal, path.basename(filePath))
          const targetDir = path.dirname(target)
          const targetStat = await fsp.stat(target).catch(() => undefined)
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
              const current = await fsp
                .readFile(target, { encoding: "utf8" })
                .catch(() => undefined)
              if (current !== undefined && current !== options.previousText) {
                throw new NotebookValidationError({
                  message: "notebook changed while the tool was editing it",
                  filePath,
                  issues: [
                    "the notebook was modified externally; re-read it and retry the edit"
                  ]
                })
              }
            }
            await fsp.writeFile(tmp, serialized, {
              encoding: "utf8",
              flag: "wx",
              mode: existingMode ?? 0o600
            })
            if (existingMode !== undefined) await fsp.chmod(tmp, existingMode)
            await replaceFile(tmp, target)
          } catch (err) {
            await fsp.unlink(tmp).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== "ENOENT") throw e
            })
            throw err
          }
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
        const key = yield* Effect.tryPromise({
          try: async () => {
            const real = await fsp.realpath(filePath).catch(() => undefined)
            if (real !== undefined) return real
            const parent = await fsp
              .realpath(path.dirname(filePath))
              .catch(() => path.dirname(filePath))
            return path.join(parent, path.basename(filePath))
          },
          catch: () => path.resolve(filePath)
        }).pipe(Effect.orElseSucceed(() => path.resolve(filePath)))
        const lock = getOrCreateLock(key)
        lock.active += 1
        return yield* lock.sem.withPermit(program).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lock.active -= 1
              // Do not keep a semaphore forever for a one-off path. A new
              // caller either reuses it before this check or creates a new one.
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
