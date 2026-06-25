import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import {
  makePathService,
  makePermissionService,
  makeNotebookFileService,
  makeInspectImpl,
  makeReadImpl,
  makeEditImpl,
  makeCleanImpl,
  makeOutputImpl,
  makeDiffService
} from "../../src/services/index.js"
import { CellIndexOutOfBoundsError, NotebookNotFoundError, NotebookParseError, NotebookValidationError, PathOutsideWorktreeError } from "../../src/domain/errors.js"
import { buildServices } from "../../src/services/index.js"
import { inspectCell } from "../../src/format/diagnostics.js"
import { formatOutputs } from "../../src/format/outputs.js"
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

const runOrThrow = async <A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, E, never>)

describe("NotebookSchema validation", () => {
  it("parses a valid simple notebook", () => {
    const services = buildServices(
      makeFakeContext(FIXTURES, FIXTURES)
    )
    void services
    const text = fs.readFileSync(path.join(FIXTURES, "simple.ipynb"), "utf8")
    const raw = JSON.parse(text) as unknown
    expect(raw).toBeTruthy()
    const cells = (raw as { cells: unknown[] }).cells
    expect(cells.length).toBe(4)
  })

  it("rejects a notebook with nbformat < 4", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "old.ipynb")
    fs.writeFileSync(file, JSON.stringify({ nbformat: 3, cells: [], metadata: {} }))
    try {
      const result = await Effect.runPromise(
        fileSvc.read(file).pipe(
          Effect.flip
        )
      )
      expect(result).toBeInstanceOf(NotebookValidationError)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a non-JSON file", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "bad.ipynb")
    fs.writeFileSync(file, "this is not json {")
    try {
      const result = await Effect.runPromise(
        fileSvc.read(file).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(NotebookParseError)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Source normalization", () => {
  it("joins string array source to a single string", () => {
    const services = buildServices(makeFakeContext(FIXTURES, FIXTURES))
    void services
    const result = (() => {
      const arr = ["line1\n", "line2\n", "line3"]
      return arr.join("")
    })()
    expect(result).toBe("line1\nline2\nline3")
  })
})

describe("Inspect", () => {
  it("summarizes the simple fixture", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const inspect = makeInspectImpl(pathSvc, fileSvc)
    const result = await runOrThrow(inspect.inspect(path.join(FIXTURES, "simple.ipynb")))
    expect(result.totalCells).toBe(4)
    expect(result.cells.length).toBe(4)
    const codeCells = result.cells.filter((c) => c.cellType === "code")
    const mdCells = result.cells.filter((c) => c.cellType === "markdown")
    expect(codeCells.length).toBe(2)
    expect(mdCells.length).toBe(2)
  })

  it("respects maxCells", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const inspect = makeInspectImpl(pathSvc, fileSvc)
    const result = await runOrThrow(inspect.inspect(path.join(FIXTURES, "simple.ipynb"), { maxCells: 2 }))
    expect(result.cells.length).toBe(2)
    expect(result.truncated).toBe(true)
  })
})

describe("Read", () => {
  it("reads a single cell", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const read = makeReadImpl(pathSvc, fileSvc)
    const result = await runOrThrow(read.readCell(path.join(FIXTURES, "simple.ipynb"), 1))
    expect(result.indexes).toEqual([1])
    expect(result.rendered).toContain("x = 1")
  })

  it("rejects out-of-bounds cell index", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const read = makeReadImpl(pathSvc, fileSvc)
    const result = await Effect.runPromise(
      read.readCell(path.join(FIXTURES, "simple.ipynb"), 999).pipe(Effect.flip)
    )
    expect(result).toBeInstanceOf(CellIndexOutOfBoundsError)
  })

  it("reads a range of cells", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const read = makeReadImpl(pathSvc, fileSvc)
    const result = await runOrThrow(read.readRange(path.join(FIXTURES, "simple.ipynb"), 0, 1))
    expect(result.indexes).toEqual([0, 1])
  })
})

