import { createHash } from "node:crypto"
import { promises as fsp } from "node:fs"
import { Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import type { NotebookFileServiceShape } from "./NotebookFileService.js"

type RevisionError =
  | NotebookNotFoundError
  | NotebookValidationError
  | PathOutsideWorktreeError

/** Resolve the canonical target before prompting; I/O uses this pinned path. */
export const pinRealPath = (filePath: string): Effect.Effect<string, never> =>
  Effect.promise(() => fsp.realpath(filePath).catch(() => filePath))

/** SHA-256 of the exact bytes on disk, used to detect external edits. */
export const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

export const readRevision = (
  fileSvc: NotebookFileServiceShape,
  absPath: string
): Effect.Effect<string, RevisionError> =>
  Effect.map(fileSvc.readText(absPath), contentHash)

/**
 * Fail instead of overwriting a notebook that changed while the tool held it
 * open (for example during an interactive permission prompt).
 */
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
