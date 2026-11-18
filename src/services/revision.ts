import { createHash } from "node:crypto"
import { Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import type { NotebookFileServiceShape } from "./NotebookFileService.js"
import { realpathWithRetry } from "../utils/realpath.js"

type RevisionError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | PathOutsideWorktreeError

export const pinRealPath = (filePath: string): Effect.Effect<string, never> =>
  Effect.promise(() => realpathWithRetry(filePath).catch(() => filePath))

export const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

export const readRevision = (
  fileSvc: NotebookFileServiceShape,
  absPath: string
): Effect.Effect<string, RevisionError> =>
  Effect.map(fileSvc.readText(absPath), contentHash)

// `writeAtomic` compares `previousText` against a re-read under the lock, so
// this check is redundant for correctness. It is kept on purpose: it runs before
// the permission prompt, so a conflict is refused before the user is asked to
// approve a write, and it narrows the window in which an external edit can slip
// between the prompt and the write. Measured cost: 34 ms on a 17 MB notebook
// (read + SHA-256), against ~500 ms for the write itself.
export const assertRevisionUnchanged = (
  fileSvc: NotebookFileServiceShape,
  absPath: string,
  expected: string
): Effect.Effect<void, RevisionError> =>
  Effect.gen(function* () {
    const current = yield* readRevision(fileSvc, absPath)
    if (current !== expected) {
      return yield* new NotebookValidationError({
        message: "notebook changed while the tool was editing it",
        filePath: absPath,
        issues: [
          "the notebook was modified externally; re-read it and retry the edit"
        ]
      })
    }
  })
