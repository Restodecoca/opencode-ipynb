import { describe, expect, it } from "bun:test"
import { truncate, truncatePreview } from "../../src/utils/truncate.js"

const OUTPUT_HINT = { key: "output", paramName: "maxOutputChars" } as const

describe("truncate > edge-case budgets", () => {
  it("maxChars=1 still surfaces the truncation hint", () => {
    const result = truncate("x".repeat(200), 1, OUTPUT_HINT)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("truncated")
    // No original content should sneak in when the hint alone fills the budget.
    expect(result.text.startsWith("x")).toBe(false)
  })

  it("maxChars=5 still surfaces the truncation hint", () => {
    const result = truncate("x".repeat(200), 5, OUTPUT_HINT)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("truncated")
  })

  it("maxChars=16 still surfaces the truncation hint", () => {
    const result = truncate("x".repeat(200), 16, OUTPUT_HINT)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("truncated")
  })

  it("maxChars=50 keeps some original content and the truncation hint", () => {
    const result = truncate("x".repeat(200), 50, OUTPUT_HINT)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("x")
    expect(result.text).toContain("truncated")
  })

  it("maxChars=200 keeps a lot of original content and the truncation hint", () => {
    const result = truncate("x".repeat(2000), 200, OUTPUT_HINT)
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("x")
    expect(result.text).toContain("truncated")
  })

  it("does not prepend original text when the suffix alone fills the budget", () => {
    // The structured i18n hint is far longer than 1 char, so the suffix alone
    // would have pushed the old implementation past maxChars=1.
    const result = truncate("x".repeat(200), 1, OUTPUT_HINT)
    expect(result.finalLength).toBeGreaterThan(0)
    // The hint alone may exceed maxChars; what we assert is that we do not
    // also prepend the original text on top of the oversize hint.
    expect(result.text.startsWith("x")).toBe(false)
  })

  it("returns the full string when the text fits within maxChars", () => {
    const result = truncate("hello", 100, OUTPUT_HINT)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe("hello")
  })

  it("returns an empty result for non-positive maxChars", () => {
    const result = truncate("hello", 0, OUTPUT_HINT)
    expect(result.text).toBe("")
    expect(result.truncated).toBe(true)
  })
})

describe("truncatePreview > edge cases", () => {
  it("returns the literal suffix when maxChars=1", () => {
    expect(truncatePreview("x".repeat(200), 1)).toBe("\n... (truncated)")
  })

  it("returns a tiny preview when maxChars=16", () => {
    const out = truncatePreview("x".repeat(200), 16)
    expect(out.endsWith("\n... (truncated)")).toBe(true)
  })

  it("returns a normal preview when maxChars=80", () => {
    const out = truncatePreview("x".repeat(200), 80)
    expect(out.endsWith("\n... (truncated)")).toBe(true)
    expect(out.length).toBeLessThanOrEqual(80)
  })
})
