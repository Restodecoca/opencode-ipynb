import { describe, expect, it } from "bun:test"
import {
  sanitizeInline,
  truncateMarkdown
} from "../../src/utils/markdown-safe.js"
import { formatOutputs } from "../../src/format/outputs.js"
import { sanitizeTerminal } from "../../src/utils/ansi.js"

const fenceCount = (text: string): number =>
  (text.match(/^[ ]{0,3}(?:`{3,}|~{3,})/gm) ?? []).length

describe("sanitizeTerminal", () => {
  it("removes OSC, ESC, C0 and C1 but keeps newlines", () => {
    const out = sanitizeTerminal("a\u001b]0;x\u0007b\u001b[31mc\u0000d\u009be\nf")
    expect(out).toBe("abcde\nf")
  })
})

describe("sanitizeTerminal performance", () => {
  it("handles many unterminated OSC introducers without quadratic scans", () => {
    const text = ("\u001b]" + "a".repeat(100)).repeat(5_000)
    const started = Date.now()
    const out = sanitizeTerminal(text)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(out).not.toContain("\u001b")
  })
})

describe("sanitizeInline", () => {
  it("strips ANSI and control bytes", () => {
    const out = sanitizeInline("a\u001b[31mb\u0000c\n# d")
    expect(out).toBe("abc # d")
  })
})

describe("truncateMarkdown", () => {
  it("closes an open fence before appending the hint", () => {
    const text = "```python\n" + "x = 1\n".repeat(100)
    const out = truncateMarkdown(text, 200, "\n... (truncated)")
    expect(out.length).toBeLessThanOrEqual(210)
    expect(fenceCount(out) % 2).toBe(0)
    expect(out).toContain("truncated")
  })

  it("counts tilde and indented fences", () => {
    const text = "  ~~~python\n" + "x = 1\n".repeat(100)
    const out = truncateMarkdown(text, 200, "\n... (truncated)")
    expect(fenceCount(out) % 2).toBe(0)
    expect(out).toContain("~~~")
  })

  it("does not close an outer fence on a longer nested info-string fence", () => {
    const text = [
      "```md",
      "````python",
      ("x = 1\n").repeat(100),
      "````",
      "still inner",
      "```",
      "after"
    ].join("\n")
    const out = truncateMarkdown(text, 200, "\n... (truncated)")
    expect(out).toMatch(/\n```\n+\.\.\. \(truncated\)$/)
  })

  it("never exceeds maxChars for a pathological fence run", () => {
    const out = truncateMarkdown(
      "`".repeat(200_000),
      1_000,
      "\n... (truncated)"
    )
    expect(out.length).toBeLessThanOrEqual(1_000)
    expect(fenceCount(out) % 2).toBe(0)
  })

  it("handles CRLF fences and invalid backtick info strings", () => {
    const crlf = truncateMarkdown(
      "```python\r\n" + "x = 1\r\n".repeat(100),
      120,
      "\n... (truncated)"
    )
    expect(fenceCount(crlf) % 2).toBe(0)
    const invalid = truncateMarkdown(
      "``` foo`bar\n" + "x = 1\n".repeat(100),
      120,
      "\n... (truncated)"
    )
    expect(invalid.endsWith("... (truncated)")).toBe(true)
  })
})

describe("formatOutputs label safety", () => {
  it("sanitizes newlines in output MIME keys", () => {
    const out = formatOutputs(
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: "x",
        outputs: [
          {
            output_type: "display_data",
            data: { "application/x\n# INJECTED": { a: 1 } },
            metadata: {}
          }
        ]
      },
      { maxOutputChars: 4_000 }
    )
    expect(out).not.toMatch(/^# INJECTED/m)
    expect(out).not.toContain("\u001b")
  })
})

describe("formatOutputs control bytes", () => {
  it("strips terminal controls from streams and tracebacks", () => {
    const out = formatOutputs(
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: "x",
        outputs: [
          { output_type: "stream", name: "stdout", text: "a\u001b[31mb\u009b" },
          {
            output_type: "error",
            ename: "E",
            evalue: "v",
            traceback: ["tb\u001b]0;x\u0007"]
          }
        ]
      },
      { maxOutputChars: 4_000 }
    )
    expect(out).not.toContain("\u001b")
    expect(out).not.toContain("\u009b")
  })
})

describe("formatOutputs fence balance", () => {
  it("keeps fences balanced after the final truncation", () => {
    const out = formatOutputs(
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: "print('x')",
        outputs: [
          { output_type: "stream", name: "stdout", text: "y".repeat(2_000) }
        ]
      },
      { maxOutputChars: 200 }
    )
    expect(out.length).toBeLessThanOrEqual(220)
    expect(fenceCount(out) % 2).toBe(0)
  })
})
