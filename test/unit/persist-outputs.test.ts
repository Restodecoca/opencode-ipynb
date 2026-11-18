import { describe, expect, it } from "bun:test"
import { buildPersistedOutputs } from "../../src/services/NotebookExecutionService.js"
import type { CellExecutionSummary } from "../../src/domain/execution.js"

const makeSummary = (overrides: Partial<CellExecutionSummary> = {}): CellExecutionSummary => ({
  cellIndex: 0,
  status: "ok",
  ...overrides
})

describe("buildPersistedOutputs", () => {
  it("empty summary produces an empty outputs array", () => {
    const out = buildPersistedOutputs(makeSummary())
    expect(out).toEqual([])
  })

  it("stdout only produces one stream output", () => {
    const out = buildPersistedOutputs(makeSummary({ stdout: "hello" }))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      output_type: "stream",
      name: "stdout",
      text: "hello"
    })
  })

  it("stdout and stderr produce two stream outputs in stdout-first order", () => {
    const out = buildPersistedOutputs(
      makeSummary({ stdout: "out-text", stderr: "err-text" })
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      output_type: "stream",
      name: "stdout",
      text: "out-text"
    })
    expect(out[1]).toEqual({
      output_type: "stream",
      name: "stderr",
      text: "err-text"
    })
  })

  it("resultPreview produces an execute_result with execution_count from the summary", () => {
    const out = buildPersistedOutputs(
      makeSummary({ resultPreview: "42", executionCount: 7 })
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      output_type: "execute_result",
      execution_count: 7,
      data: { "text/plain": "42" },
      metadata: {}
    })
  })

  it("errors produces an error output with ename, evalue, and traceback", () => {
    const out = buildPersistedOutputs(
      makeSummary({
        errors: [
          { ename: "NameError", evalue: "name 'x' is not defined", traceback: ["line 1", "line 2"] }
        ]
      })
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      output_type: "error",
      ename: "NameError",
      evalue: "name 'x' is not defined",
      traceback: ["line 1", "line 2"]
    })
  })

  it("displayData produces a display_data output with mime and size placeholder", () => {
    const out = buildPersistedOutputs(
      makeSummary({ displayData: [{ mime: "image/png", sizeBytes: 12345 }] })
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      output_type: "display_data",
      data: { "image/png": "(12345 bytes, omitted by plugin)" },
      metadata: {}
    })
  })

  it("a summary with all fields produces an array in the documented order (stream, execute_result, display_data, error)", () => {
    const summary = makeSummary({
      stdout: "out-text",
      stderr: "err-text",
      resultPreview: "42",
      executionCount: 3,
      displayData: [{ mime: "image/png", sizeBytes: 100 }],
      errors: [{ ename: "E", evalue: "v", traceback: ["t"] }]
    })
    const out = buildPersistedOutputs(summary)
    expect(out).toHaveLength(5)
    expect(out[0]).toEqual({
      output_type: "stream",
      name: "stdout",
      text: "out-text"
    })
    expect(out[1]).toEqual({
      output_type: "stream",
      name: "stderr",
      text: "err-text"
    })
    expect(out[2]).toEqual({
      output_type: "execute_result",
      execution_count: 3,
      data: { "text/plain": "42" },
      metadata: {}
    })
    expect(out[3]).toEqual({
      output_type: "display_data",
      data: { "image/png": "(100 bytes, omitted by plugin)" },
      metadata: {}
    })
    expect(out[4]).toEqual({
      output_type: "error",
      ename: "E",
      evalue: "v",
      traceback: ["t"]
    })
  })
})

describe("buildPersistedOutputs keeps raw MIME bundles", () => {
  it("persists multi-mime display_data exactly as the kernel produced it", () => {
    const raw = [
      {
        output_type: "display_data",
        data: {
          "text/html": "<b>hi</b>",
          "text/plain": "hi",
          "image/png": "iVBORw0KGgo="
        },
        metadata: { needs_background: "light" }
      },
      {
        output_type: "execute_result",
        execution_count: 7,
        data: { "text/plain": "42", "text/markdown": "**42**" },
        metadata: {}
      }
    ]
    const out = buildPersistedOutputs(makeSummary({ rawOutputs: raw }))
    expect(out).toEqual(raw)
  })

  it("falls back to the summary shape when raw outputs are absent", () => {
    const out = buildPersistedOutputs(
      makeSummary({ stdout: "text", displayData: [{ mime: "image/png", sizeBytes: 9 }] })
    )
    expect(out[0]).toEqual({ output_type: "stream", name: "stdout", text: "text" })
  })
})