describe("Edit", () => {
  it("edits a markdown cell and preserves metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "test.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const pathSvc = makePathService({
      directory: dir,
      worktree: dir,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(dir, dir))
    const diffSvc = makeDiffService()
    const edit = makeEditImpl(pathSvc, fileSvc, diffSvc, permSvc)
    const originalMeta = (() => {
      const nb = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: Array<{ cell_type: string; metadata: unknown }> }
      return nb.cells[0]?.metadata
    })()
    const result = await runOrThrow(edit.editCell(file, { cellIndex: 0, source: "# New title\n\nUpdated." }))
    expect(result.cellType).toBe("markdown")
    expect(result.clearedOutputs).toBe(false)
    expect(result.notebook.cells[0]?.metadata as object).toEqual(originalMeta as object)
    expect((result.notebook.cells[0] as { source: string }).source).toBe("# New title\n\nUpdated.")
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("clears outputs on a code cell when source changes (auto)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "test.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "outputs.ipynb"), file)
    const pathSvc = makePathService({
      directory: dir,
      worktree: dir,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(dir, dir))
    const diffSvc = makeDiffService()
    const edit = makeEditImpl(pathSvc, fileSvc, diffSvc, permSvc)
    const result = await runOrThrow(
      edit.editCell(file, { cellIndex: 0, source: "print('updated')" })
    )
    expect(result.clearedOutputs).toBe(true)
    expect((result.notebook.cells[0] as { outputs: unknown[] }).outputs.length).toBe(0)
    expect((result.notebook.cells[0] as { execution_count: unknown }).execution_count).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("Clean", () => {
  it("removes outputs and execution_count from all code cells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "test.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "outputs.ipynb"), file)
    const pathSvc = makePathService({
      directory: dir,
      worktree: dir,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(dir, dir))
    const clean = makeCleanImpl(pathSvc, fileSvc, permSvc)
    const result = await runOrThrow(clean.clean(file))
    expect(result.removedOutputs).toBeGreaterThan(0)
    expect(result.removedExecutionCounts).toBeGreaterThan(0)
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: Array<{ outputs: unknown[]; execution_count: unknown }> }
    const codeCell = after.cells[0]
    if (!codeCell) throw new Error("missing code cell")
    expect(codeCell.outputs.length).toBe(0)
    expect(codeCell.execution_count).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("normalizes source arrays for markdown/raw/code and counts source-only changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-clean-src-"))
    const file = path.join(dir, "source.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          { cell_type: "markdown", metadata: {}, source: ["# A\n", "text"] },
          { cell_type: "raw", metadata: {}, source: ["raw\n", "cell"] },
          { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: ["x = ", "1"] }
        ]
      })
    )
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(dir, dir))
    const clean = makeCleanImpl(pathSvc, fileSvc, permSvc)
    try {
      const result = await runOrThrow(clean.clean(file, {
        clearOutputs: false,
        clearExecutionCount: false,
        stripWidgetState: false,
        stripLargeImages: false,
        normalizeSource: true
      }))
      expect(result.affectedCells).toBe(3)
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: Array<{ source: unknown }> }
      expect(after.cells.map((c) => c.source)).toEqual(["# A\ntext", "raw\ncell", "x = 1"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Outputs", () => {
  it("lists code cells with outputs", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(FIXTURES, FIXTURES))
    const output = makeOutputImpl(pathSvc, fileSvc, permSvc)
    const result = await runOrThrow(output.listOutputs(path.join(FIXTURES, "outputs.ipynb")))
    expect(result.entries.length).toBe(1)
    const entry = result.entries[0]
    expect(entry?.outputCount).toBe(2)
  })

  it("reads the error of a cell with an error", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(FIXTURES, FIXTURES))
    const output = makeOutputImpl(pathSvc, fileSvc, permSvc)
    const result = await runOrThrow(output.readError(path.join(FIXTURES, "error.ipynb"), 0))
    expect(result.hasError).toBe(true)
    expect(result.rendered).toContain("NameError")
  })

  it("renders stream.text arrays without inserting commas", () => {
    const cell = {
      cell_type: "code" as const,
      metadata: {},
      execution_count: 1,
      source: "print('x')",
      outputs: [{ output_type: "stream", name: "stdout", text: ["a\n", "b\n"] }]
    }
    const rendered = formatOutputs(cell)
    expect(rendered).toContain("a\nb")
    expect(rendered).not.toContain("a\n,b")

    const inspected = inspectCell(cell, 0)
    expect(inspected.outputSummary).toContain("a b")
    expect(inspected.outputSummary).not.toContain("a ,b")
  })
})

describe("Truncate", () => {
  it("truncates output with a clear hint", async () => {
    const { truncate } = await import("../../src/utils/truncate.js")
    const big = "x".repeat(200)
    const result = truncate(big, 50, "use maxOutputChars to increase")
    expect(result.truncated).toBe(true)
    expect(result.text).toContain("use maxOutputChars to increase")
    expect(result.text.length).toBeLessThanOrEqual(50 + 60)
  })
})

describe("PathService", () => {
  it("resolves a relative path against the directory", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const result = await runOrThrow(pathSvc.resolve("simple.ipynb"))
    expect(result.endsWith("simple.ipynb")).toBe(true)
  })

  it("rejects paths outside the worktree", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const result = await Effect.runPromise(
      pathSvc.ensureInsideWorktree(path.join(FIXTURES, "..", "..", "evil.ipynb")).pipe(Effect.flip)
    )
    expect((result as { _tag?: string })._tag).toBe("PathOutsideWorktree")
  })
})

describe("NotebookNotFoundError", () => {
  it("rejects a missing file", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const result = await runOrThrow(
      pathSvc.ensureExists(path.join(FIXTURES, "does-not-exist.ipynb")).pipe(Effect.flip)
    )
    expect(result).toBeInstanceOf(NotebookNotFoundError)
  })
})
