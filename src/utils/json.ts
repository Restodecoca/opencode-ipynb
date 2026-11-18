import { Effect } from "effect"
import { NotebookParseError } from "../domain/errors.js"
import {
  formatJsonValue,
  patchJsonTextDetailed,
  type JsonTextStyle,
  type PatchFailureReason
} from "./json-patch.js"

export type { PatchFailureReason }

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

export interface NotebookFormat extends JsonTextStyle {
  readonly trailingNewline: boolean
}

export const DEFAULT_NOTEBOOK_FORMAT: NotebookFormat = {
  unit: " ",
  newline: "\n",
  itemSeparator: ", ",
  keySeparator: ": ",
  ensureAscii: false,
  trailingNewline: true
}

const indentUnitOf = (prefix: string): string => {
  const space = /^( +)/.exec(prefix)
  if (space !== null) return " ".repeat(Math.max(1, space[1]!.length))
  if (prefix.startsWith("\t")) return "\t"
  return " "
}

const hasAsciiEscapes = (text: string): boolean => {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "\\" || text[index + 1] !== "u") continue
    const hex = text.slice(index + 2, index + 6)
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) continue
    if (text[index - 1] === "\\") {
      index += 5
      continue
    }
    if (Number.parseInt(hex, 16) > 0x7e) return true
  }
  return false
}

const separatorOf = (text: string): string => {
  const multiline = text.indexOf("\n") !== -1
  if (multiline) return ","
  const inline = /,\s*/.exec(text)
  return inline !== null && /,\s/.test(inline[0]) ? ", " : ","
}

const keySeparatorOf = (text: string): string => {
  const match = /"(?:[^"\\]|\\.)*"([ \t]*):(\s*)/.exec(text)
  if (match === null) return ": "
  return `:${match[2]}`
}

export const detectNotebookFormat = (text: string): NotebookFormat => {
  const newline: "\n" | "\r\n" = text.indexOf("\r\n") === -1 ? "\n" : "\r\n"
  const trailingNewline = text.endsWith("\n")
  const itemSeparator = separatorOf(text)
  const keySeparator = keySeparatorOf(text)
  const firstBreak = text.indexOf("\n")
  const body = trailingNewline ? text.slice(0, -1) : text
  if (firstBreak === -1) {
    return {
      unit: " ",
      newline,
      itemSeparator,
      keySeparator,
      ensureAscii: hasAsciiEscapes(text),
      trailingNewline
    }
  }
  const secondBreak = text.indexOf("\n", firstBreak + 1)
  const secondLine = text.slice(
    firstBreak + 1,
    secondBreak === -1 ? text.length : secondBreak
  )
  return {
    unit: indentUnitOf(/^([ \t]+)\S/.exec(secondLine)?.[1] ?? " "),
    newline,
    itemSeparator,
    keySeparator,
    ensureAscii: hasAsciiEscapes(body),
    trailingNewline
  }
}

export const stringifyNotebook = (
  notebook: unknown,
  format: NotebookFormat = DEFAULT_NOTEBOOK_FORMAT
): string => {
  const body = formatJsonValue(notebook, format, true)
  return format.trailingNewline ? `${body}${format.newline}` : body
}

export type WriteMode = "patched" | "fallback"

export interface RewriteResult {
  readonly text: string
  readonly mode: WriteMode
  readonly reason?: PatchFailureReason
}

export const rewriteNotebookTextDetailed = (
  previousText: string,
  notebook: unknown,
  format: NotebookFormat
): RewriteResult => {
  const patched = patchJsonTextDetailed(previousText, notebook, { style: format })
  if (patched.text !== undefined) {
    return { text: patched.text, mode: "patched" }
  }
  return {
    text: stringifyNotebook(notebook, format),
    mode: "fallback",
    ...(patched.reason === undefined ? {} : { reason: patched.reason })
  }
}

export const rewriteNotebookText = (
  previousText: string,
  notebook: unknown,
  format: NotebookFormat
): string => rewriteNotebookTextDetailed(previousText, notebook, format).text
