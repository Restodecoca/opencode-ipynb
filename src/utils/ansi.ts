const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const CARRIAGE_RETURN_PATTERN = /\r/g

export const stripAnsi = (text: string): string =>
  text.replace(ANSI_PATTERN, "").replace(CARRIAGE_RETURN_PATTERN, "")

/** Remove terminal control sequences/bytes while keeping newlines and tabs. */
export const sanitizeTerminal = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    // Bound the OSC payload: an unterminated introducer must not scan the
    // whole (up to 50 MB) notebook for every occurrence.
    .replace(/\u001b\][^\u0007]{0,256}(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")

export const hasAnsi = (text: string): boolean => ANSI_PATTERN.test(text)
