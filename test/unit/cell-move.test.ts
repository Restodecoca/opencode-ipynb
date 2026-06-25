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

const copyFixture = (dest: string): string => {
  const file = path.join(dest, "test.ipynb")
  fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
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

const typeOf = (cell: { cell_type: string } | undefined): string => {
  if (!cell) throw new Error("missing cell")
  return cell.cell_type
}

describe("NotebookEditService.moveCell", () => {
  it("moves forward (fromIndex < toIndex)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-move-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const before = readCells(file)
      const movedSource = sourceOf(before[0])
      const movedType = typeOf(before[0])
      const result = await Effect.runPromise(
        edit.moveCell(file, 0, 2)
      )
      expect(result.fromIndex).toBe(0)
      expect(result.toIndex).toBe(2)
      expect(result.totalCells).toBe(4)
      const after = readCells(file)
      expect(after.length).toBe(4)
      expect(after[2]?.cell_type).toBe(movedType)
      expect(sourceOf(after[2])).toBe(movedSource)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("moves backward (fromIndex > toIndex)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-move-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const before = readCells(file)
      const movedSource = sourceOf(before[3])
      const movedType = typeOf(before[3])
      const result = await Effect.runPromise(
        edit.moveCell(file, 3, 0)
      )
      expect(result.fromIndex).toBe(3)
      expect(result.toIndex).toBe(0)
      expect(result.totalCells).toBe(4)
      const after = readCells(file)
      expect(after.length).toBe(4)
      expect(after[0]?.cell_type).toBe(movedType)
      expect(sourceOf(after[0])).toBe(movedSource)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("clamps toIndex to valid range when out of bounds (high)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-move-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const before = readCells(file)
      const movedSource = sourceOf(before[1])
      const result = await Effect.runPromise(
        edit.moveCell(file, 1, 99)
      )
      expect(result.fromIndex).toBe(1)
      expect(result.toIndex).toBe(3)
      expect(result.totalCells).toBe(4)
      const after = readCells(file)
      expect(after.length).toBe(4)
      expect(sourceOf(after[3])).toBe(movedSource)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("clamps toIndex to valid range when out of bounds (negative -> rejected as out of bounds)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-move-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.moveCell(file, 0, -5).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(CellIndexOutOfBoundsError)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects an out-of-bounds fromIndex with CellIndexOutOfBoundsError", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-move-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.moveCell(file, 99, 0).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(CellIndexOutOfBoundsError)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("no-op when fromIndex equals clamped toIndex", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-move-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const before = readCells(file)
      const result = await Effect.runPromise(
        edit.moveCell(file, 2, 2)
      )
      expect(result.fromIndex).toBe(2)
      expect(result.toIndex).toBe(2)
      expect(result.totalCells).toBe(4)
      const after = readCells(file)
      expect(after.length).toBe(4)
      expect(sourceOf(after[2])).toBe(sourceOf(before[2]))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves the order of non-moved cells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-move-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const before = readCells(file)
      await Effect.runPromise(edit.moveCell(file, 0, 3))
      const after = readCells(file)
      const remainingBefore = [
        { type: typeOf(before[1]), source: sourceOf(before[1]) },
        { type: typeOf(before[2]), source: sourceOf(before[2]) }
      ]
      const remainingAfter = [
        { type: typeOf(after[0]), source: sourceOf(after[0]) },
        { type: typeOf(after[1]), source: sourceOf(after[1]) }
      ]
      expect(remainingAfter).toEqual(remainingBefore)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
