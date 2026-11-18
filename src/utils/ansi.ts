const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const ANSI_TEST_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/
const CARRIAGE_RETURN_PATTERN = /\r/g
const OSC_MAX_BODY = 256

const terminatorEnd = (text: string, from: number, limit: number): number => {
  for (let index = from; index <= limit; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x07) return index + 1
    if (code === 0x1b && text.charCodeAt(index + 1) === 0x5c) return index + 2
  }
  return -1
}

const stripOscSequences = (text: string): string => {
  let result = ""
  let cursor = 0
  let start = text.indexOf("\u001b]")
  while (start >= 0) {
    const bodyStart = start + 2
    const limit = Math.min(text.length - 1, bodyStart + OSC_MAX_BODY)
    const end = terminatorEnd(text, bodyStart, limit)
    if (end < 0) {
      start = text.indexOf("\u001b]", start + 1)
      continue
    }
    result += text.slice(cursor, start)
    cursor = end
    start = text.indexOf("\u001b]", cursor)
  }
  return cursor === 0 ? text : result + text.slice(cursor)
}

export const stripAnsi = (text: string): string =>
  text.replace(ANSI_PATTERN, "").replace(CARRIAGE_RETURN_PATTERN, "")

export const sanitizeTerminal = (text: string): string =>
  stripOscSequences(text.replace(/\r\n?/g, "\n"))
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")

export const hasAnsi = (text: string): boolean => ANSI_TEST_PATTERN.test(text)
