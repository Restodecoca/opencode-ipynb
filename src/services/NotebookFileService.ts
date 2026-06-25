import { Context, Effect } from "effect"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import {
  isNotebookError,
  LockError,
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  NotebookWriteError
} from "../domain/errors.js"
import { NotebookSchema, type NotebookRaw, cellSource } from "../domain/notebook.js"
import { safeParseJson, stringifyNotebook } from "../utils/json.js"
import { unwrapFiberFailure } from "../utils/fiber.js"

interface FileSemaphore {
  withPermits: <A, E, R>(
    filePath: string,
    program: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | LockError, R>
}

const describeUnknown = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

const makeSemaphore = (): FileSemaphore => {
  let chain: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }
  return {
    withPermits: <A, E, R>(
      filePath: string,
      program: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E | LockError, R> =>
      Effect.tryPromise({
        try: () =>
          enqueue(() =>
            Effect.runPromise(program as Effect.Effect<A, E, never>).then(
              (a) => a as A,
              (e) => {
                throw unwrapFiberFailure<E>(e)
              }
            )
          ),
        catch: (err): E | LockError => {
          if (isNotebookError(err)) {
            return err as E
          }
          const detail = describeUnknown(err)
          return new LockError({
            message: `Lock error: ${detail}`,
            filePath,
            cause: detail
          })
        }
      }) as Effect.Effect<A, E | LockError, R>
  }
}

export interface NotebookFileServiceShape {
  readonly read: (
    filePath: string
  ) => Effect.Effect<
    NotebookRaw,
    NotebookNotFoundError | NotebookParseError | NotebookValidationError
  >
  readonly readText: (filePath: string) => Effect.Effect<string, NotebookNotFoundError>
  readonly writeAtomic: (
    filePath: string,
    notebook: NotebookRaw
  ) => Effect.Effect<
    void,
    NotebookParseError | NotebookValidationError | NotebookWriteError
  >
  readonly withFileLock: <A, E, R>(
    filePath: string,
    program: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E | LockError, R>
}

export class NotebookFileService extends Context.Tag("@ipynb/NotebookFileService")<
  NotebookFileService,
  NotebookFileServiceShape
>() {}

const buildFileService = (): NotebookFileServiceShape => {
  const locks = new Map<string, FileSemaphore>()

  const getOrCreateLock = (key: string): FileSemaphore => {
    const existing = locks.get(key)
    if (existing) {
      return existing
    }
    const sem = makeSemaphore()
    locks.set(key, sem)
    return sem
  }

  const readText = (filePath: string): Effect.Effect<string, NotebookNotFoundError> =>
    Effect.tryPromise({
      try: async () => {
        try {
          return await fsp.readFile(filePath, "utf8")
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
        err instanceof NotebookNotFoundError
          ? err
          : new NotebookNotFoundError({
              message: err instanceof Error ? err.message : String(err),
              filePath
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
      const nb = parsed.data
      if (nb.nbformat < 4) {
        return yield* new NotebookValidationError({
          message: `unsupported nbformat ${nb.nbformat} (must be >= 4)`,
          filePath,
          issues: [`nbformat ${nb.nbformat} < 4`]
        })
      }
      for (const [idx, cell] of nb.cells.entries()) {
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
      return nb
    })

  const writeAtomic = (
    filePath: string,
    notebook: NotebookRaw
  ): Effect.Effect<
    void,
    NotebookParseError | NotebookValidationError | NotebookWriteError
  > =>
    Effect.gen(function* () {
      yield* parseAndValidate(stringifyNotebook(notebook), filePath)
      yield* Effect.tryPromise({
        try: async () => {
          const dir = path.dirname(filePath)
          await fsp.mkdir(dir, { recursive: true })
          const tmp = path.join(
            dir,
            `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
          )
          await fsp.writeFile(tmp, stringifyNotebook(notebook), "utf8")
          try {
            await fsp.rename(tmp, filePath)
          } catch (err) {
            await fsp.unlink(tmp).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== "ENOENT") throw e
            })
            throw err
          }
        },
        catch: (err) =>
          new NotebookWriteError({
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
    writeAtomic,
    withFileLock: (filePath, program) => {
      const key = path.resolve(filePath)
      const sem = getOrCreateLock(key)
      return sem.withPermits(filePath, program)
    }
  }
}

export const makeNotebookFileService = buildFileService

export { cellSource }
export const _schemas: { readonly NotebookSchema: typeof NotebookSchema } = { NotebookSchema }
