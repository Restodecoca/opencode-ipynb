import { describe, expect, it } from "bun:test"
import {
  buildNotebookVirtualDocument,
  toCellPosition,
  toVirtualPosition,
  type NotebookLike
} from "../../src/lsp.js"

const CELLS = 40_000
const LINES_PER_CELL = 2

const buildDocument = () => {
  const cells = Array.from({ length: CELLS }, () => ({
    cell_type: "code",
    source: "x = 1\ny = 2"
  }))
  const notebook = {
    metadata: { language_info: { name: "python" } },
    cells
  } as NotebookLike
  return buildNotebookVirtualDocument(notebook)
}

describe("virtual document cell spans", () => {
  it("are sorted by startLine and contiguous", () => {
    const document = buildDocument()
    expect(document.cells.length).toBe(CELLS)
    let expectedStart = 0
    for (const cell of document.cells) {
      expect(cell.startLine).toBe(expectedStart)
      expect(cell.endLine).toBe(expectedStart + LINES_PER_CELL)
      expectedStart = cell.endLine
    }
  })
})

describe("position mapping scale", () => {
  it("maps every line of a large notebook within a linear budget", () => {
    const document = buildDocument()
    const started = Date.now()
    for (let line = 0; line < CELLS * LINES_PER_CELL; line += 1) {
      const mapped = toCellPosition(document, line, 0)
      if (mapped === undefined) throw new Error(`unmapped line ${line}`)
      if (mapped.cellIndex !== Math.floor(line / LINES_PER_CELL)) {
        throw new Error(`wrong cell for line ${line}`)
      }
    }
    expect(toCellPosition(document, CELLS * LINES_PER_CELL, 0)).toBeUndefined()
    for (let cellIndex = 0; cellIndex < CELLS; cellIndex += 1) {
      const virtual = toVirtualPosition(document, cellIndex, 1, 0)
      if (virtual === undefined) throw new Error(`unmapped cell ${cellIndex}`)
      if (virtual.line !== cellIndex * LINES_PER_CELL + 1) {
        throw new Error(`wrong virtual line for cell ${cellIndex}`)
      }
    }
    expect(toVirtualPosition(document, CELLS, 0, 0)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  })
})
