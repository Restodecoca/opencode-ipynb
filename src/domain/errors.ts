import { Data } from "effect"

export type NotebookErrorKind =
  | "NotebookNotFound"
  | "NotebookParse"
  | "NotebookValidation"
  | "CellIndexOutOfBounds"
  | "NotebookWrite"
  | "NotebookExecution"
  | "PythonRunner"
  | "PermissionDenied"
  | "PathOutsideWorktree"
  | "NotebookNotImplemented"

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
  readonly cause?: unknown
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

export type NotebookError =
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | CellIndexOutOfBoundsError
  | NotebookWriteError
  | NotebookExecutionError
  | PythonRunnerError
  | PermissionDeniedError
  | PathOutsideWorktreeError
  | NotebookNotImplementedError

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
      case "NotebookValidation": {
        const preview = e.issues.slice(0, 3).join("; ")
        const more =
          e.issues.length > 3 ? `; +${e.issues.length - 3} more` : ""
        return `Notebook ${e.filePath} is invalid: ${e.message} (${e.issues.length} issue(s)${preview.length > 0 ? `: ${preview}${more}` : ""})`
      }
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
      case "PathOutsideWorktree":
        return `Path ${e.filePath} is outside worktree ${e.worktree}: ${e.message}`
      case "NotebookNotImplemented":
        return `Not implemented yet: ${e.feature} (${e.message})`
    }
  }
  if (e instanceof Error) return e.message
  return String(e)
}
