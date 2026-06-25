import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import {
  makePathService,
  makePermissionService,
  makeNotebookFileService,
  makeEditImpl,
  makeDiffService
} from "../../src/services/index.js"
import { CellIndexOutOfBoundsError } from "../../src/domain/errors.js"
import type { ToolContext } from "@opencode-ai/plugin"

const FIXTURES = path.resolve(__dirname, "..", "fixtures")

const makeFakeContext = (directory: string, worktree: string): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

const setupEdit = (worktree: string) => {
  const pathSvc = makePathService({
    directory: worktree,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const permSvc = makePermissionService(makeFakeContext(worktree, worktree))
  const diffSvc = makeDiffService()
  return makeEditImpl(pathSvc, fileSvc, diffSvc, permSvc)
}

const copyFixture = (dest: string, fixture = "simple.ipynb"): string => {
  const file = path.join(dest, "test.ipynb")
  fs.copyFileSync(path.join(FIXTURES, fixture), file)
  return file
}

const readCells = (file: string): Array<{ cell_type: string; source: string | string[] }> => {
  const nb = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: Array<{ cell_type: string; source: string | string[] }> }
  return nb.cells
}

const sourceOf = (cell: { source: string | string[] } | undefined): string => {
  if (!cell) throw new Error("missing cell")
  return Array.isArray(cell.source) ? cell.source.join("") : cell.source
}

describe("NotebookEditService.deleteCell", () => {
  it("deletes a cell by index, returns the new total", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-delete-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.deleteCell(file, 1)
      )
      expect(result.deletedIndex).toBe(1)
      expect(result.deletedType).toBe("code")
      expect(result.deletedPreview).toContain("x = 1")
      expect(result.totalCells).toBe(3)
      const cells = readCells(file)
      expect(cells.length).toBe(3)
      expect(cells[0]?.cell_type).toBe("markdown")
      expect(cells[1]?.cell_type).toBe("markdown")
      expect(cells[2]?.cell_type).toBe("code")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects an out-of-bounds index with CellIndexOutOfBoundsError", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-delete-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.deleteCell(file, 99).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(CellIndexOutOfBoundsError)
      const cells = readCells(file)
      expect(cells.length).toBe(4)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a negative index with CellIndexOutOfBoundsError", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-delete-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.deleteCell(file, -1).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(CellIndexOutOfBoundsError)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves the cell types around the deleted one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-delete-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const before = readCells(file)
      const targetIdx = 1
      const removedType = before[targetIdx]?.cell_type
      const removedSrc = sourceOf(before[targetIdx])
      const result = await Effect.runPromise(
        edit.deleteCell(file, targetIdx)
      )
      expect(result.deletedType).toBe(removedType)
      expect(result.deletedPreview.length).toBeGreaterThan(0)
      const after = readCells(file)
      expect(after.length).toBe(before.length - 1)
      for (let i = 0; i < targetIdx; i++) {
        expect(after[i]?.cell_type).toBe(before[i]?.cell_type)
      }
      for (let i = targetIdx; i < after.length; i++) {
        expect(after[i]?.cell_type).toBe(before[(i as number) + 1]?.cell_type)
        expect(sourceOf(after[i])).toBe(sourceOf(before[(i as number) + 1]))
      }
      expect(removedSrc).toBeDefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("truncates long deleted previews to ~80 chars", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-delete-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const longSource = "x = " + "a".repeat(300) + "\n"
      const nb = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ cell_type: string; source: string | string[]; metadata: Record<string, unknown>; execution_count: number | null; outputs: unknown[] }>
      }
      nb.cells[0] = {
        cell_type: "code",
        metadata: {},
        execution_count: null,
        outputs: [],
        source: longSource
      }
      fs.writeFileSync(file, JSON.stringify(nb, null, 1))
      const result = await Effect.runPromise(
        edit.deleteCell(file, 0)
      )
      expect(result.deletedPreview.length).toBeLessThanOrEqual(100)
      expect(result.deletedPreview).toContain("x = ")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
