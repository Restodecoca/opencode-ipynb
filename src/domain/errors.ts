import { Data, Effect } from "effect"

export type NotebookErrorKind =
  | "NotebookNotFound"
  | "NotebookParse"
  | "NotebookValidation"
  | "CellIndexOutOfBounds"
  | "NotebookWrite"
  | "NotebookExecution"
  | "PythonRunner"
  | "PermissionDenied"
  | "OutputTooLarge"
  | "PathOutsideWorktree"
  | "NotebookNotImplemented"
  | "NotebookAttachment"
  | "LockError"

export class NotebookNotFoundError extends Data.TaggedError("NotebookNotFound")<{
  readonly message: string
  readonly filePath: string
}> {}

export class NotebookParseError extends Data.TaggedError("NotebookParse")<{
  readonly message: string
  readonly filePath: string
}> {}

export class NotebookValidationError extends Data.TaggedError("NotebookValidation")<{
  readonly message: string
  readonly filePath: string
  readonly issues: ReadonlyArray<string>
}> {}

export class CellIndexOutOfBoundsError extends Data.TaggedError("CellIndexOutOfBounds")<{
  readonly message: string
  readonly filePath: string
  readonly cellIndex: number
  readonly total: number
}> {}

export class NotebookWriteError extends Data.TaggedError("NotebookWrite")<{
  readonly message: string
  readonly filePath: string
}> {}

export class NotebookExecutionError extends Data.TaggedError("NotebookExecution")<{
  readonly message: string
  readonly filePath: string
  readonly cellIndex: number
}> {}

export class PythonRunnerError extends Data.TaggedError("PythonRunner")<{
  readonly message: string
  readonly detail: string
}> {}

export class PermissionDeniedError extends Data.TaggedError("PermissionDenied")<{
  readonly message: string
  readonly action: string
}> {}

export class OutputTooLargeError extends Data.TaggedError("OutputTooLarge")<{
  readonly message: string
  readonly cellIndex: number
  readonly bytes: number
}> {}

export class PathOutsideWorktreeError extends Data.TaggedError("PathOutsideWorktree")<{
  readonly message: string
  readonly filePath: string
  readonly worktree: string
}> {}

export class NotebookNotImplementedError extends Data.TaggedError("NotebookNotImplemented")<{
  readonly message: string
  readonly feature: string
}> {}

export class NotebookAttachmentError extends Data.TaggedError("NotebookAttachment")<{
  readonly message: string
  readonly mime: string
}> {}

export class LockError extends Data.TaggedError("LockError")<{
  readonly message: string
  readonly filePath: string
  readonly cause: string
}> {}

export type NotebookError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | CellIndexOutOfBoundsError
  | NotebookWriteError
  | NotebookExecutionError
  | PythonRunnerError
  | PermissionDeniedError
  | OutputTooLargeError
  | PathOutsideWorktreeError
  | NotebookNotImplementedError
  | NotebookAttachmentError
  | LockError

export const isNotebookError = (u: unknown): u is NotebookError =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  typeof (u as { _tag: unknown })._tag === "string"

export const errorToMessage = (e: unknown): string => {
  if (isNotebookError(e)) {
    switch (e._tag) {
      case "NotebookNotFound":
        return `Notebook not found: ${e.filePath} (${e.message})`
      case "NotebookParse":
        return `Failed to parse notebook ${e.filePath}: ${e.message}`
      case "NotebookValidation":
        return `Notebook ${e.filePath} is invalid: ${e.message} (${e.issues.length} issue(s))`
      case "CellIndexOutOfBounds":
        return `Cell index ${e.cellIndex} is out of bounds (0..${Math.max(0, e.total - 1)}) in ${e.filePath}`
      case "NotebookWrite":
        return `Failed to write notebook ${e.filePath}: ${e.message}`
      case "NotebookExecution":
        return `Execution failed in ${e.filePath} at cell ${e.cellIndex}: ${e.message}`
      case "PythonRunner":
        return `Python runner error: ${e.message} (${e.detail})`
      case "PermissionDenied":
        return `Permission denied for action "${e.action}": ${e.message}`
      case "OutputTooLarge":
        return `Output too large at cell ${e.cellIndex}: ${e.bytes} bytes (${e.message})`
      case "PathOutsideWorktree":
        return `Path ${e.filePath} is outside worktree ${e.worktree}: ${e.message}`
      case "NotebookNotImplemented":
        return `Not implemented yet: ${e.feature} (${e.message})`
      case "NotebookAttachment":
        return `Failed to save attachment (${e.mime}): ${e.message}`
      case "LockError":
        return `Lock error on ${e.filePath}: ${e.message} (cause: ${e.cause})`
    }
  }
  if (e instanceof Error) return e.message
  return String(e)
}

export const failWith = <E extends NotebookError>(e: E) => Effect.fail(e)
