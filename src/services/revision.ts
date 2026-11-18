import { createHash } from "node:crypto"
import { promises as fsp } from "node:fs"
import { Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import type { NotebookFileServiceShape } from "./NotebookFileService.js"

type RevisionError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | PathOutsideWorktreeError

export const pinRealPath = (filePath: string): Effect.Effect<string, never> =>
  Effect.promise(() => fsp.realpath(filePath).catch(() => filePath))

export const contentHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex")

export const readRevision = (
  fileSvc: NotebookFileServiceShape,
  absPath: string
): Effect.Effect<string, RevisionError> =>
  Effect.map(fileSvc.readText(absPath), contentHash)

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
