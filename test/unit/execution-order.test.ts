import { describe, expect, it } from "bun:test"
import {
  analyzeExecutionOrder,
  analyzeExecutionOrderWarnings,
  formatInspectSummary
} from "../../src/services/NotebookInspectService.js"
import { inspectCell } from "../../src/format/diagnostics.js"
import { NotebookSchema } from "../../src/domain/notebook.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"
import type { CodeCellRaw } from "../../src/domain/cell.js"

const makeNotebook = (cells: ReadonlyArray<CodeCellRaw | { cell_type: "markdown"; metadata: Record<string, unknown>; source: string }>): NotebookRaw => {
  return NotebookSchema.parse({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    cells: cells.map((c) => ({ ...c, metadata: c.metadata ?? {} }))
  }) as NotebookRaw
}

const codeCell = (exec: number | null, source: string): CodeCellRaw => ({
  cell_type: "code",
  metadata: {},
  execution_count: exec,
  outputs: [],
  source
})

const mdCell = (source: string) => ({
  cell_type: "markdown" as const,
  metadata: {} as Record<string, unknown>,
  source
})

describe("analyzeExecutionOrder", () => {
  it("returns an empty array for an empty notebook", () => {
    const nb = makeNotebook([])
    expect(analyzeExecutionOrder(nb)).toEqual([])
  })

  it("returns an empty array when all code cells are monotonic", () => {
    const nb = makeNotebook([codeCell(1, "a"), codeCell(2, "b"), codeCell(3, "c")])
    expect(analyzeExecutionOrder(nb)).toEqual([])
  })

  it("allows re-runs of the same cell (non-decreasing)", () => {
    const nb = makeNotebook([codeCell(1, "a"), codeCell(2, "b"), codeCell(2, "b again")])
    expect(analyzeExecutionOrder(nb)).toEqual([])
  })

  it("flags a cell whose execution_count is less than the previous code cell", () => {
    const nb = makeNotebook([codeCell(1, "a"), codeCell(2, "b"), codeCell(1, "c")])
    const out = analyzeExecutionOrder(nb)
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({ cellIndex: 2, executionCount: 1, previousCount: 2 })
  })

  it("flags multiple out-of-order cells", () => {
    const nb = makeNotebook([
      codeCell(5, "a"),
      codeCell(6, "b"),
      codeCell(2, "c"),
      codeCell(3, "d"),
      codeCell(1, "e")
    ])
    const out = analyzeExecutionOrder(nb)
    expect(out.length).toBe(2)
    expect(out[0]?.cellIndex).toBe(2)
    expect(out[1]?.cellIndex).toBe(4)
  })

  it("skips markdown cells when tracking the previous count", () => {
    const nb = makeNotebook([codeCell(1, "a"), mdCell("hi"), codeCell(2, "b")])
    expect(analyzeExecutionOrder(nb)).toEqual([])
  })

  it("resets the previous count when a code cell has execution_count = null", () => {
    const nb = makeNotebook([codeCell(5, "a"), codeCell(null, "b"), codeCell(1, "c")])
    expect(analyzeExecutionOrder(nb)).toEqual([])
  })

  it("flags out-of-order across a null gap (regression)", () => {
    const nb = makeNotebook([codeCell(5, "a"), codeCell(null, "b"), codeCell(3, "c"), codeCell(2, "d")])
    const out = analyzeExecutionOrder(nb)
    expect(out.length).toBe(1)
    expect(out[0]?.cellIndex).toBe(3)
    expect(out[0]).toEqual({ cellIndex: 3, executionCount: 2, previousCount: 3 })
  })
})

describe("analyzeExecutionOrderWarnings", () => {
  it("formats warnings as 'cell <idx>: execution_count X < previous Y (...)'", () => {
    const nb = makeNotebook([codeCell(2, "a"), codeCell(1, "b")])
    const warnings = analyzeExecutionOrderWarnings(nb)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toBe("cell 1: execution_count 1 < previous 2 (notebook was not executed top-to-bottom)")
  })

  it("returns no warnings for a monotonic run", () => {
    const nb = makeNotebook([codeCell(1, "a"), codeCell(2, "b")])
    expect(analyzeExecutionOrderWarnings(nb)).toEqual([])
  })
})

describe("formatInspectSummary > execution order section", () => {
  it("renders '(monotonic, top-to-bottom)' when no order warnings", () => {
    const nb = makeNotebook([codeCell(1, "a"), codeCell(2, "b")])
    const summary = {
      filePath: "/tmp/x.ipynb",
      displayPath: "x.ipynb",
      notebook: nb,
      cells: nb.cells.map((c, i) => inspectCell(c, i)),
      totalCells: nb.cells.length,
      truncated: false,
      executionOrderWarnings: []
    }
    const out = formatInspectSummary(summary)
    expect(out).toContain("## Execution order")
    expect(out).toContain("(monotonic, top-to-bottom)")
  })

  it("renders one bullet per out-of-order cell", () => {
    const nb = makeNotebook([codeCell(2, "a"), codeCell(1, "b")])
    const summary = {
      filePath: "/tmp/x.ipynb",
      displayPath: "x.ipynb",
      notebook: nb,
      cells: nb.cells.map((c, i) => inspectCell(c, i)),
      totalCells: nb.cells.length,
      truncated: false,
      executionOrderWarnings: analyzeExecutionOrderWarnings(nb)
    }
    const out = formatInspectSummary(summary)
    expect(out).toContain("## Execution order")
    expect(out).toContain("- cell 1: execution_count 1 < previous 2")
  })
})
