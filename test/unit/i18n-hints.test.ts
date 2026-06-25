import { describe, expect, it } from "bun:test"
import { formatHint, type TruncationHintKey } from "../../src/utils/i18n.js"
import { truncate } from "../../src/utils/truncate.js"

describe("formatHint", () => {
  it("returns the English template for 'output' with the given paramName (legacy-compatible)", () => {
    const text = formatHint("output", { paramName: "maxOutputChars", maxChars: 100 })
    expect(text).toBe("... (truncated, use maxOutputChars to increase)")
  })

  it("returns the Portuguese template for 'output' and interpolates the paramName", () => {
    const text = formatHint("output", { paramName: "maxOutputChars", maxChars: 100 }, "pt-BR")
    expect(text).toContain("truncado")
    expect(text).toContain("maxOutputChars")
  })

  it("falls back to English when the locale is unknown", () => {
    const text = formatHint("output", { paramName: "maxTracebackChars", maxChars: 200 }, "xx-YY")
    expect(text).toBe("... (truncated, use maxTracebackChars to increase)")
  })

  it("emits distinct templates for the six keys in English", () => {
    const keys: TruncationHintKey[] = ["output", "source", "traceback", "export", "json", "stream"]
    const seen = new Set<string>()
    for (const k of keys) {
      const t = formatHint(k, { paramName: "x", maxChars: 1 }, "en")
      expect(t).toContain("x")
      seen.add(t)
    }
    expect(seen.size).toBe(keys.length)
  })
})

describe("truncate with structured hint", () => {
  it("uses the i18n hint when given a structured spec", () => {
    const result = truncate("x".repeat(200), 60, { key: "output", paramName: "maxOutputChars" })
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("truncated")
    expect(result.text).toContain("maxOutputChars")
  })

  it("localizes the structured hint when a locale is provided", () => {
    const result = truncate(
      "x".repeat(200),
      80,
      { key: "output", paramName: "maxOutputChars", locale: "pt-BR" }
    )
    expect(result.text).toContain("truncado")
  })

  it("still supports the legacy string hint (regression)", () => {
    const result = truncate("x".repeat(200), 80, "truncated")
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("... (truncated, use maxOutputChars to increase)")
  })

  it("does not truncate when the text fits within maxChars", () => {
    const result = truncate("hello", 100, { key: "output", paramName: "maxOutputChars" })
    expect(result.truncated).toBe(false)
    expect(result.text).toBe("hello")
  })

  it("returns an empty string for non-positive maxChars", () => {
    const result = truncate("hello", 0, { key: "output", paramName: "maxOutputChars" })
    expect(result.text).toBe("")
    expect(result.truncated).toBe(true)
  })
})
