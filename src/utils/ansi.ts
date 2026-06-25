const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const CARRIAGE_RETURN_PATTERN = /\r/g

export const stripAnsi = (text: string): string =>
  text.replace(ANSI_PATTERN, "").replace(CARRIAGE_RETURN_PATTERN, "")

export const hasAnsi = (text: string): boolean => ANSI_PATTERN.test(text)
