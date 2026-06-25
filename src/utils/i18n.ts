export type TruncationHintKey =
  | "output"
  | "source"
  | "traceback"
  | "export"
  | "json"
  | "stream"

export interface TruncationHintContext {
  readonly paramName: string
  readonly maxChars: number
  readonly locale?: string | undefined
}

const DEFAULT_LOCALE = "en"
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(["en", "pt-BR"])

const EN_OUTPUT = "... (truncated, use ${paramName} to increase)"
const PT_BR_OUTPUT = "... (truncado, aumente ${paramName})"
const EN_SOURCE = "... (source truncated, use ${paramName} to increase)"
const PT_BR_SOURCE = "... (fonte truncada, aumente ${paramName})"
const EN_TRACEBACK = "... (traceback truncated, use ${paramName} to increase)"
const PT_BR_TRACEBACK = "... (traceback truncado, aumente ${paramName})"
const EN_EXPORT = "... (export truncated, use ${paramName} to increase)"
const PT_BR_EXPORT = "... (export truncado, aumente ${paramName})"
const EN_JSON = "... (json truncated, use ${paramName} to increase)"
const PT_BR_JSON = "... (json truncado, aumente ${paramName})"
const EN_STREAM = "... (stream truncated, use ${paramName} to increase)"
const PT_BR_STREAM = "... (stream truncado, aumente ${paramName})"

const TEMPLATES: Readonly<Record<TruncationHintKey, Readonly<Record<string, string>>>> = {
  output: { en: EN_OUTPUT, "pt-BR": PT_BR_OUTPUT },
  source: { en: EN_SOURCE, "pt-BR": PT_BR_SOURCE },
  traceback: { en: EN_TRACEBACK, "pt-BR": PT_BR_TRACEBACK },
  export: { en: EN_EXPORT, "pt-BR": PT_BR_EXPORT },
  json: { en: EN_JSON, "pt-BR": PT_BR_JSON },
  stream: { en: EN_STREAM, "pt-BR": PT_BR_STREAM }
}

const resolveLocale = (locale: string | undefined): string => {
  const candidate = locale ?? DEFAULT_LOCALE
  if (SUPPORTED_LOCALES.has(candidate)) {
    return candidate
  }
  return DEFAULT_LOCALE
}

const interpolate = (template: string, paramName: string): string =>
  template.split("${paramName}").join(paramName)

export const formatHint = (
  key: TruncationHintKey,
  ctx: TruncationHintContext,
  locale?: string
): string => {
  const effectiveLocale = resolveLocale(locale)
  const perKey = TEMPLATES[key]
  const template = perKey[effectiveLocale] ?? perKey[DEFAULT_LOCALE] ?? ""
  return interpolate(template, ctx.paramName)
}
