import { describe, expect, it } from "bun:test"
import { stripAnsi, hasAnsi } from "../../src/utils/ansi.js"
import { formatOutputs, formatOutputsDetailed } from "../../src/format/outputs.js"
import { formatCellMarkdown, formatCellMarkdownDetailed } from "../../src/format/markdown.js"
import type { CodeCellRaw } from "../../src/domain/cell.js"
import { NotebookSchema } from "../../src/domain/notebook.js"

const makeNotebook = () =>
  NotebookSchema.parse({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    cells: []
  })

const makeErrorCell = (traceback: ReadonlyArray<string>): CodeCellRaw => ({
  cell_type: "code",
  metadata: {},
  execution_count: 1,
  outputs: [
    {
      output_type: "error",
      ename: "NameError",
      evalue: "name 'undefined_var' is not defined",
      traceback: [...traceback]
    }
  ],
  source: "undefined_var"
})

const wrap = (cell: CodeCellRaw) => {
  const nb = makeNotebook()
  const cells = [...nb.cells, cell]
  return { ...nb, cells } as ReturnType<typeof makeNotebook>
}

describe("stripAnsi", () => {
  it("removes ANSI color escape codes", () => {
    const input = "\u001b[0;36m  File \u001b[0;32m<string>\u001b[0;36m, line \u001b[0;32m1\u001b[0;36m\u001b[0m"
    const out = stripAnsi(input)
    expect(out).toBe("  File <string>, line 1")
    expect(out).not.toContain("\u001b")
  })

  it("removes carriage returns", () => {
    const out = stripAnsi("line 1\r\nline 2\r\n")
    expect(out).toBe("line 1\nline 2\n")
  })

  it("is a no-op on plain text", () => {
    const plain = "no escape codes here"
    expect(stripAnsi(plain)).toBe(plain)
  })

  it("hasAnsi detects ANSI sequences", () => {
    expect(hasAnsi("\u001b[31mred\u001b[0m")).toBe(true)
    expect(hasAnsi("plain text")).toBe(false)
  })
})

describe("formatOutputs > error view", () => {
  it("strips ANSI from the traceback and trims it", () => {
    const cell = makeErrorCell([
      "\u001b[0;36m  File \u001b[0;32m<string>\u001b[0;36m, line \u001b[0;32m1\u001b[0;36m, in <module>\u001b[0m",
      "\u001b[0;36m    undefined_var\u001b[0m",
      "\u001b[0;31mNameError\u001b[0;35m: \u001b[0;31mname 'undefined_var' is not defined\u001b[0m"
    ])
    const out = formatOutputs(cell)
    expect(out).toContain("**NameError**")
    expect(out).toContain("name 'undefined_var' is not defined")
    expect(out).not.toContain("\u001b[")
    expect(out).toContain("```")
  })

  it("truncates the traceback by default (no includeFullTraceback)", () => {
    const longTrace = Array.from({ length: 200 }, (_, i) => `frame ${i} with lots of context here`).join("\n")
    const cell = makeErrorCell(longTrace.split("\n"))
    const out = formatOutputs(cell, { maxTracebackChars: 200 })
    expect(out).toContain("truncated")
    expect(out).toContain("maxTracebackChars")
  })

  it("shows the full traceback when includeFullTraceback is true", () => {
    const longTrace = Array.from({ length: 200 }, (_, i) => `frame ${i} with lots of context here`).join("\n")
    const cell = makeErrorCell(longTrace.split("\n"))
    const out = formatOutputs(cell, { maxTracebackChars: 200, includeFullTraceback: true })
    expect(out).not.toContain("(truncated")
    expect(out).toContain("frame 199")
  })

  it("handles an empty traceback gracefully", () => {
    const cell = makeErrorCell([])
    const out = formatOutputs(cell)
    expect(out).toContain("**NameError**")
    expect(out).not.toContain("```")
  })
})

describe("formatCellMarkdown > error view (legacy path)", () => {
  it("strips ANSI when includeErrors is true and the cell has an error", () => {
    const cell = makeErrorCell([
      "\u001b[31mNameError\u001b[0m: \u001b[31mname 'x' is not defined\u001b[0m"
    ])
    const out = formatCellMarkdown(cell, 0, { includeErrors: true })
    expect(out).toContain("**NameError**")
    expect(out).not.toContain("\u001b[")
  })

  it("honors includeFullTraceback via MarkdownReadOptions", () => {
    const longTrace = Array.from({ length: 100 }, (_, i) => `frame ${i}`).join("\n")
    const cell = makeErrorCell(longTrace.split("\n"))
    const out = formatCellMarkdown(cell, 0, {
      includeErrors: true,
      includeFullTraceback: true,
      maxSourceChars: 1_000_000
    })
    expect(out).toContain("frame 99")
  })
})

describe("formatCellMarkdownDetailed > error view", () => {
  it("strips ANSI from the detailed format too", async () => {
    const cell = makeErrorCell(["\u001b[31mNameError\u001b[0m: \u001b[31mboom\u001b[0m"])
    const wrapped = wrap(cell)
    const codeCell = wrapped.cells[0] as CodeCellRaw
    const result = await formatCellMarkdownDetailed(codeCell, 0, { includeErrors: true })
    expect(result.rendered).toContain("**NameError**")
    expect(result.rendered).not.toContain("\u001b[")
  })
})

describe("formatOutputsDetailed > error view", () => {
  it("returns rendered + attachments/savedAttachments, strips ANSI", async () => {
    const cell = makeErrorCell(["\u001b[31merr\u001b[0m"])
    const result = await formatOutputsDetailed(cell)
    expect(result.rendered).toContain("**NameError**")
    expect(result.rendered).not.toContain("\u001b[")
    expect(result.attachments).toEqual([])
    expect(result.savedAttachments).toEqual([])
  })
})
