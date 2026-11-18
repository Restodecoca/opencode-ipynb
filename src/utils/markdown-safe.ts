import { stripAnsi } from "./ansi.js"

export const sanitizeInline = (text: string): string =>
  stripAnsi(text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[`<>]/g, "'")

const OPENER = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/
const CLOSER = /^[ ]{0,3}(`{3,}|~{3,})[ \t]*$/
const MAX_FENCE = 32

interface OpenFence {
  readonly char: string
  readonly length: number
}

const scanOpenFence = (text: string): OpenFence | undefined => {
  let open: OpenFence | undefined
  for (const line of text.split("\n")) {
    if (open === undefined) {
      const opener = OPENER.exec(line)
      if (opener === null) continue
      const run = opener[1]!
      if (run[0] === "`" && opener[2]!.includes("`")) continue
      open = { char: run[0]!, length: Math.min(run.length, MAX_FENCE) }
    } else {
      const closer = CLOSER.exec(line)
      if (closer === null) continue
      const run = closer[1]!
      if (run[0] === open.char && run.length >= open.length) open = undefined
    }
  }
  return open
}

export const truncateMarkdown = (
  text: string,
  maxChars: number,
  hint: string
): string => {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (normalized.length <= maxChars) return normalized
  const budget = Math.max(0, maxChars - hint.length - MAX_FENCE * 2)
  let cut = normalized.slice(0, budget)
  cut = cut.replace(/`{33,}/g, "```").replace(/~{33,}/g, "~~~")
  const open = scanOpenFence(cut)
  const closing =
    open === undefined ? "" : `\n${open.char.repeat(open.length)}\n`
  const result = `${cut.replace(/\n$/, "")}${closing}${hint}`
  return result.length <= maxChars ? result : result.slice(0, maxChars)
}
