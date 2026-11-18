import { describe, expect, it } from "bun:test"
import { applyNotebookDefaults } from "../../src/domain/notebook.js"

const deepFreeze = (value: unknown): void => {
  if (value === null || typeof value !== "object") return
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
}

describe("applyNotebookDefaults purity", () => {
  it("never mutates the parsed notebook it is given", () => {
    const raw = {
      cells: [
        { cell_type: "code", execution_count: null, metadata: {}, source: ["a"] },
        { cell_type: "code", execution_count: 1, metadata: {}, outputs: [], source: ["b"] },
        { cell_type: "markdown", metadata: {}, source: ["c"] }
      ],
      nbformat: 4,
      nbformat_minor: 5
    }
    deepFreeze(raw)
    const out = applyNotebookDefaults(raw)
    expect(out.metadata).toEqual({})
    expect(
      Object.prototype.hasOwnProperty.call(
        (out.cells[0] as Record<string, unknown>),
        "outputs"
      )
    ).toBe(true)
    expect(
      Object.prototype.hasOwnProperty.call(
        (raw.cells[0] as Record<string, unknown>),
        "outputs"
      )
    ).toBe(false)
    expect(Object.keys(raw)).toEqual(["cells", "nbformat", "nbformat_minor"])
  })

  it("keeps object identity for parts that need no default", () => {
    const metadata = { a: 1 }
    const untouchedCell = {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: ["b"]
    }
    const raw = {
      cells: [untouchedCell, { cell_type: "markdown", metadata: {}, source: ["c"] }],
      metadata,
      nbformat: 4,
      nbformat_minor: 5
    }
    const out = applyNotebookDefaults(raw)
    expect(out.metadata).toBe(metadata)
    expect(out.cells[0] as unknown).toBe(untouchedCell as unknown)
    expect(out.cells[1] as unknown).toBe(raw.cells[1] as unknown)
  })

  it("only clones the cells that actually receive a default", () => {
    const raw = {
      cells: [
        { cell_type: "code", execution_count: null, metadata: {}, source: ["a"] },
        { cell_type: "code", execution_count: null, metadata: {}, source: ["b"] }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    }
    const out = applyNotebookDefaults(raw)
    expect(out.cells[0] as unknown).not.toBe(raw.cells[0] as unknown)
    expect(out.cells[1] as unknown).not.toBe(raw.cells[1] as unknown)
    expect(out.cells[0] as unknown).not.toBe(out.cells[1] as unknown)
  })

  it("applies defaults to a prototype-polluted cell without touching its sibling", () => {
    const raw = JSON.parse(
      `{"cells":[{"__proto__":{"p":"yes"},"cell_type":"code","execution_count":null,"metadata":{}},{"cell_type":"code","execution_count":null,"metadata":{},"outputs":[]}],"nbformat":4,"nbformat_minor":5}`
    )
    const sibling = raw.cells[1]
    const out = applyNotebookDefaults(raw)
    expect(Object.keys(out.cells[0] as Record<string, unknown>)).toContain("outputs")
    expect(out.cells[1] as unknown).toBe(sibling as unknown)
  })
})
