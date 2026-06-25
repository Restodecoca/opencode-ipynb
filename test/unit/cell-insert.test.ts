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

describe("NotebookEditService.insertCell", () => {
  it("inserts a new code cell at a specific index", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-insert-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.insertCell(file, "code", "print('hello')", 1)
      )
      expect(result.cellIndex).toBe(1)
      expect(result.cellType).toBe("code")
      expect(result.totalCells).toBe(5)
      expect(result.preview).toBe("print('hello')")
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ cell_type: string; source: string | string[]; execution_count: unknown; outputs: unknown[] }>
      }
      expect(onDisk.cells.length).toBe(5)
      const inserted = onDisk.cells[1]
      if (!inserted) throw new Error("missing inserted cell")
      expect(inserted.cell_type).toBe("code")
      expect(inserted.execution_count).toBeNull()
      expect(inserted.outputs).toEqual([])
      const newSource = inserted.source
      const normalized = Array.isArray(newSource) ? newSource.join("") : newSource
      expect(normalized).toBe("print('hello')")
      expect(onDisk.cells[0]?.cell_type).toBe("markdown")
      expect(onDisk.cells[2]?.cell_type).toBe("code")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inserts a new markdown cell at index 0 (prepend)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-insert-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.insertCell(file, "markdown", "# Top\n\nIntro.", 0)
      )
      expect(result.cellIndex).toBe(0)
      expect(result.cellType).toBe("markdown")
      expect(result.totalCells).toBe(5)
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ cell_type: string }>
      }
      expect(onDisk.cells.length).toBe(5)
      expect(onDisk.cells[0]?.cell_type).toBe("markdown")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inserts at the end when index is omitted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-insert-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.insertCell(file, "markdown", "# Footer", undefined)
      )
      expect(result.cellIndex).toBe(4)
      expect(result.totalCells).toBe(5)
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ cell_type: string; source: string | string[] }>
      }
      const last = onDisk.cells[4]
      if (!last) throw new Error("missing last cell")
      expect(last.cell_type).toBe("markdown")
      const src = Array.isArray(last.source) ? last.source.join("") : last.source
      expect(src).toBe("# Footer")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("appends at the end when index >= total", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-insert-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.insertCell(file, "raw", "RAW TEXT", 999)
      )
      expect(result.cellIndex).toBe(4)
      expect(result.totalCells).toBe(5)
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ cell_type: string; source: string | string[] }>
      }
      const last = onDisk.cells[4]
      if (!last) throw new Error("missing last cell")
      expect(last.cell_type).toBe("raw")
      const src = Array.isArray(last.source) ? last.source.join("") : last.source
      expect(src).toBe("RAW TEXT")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("appends at the end when index equals total", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-insert-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.insertCell(file, "markdown", "tail", 4)
      )
      expect(result.cellIndex).toBe(4)
      expect(result.totalCells).toBe(5)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects index < 0 with CellIndexOutOfBoundsError", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-insert-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.insertCell(file, "code", "x = 1", -1).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(CellIndexOutOfBoundsError)
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: unknown[] }
      expect(onDisk.cells.length).toBe(4)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preview is the first line of multi-line source", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-insert-"))
    try {
      const file = copyFixture(dir)
      const edit = setupEdit(dir)
      const result = await Effect.runPromise(
        edit.insertCell(file, "code", "line1\nline2\nline3", 0)
      )
      expect(result.preview).toBe("line1")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
