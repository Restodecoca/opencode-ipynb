import { Effect } from "effect"
import { NotebookParseError } from "../domain/errors.js"

export const safeParseJson = (
  text: string,
  filePath: string
): Effect.Effect<unknown, NotebookParseError> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (err) =>
      new NotebookParseError({
        message: err instanceof Error ? err.message : String(err),
        filePath
      })
  })

export const stringifyNotebook = (notebook: unknown): string =>
  `${JSON.stringify(notebook, null, 1)}\n`
