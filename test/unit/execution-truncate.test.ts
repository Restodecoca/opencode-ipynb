import { describe, expect, it } from "bun:test"
import {
  truncateText,
  truncateTraceback,
  truncateCellSummary,
  truncateRunResponse
} from "../../src/services/NotebookExecutionService.js"
import type { RunResponse, CellExecutionSummary } from "../../src/domain/execution.js"

const makeSummary = (overrides: Partial<CellExecutionSummary> = {}): CellExecutionSummary => ({
  cellIndex: 0,
  status: "ok",
  ...overrides
})

const makeResponse = (overrides: Partial<RunResponse> = {}): RunResponse => ({
  success: true,
  executedCells: [0],
  durationMs: 100,
  outputs: [],
  ...overrides
})

describe("truncateText", () => {
  it("returns undefined when input is undefined", () => {
    expect(truncateText(undefined, 100)).toBeUndefined()
  })

  it("returns the original text when it fits", () => {
    expect(truncateText("hello", 100)).toBe("hello")
  })

  it("truncates and appends a hint when over the limit", () => {
    const result = truncateText("x".repeat(200), 50)
    expect(result).toBeDefined()
    expect(result).toContain("truncated")
    expect(result).toContain("maxOutputChars")
  })

  it("routes the hint through the i18n templates (default English)", () => {
    const result = truncateText("x".repeat(200), 50)
    expect(result).toBeDefined()
    expect(result).toContain("... (truncated, use maxOutputChars to increase)")
  })

  it("localizes the hint to pt-BR when a locale is passed", () => {
    const result = truncateText("x".repeat(200), 80, "pt-BR")
    expect(result).toBeDefined()
    expect(result).toContain("truncado")
    expect(result).toContain("maxOutputChars")
    expect(result).not.toContain("truncated, use")
  })

  it("returns empty string for non-positive maxChars", () => {
    expect(truncateText("hello", 0)).toBe("")
    expect(truncateText("hello", -1)).toBe("")
  })
})

describe("truncateTraceback", () => {
  it("returns the original array when it fits", () => {
    const tb = ["frame 0", "frame 1"]
    expect(truncateTraceback(tb, 1000)).toEqual(tb)
  })

  it("joins and truncates when over the limit", () => {
    const tb = Array.from({ length: 50 }, (_, i) => `frame ${i} with some context`)
    const out = truncateTraceback(tb, 100)
    expect(out).toHaveLength(1)
    expect(out[0]).toContain("truncated")
  })
})

describe("truncateCellSummary", () => {
  it("preserves the cellIndex and status", () => {
    const out = truncateCellSummary(makeSummary(), 1000)
    expect(out.cellIndex).toBe(0)
    expect(out.status).toBe("ok")
  })

  it("truncates stdout/stderr/resultPreview", () => {
    const summary = makeSummary({
      stdout: "x".repeat(1000),
      stderr: "y".repeat(1000),
      resultPreview: "z".repeat(1000)
    })
    const out = truncateCellSummary(summary, 100)
    expect(out.stdout).toBeDefined()
    expect(out.stdout?.length).toBeLessThanOrEqual(200)
    expect(out.stderr).toBeDefined()
    expect(out.stderr?.length).toBeLessThanOrEqual(200)
    expect(out.resultPreview).toBeDefined()
    expect(out.resultPreview?.length).toBeLessThanOrEqual(200)
  })

  it("truncates traceback in errors", () => {
    const summary = makeSummary({
      errors: [
        {
          ename: "NameError",
          evalue: "x",
          traceback: Array.from({ length: 100 }, (_, i) => `frame ${i}`)
        }
      ]
    })
    const out = truncateCellSummary(summary, 50)
    expect(out.errors?.[0]?.traceback[0]).toContain("truncated")
  })

  it("preserves executionCount and durationMs", () => {
    const out = truncateCellSummary(
      makeSummary({ executionCount: 3, durationMs: 1234 }),
      1000
    )
    expect(out.executionCount).toBe(3)
    expect(out.durationMs).toBe(1234)
  })

  it("does not add undefined fields when input lacks them", () => {
    const out = truncateCellSummary(makeSummary(), 1000)
    expect("stdout" in out).toBe(false)
    expect("stderr" in out).toBe(false)
    expect("errors" in out).toBe(false)
  })

  it("preserves displayData unchanged", () => {
    const displayData = [{ mime: "image/png", sizeBytes: 1024 }]
    const out = truncateCellSummary(makeSummary({ displayData }), 1000)
    expect(out.displayData).toEqual(displayData)
  })
})

describe("truncateRunResponse", () => {
  it("truncates every cell in outputs", () => {
    const response = makeResponse({
      outputs: [
        makeSummary({ cellIndex: 0, stdout: "x".repeat(500) }),
        makeSummary({ cellIndex: 1, stderr: "y".repeat(500) })
      ]
    })
    const out = truncateRunResponse(response, 100)
    expect(out.outputs).toHaveLength(2)
    expect(out.outputs[0]?.stdout?.length).toBeLessThanOrEqual(200)
    expect(out.outputs[1]?.stderr?.length).toBeLessThanOrEqual(200)
  })

  it("preserves success, executedCells, durationMs", () => {
    const response = makeResponse({
      success: true,
      executedCells: [0, 1, 2],
      durationMs: 999
    })
    const out = truncateRunResponse(response, 1000)
    expect(out.success).toBe(true)
    expect(out.executedCells).toEqual([0, 1, 2])
    expect(out.durationMs).toBe(999)
  })

  it("preserves the error field when present", () => {
    const response = makeResponse({
      success: false,
      error: {
        kind: "CellExecutionError",
        cellIndex: 3,
        ename: "E",
        evalue: "v",
        traceback: ["line 1"]
      }
    })
    const out = truncateRunResponse(response, 1000)
    expect(out.error?.cellIndex).toBe(3)
  })

  it("truncates the error traceback when over the limit", () => {
    const longTb = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const response = makeResponse({
      success: false,
      error: {
        kind: "CellExecutionError",
        cellIndex: 3,
        ename: "E",
        evalue: "v",
        traceback: longTb
      }
    })
    const out = truncateRunResponse(response, 50)
    expect(out.error).toBeDefined()
    expect(out.error?.traceback[0]).toContain("truncated")
  })
})
