import { formatHint, type TruncationHintKey } from "./i18n.js"

export interface TruncateResult {
  readonly text: string
  readonly truncated: boolean
  readonly originalLength: number
  readonly finalLength: number
}

export interface TruncateHintSpec {
  readonly key: TruncationHintKey
  readonly paramName: string
  readonly locale?: string | undefined
}

export type TruncateHint = string | TruncateHintSpec

const isStructuredHint = (hint: TruncateHint): hint is TruncateHintSpec =>
  typeof hint === "object" && hint !== null

const buildSuffix = (hint: TruncateHint, maxChars: number): string => {
  if (isStructuredHint(hint)) {
    return "\n" + formatHint(
      hint.key,
      { paramName: hint.paramName, maxChars },
      hint.locale
    )
  }
  return `\n... (${hint}, use maxOutputChars to increase)`
}

export const truncate = (text: string, maxChars: number, hint: TruncateHint = "truncated"): TruncateResult => {
  if (maxChars <= 0) {
    return { text: "", truncated: text.length > 0, originalLength: text.length, finalLength: 0 }
  }
  if (text.length <= maxChars) {
    return {
      text,
      truncated: false,
      originalLength: text.length,
      finalLength: text.length
    }
  }
  const suffix = buildSuffix(hint, maxChars)
  const budget = Math.max(0, maxChars - suffix.length)
  if (budget === 0) {
    return {
      text: suffix,
      truncated: true,
      originalLength: text.length,
      finalLength: suffix.length
    }
  }
  return {
    text: text.slice(0, budget) + suffix,
    truncated: true,
    originalLength: text.length,
    finalLength: budget + suffix.length
  }
}

export const truncatePreview = (text: string, maxChars: number): string => {
  if (maxChars <= 0) {
    return ""
  }
  if (text.length <= maxChars) {
    return text
  }
  return text.slice(0, Math.max(0, maxChars - 16)) + "\n... (truncated)"
}

export const firstLine = (text: string): string => {
  const idx = text.indexOf("\n")
  if (idx === -1) {
    return text
  }
  return text.slice(0, idx)
}
