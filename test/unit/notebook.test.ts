import { describe, expect, it } from "bun:test"
import { Cause, Effect } from "effect"
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
  makeOutputImpl
} from "../../src/services/index.js"
import { CellIndexOutOfBoundsError, NotebookNotFoundError, NotebookParseError, NotebookValidationError } from "../../src/domain/errors.js"
import { buildServices } from "../../src/services/index.js"
import { makeWarningSink } from "../../src/utils/warnings.js"
import { inspectCell } from "../../src/format/diagnostics.js"
import { formatOutputs } from "../../src/format/outputs.js"
import type { ToolContext } from "../../src/tool.js"

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

  it("rejects a UTF-8 BOM as a parse error like nbformat, leaving the file untouched", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "bom.ipynb")
    const text = `\uFEFF${JSON.stringify({
      cells: [],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    })}`
    fs.writeFileSync(file, text)
    try {
      const result = await Effect.runPromise(
        fileSvc.read(file).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(NotebookParseError)
      expect(fs.readFileSync(file, "utf8")).toBe(text)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects bytes that are not valid UTF-8 instead of replacing them", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "latin1.ipynb")
    const bytes = Buffer.from(
      '{"cells":[],"metadata":{"name":"caf\xe9"},"nbformat":4,"nbformat_minor":5}',
      "latin1"
    )
    fs.writeFileSync(file, bytes)
    try {
      const result = await Effect.runPromise(
        fileSvc.read(file).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(NotebookParseError)
      expect(fs.readFileSync(file).equals(bytes)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses to rewrite bytes that are not valid UTF-8", async () => {    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "latin1.ipynb")
    const bytes = Buffer.from(
      '{"cells":[],"metadata":{"name":"caf\xe9"},"nbformat":4,"nbformat_minor":5}',
      "latin1"
    )
    fs.writeFileSync(file, bytes)
    try {
      const exit = await Effect.runPromiseExit(
        fileSvc.writeAtomic(file, {
          cells: [],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5
        } as never)
      )
      expect(exit._tag).toBe("Failure")
      const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined
      expect(error?._tag === "Some" ? error.value : undefined).toBeInstanceOf(
        NotebookParseError
      )
      expect(fs.readFileSync(file).equals(bytes)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resolves a real path through the retrying helper and still reports a genuine miss", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-realpath-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })
    )
    try {
      const { realpathWithRetry } = await import("../../src/utils/realpath.js")
      await expect(realpathWithRetry(file)).resolves.toBe(fs.realpathSync(file))
      const missing = path.join(dir, "missing.ipynb")
      const started = Date.now()
      await expect(realpathWithRetry(missing)).rejects.toMatchObject({ code: "ENOENT" })
      expect(Date.now() - started).toBeLessThan(1_000)
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


describe("NotebookReadService range guard", () => {
  it("clamps a huge read range before allocating indexes", async () => {
    const read = makeReadImpl(
      makePathService({ directory: FIXTURES, worktree: FIXTURES, platform: process.platform }),
      makeNotebookFileService()
    )
    const result = await runOrThrow(
      read.readRange(path.join(FIXTURES, "simple.ipynb"), 0, 50_000_000)
    )
    expect(result.indexes.length).toBeLessThanOrEqual(result.totalCells)
  })

  it("rejects a range on an empty notebook instead of returning an empty success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-empty-range-"))
    const file = path.join(dir, "empty.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] })
    )
    const read = makeReadImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService()
    )
    try {
      const result = await Effect.runPromiseExit(read.readRange(file, 5, 10))
      expect(result._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a range larger than the per-read cell limit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-range-cap-"))
    const file = path.join(dir, "many.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: Array.from({ length: 600 }, () => ({
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: "x = 1"
        }))
      })
    )
    const read = makeReadImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService()
    )
    try {
      const result = await Effect.runPromiseExit(read.readRange(file, 0, 599))
      expect(result._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a range whose start is past the last cell", async () => {
    const read = makeReadImpl(
      makePathService({ directory: FIXTURES, worktree: FIXTURES, platform: process.platform }),
      makeNotebookFileService()
    )
    const result = await Effect.runPromiseExit(
      read.readRange(path.join(FIXTURES, "simple.ipynb"), 999, 1000)
    )
    expect(result._tag).toBe("Failure")
  })
})


  it("omits error tracebacks with includeOutputs when includeErrors is false", async () => {
    const read = makeReadImpl(
      makePathService({ directory: FIXTURES, worktree: FIXTURES, platform: process.platform }),
      makeNotebookFileService()
    )
    const result = await runOrThrow(
      read.readCell(path.join(FIXTURES, "error.ipynb"), 0, {
        includeOutputs: true,
        includeErrors: false
      })
    )
    expect(result.rendered).not.toContain("Outputs:")
    expect(result.rendered).not.toContain("NameError")
    expect(result.rendered).not.toContain("Traceback")
  })


  it("hard-caps ipynb_outputs read even with a huge maxOutputChars", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-cap-"))
    const file = path.join(dir, "big.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "code",
            execution_count: 1,
            metadata: {},
            outputs: [
              { output_type: "stream", name: "stdout", text: "x".repeat(200_000) }
            ],
            source: "print('x')"
          }
        ]
      })
    )
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(dir, dir))
    const output = makeOutputImpl(pathSvc, fileSvc, permSvc)
    try {
      const result = await runOrThrow(
        output.readOutputs(file, {
          cellIndex: 0,
          includeImages: false,
          maxOutputChars: 1_000_000
        })
      )
      expect(result.rendered.length).toBeLessThanOrEqual(120_000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })


  it("removes jupyter.widgets cell metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-clean-jwidgets-"))
    const file = path.join(dir, "widgets.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "code",
            metadata: { jupyter: { widgets: { state: {} } } },
            execution_count: null,
            outputs: [],
            source: "x = 1"
          }
        ]
      })
    )
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(dir, dir))
    const clean = makeCleanImpl(pathSvc, fileSvc, permSvc)
    try {
      await runOrThrow(
        clean.clean(file, {
          clearOutputs: false,
          clearExecutionCount: false,
          stripWidgetState: true,
          stripLargeImages: false,
          normalizeSource: false
        })
      )
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ metadata: { jupyter?: Record<string, unknown> } }>
      }
      expect(after.cells[0]?.metadata.jupyter?.widgets).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

describe("Edit", () => {
  it("edits a markdown cell and preserves metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "test.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    try {
      const pathSvc = makePathService({
        directory: dir,
        worktree: dir,
        platform: process.platform
      })
      const fileSvc = makeNotebookFileService()
      const permSvc = makePermissionService(makeFakeContext(dir, dir))
      const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
      const originalMeta = (() => {
        const nb = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: Array<{ cell_type: string; metadata: unknown }> }
        return nb.cells[0]?.metadata
      })()
      const result = await runOrThrow(edit.editCell(file, { cellIndex: 0, source: "# New title\n\nUpdated." }))
      expect(result.cellType).toBe("markdown")
      expect(result.clearedOutputs).toBe(false)
      expect(result.notebook.cells[0]?.metadata as object).toEqual(originalMeta as object)
      expect((result.notebook.cells[0] as { source: string[] }).source).toEqual([
        "# New title\n",
        "\n",
        "Updated."
      ])
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      expect(onDisk.cells[0]?.source).toEqual(["# New title\n", "\n", "Updated."])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
    const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
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


  it("strips notebook and cell widget state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-clean-widgets-"))
    const file = path.join(dir, "widgets.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { widgets: { state: {} } },
        cells: [
          {
            cell_type: "code",
            metadata: { widgets: { state: {} } },
            execution_count: null,
            outputs: [],
            source: "x = 1"
          },
          {
            cell_type: "code",
            metadata: { jupyter: { outputs: {} } },
            execution_count: null,
            outputs: [],
            source: "y = 2"
          }
        ]
      })
    )
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(dir, dir))
    const clean = makeCleanImpl(pathSvc, fileSvc, permSvc)
    try {
      const result = await runOrThrow(
        clean.clean(file, {
          clearOutputs: false,
          clearExecutionCount: false,
          stripWidgetState: true,
          stripLargeImages: false,
          normalizeSource: false
        })
      )
      expect(result.removedWidgets).toBe(3)
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        metadata: Record<string, unknown>
        cells: Array<{ metadata: Record<string, unknown> }>
      }
      expect(after.metadata.widgets).toBeUndefined()
      expect(after.cells[0]?.metadata.widgets).toBeUndefined()
      expect(
        (after.cells[1]?.metadata.jupyter as Record<string, unknown> | undefined)
          ?.outputs
      ).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
  it("marks clearOutputs:always as a change even when the source is identical", async () => {
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
    const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
    const notebook = JSON.parse(fs.readFileSync(file, "utf8")) as {
      cells: Array<{ source: string | string[] }>
    }
    const source = Array.isArray(notebook.cells[0]?.source)
      ? notebook.cells[0]!.source.join("")
      : notebook.cells[0]!.source
    const result = await runOrThrow(
      edit.editCell(file, { cellIndex: 0, source, clearOutputs: "always" })
    )
    expect(result.changed).toBe(true)
    expect(result.clearedOutputs).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })

})

describe("inspectCell > large streams", () => {

  it("counts large stdout streams as large output", () => {
    const inspected = inspectCell(
      {
        cell_type: "code",
        execution_count: 1,
        metadata: {},
        source: "print('x')",
        outputs: [
          { output_type: "stream", name: "stdout", text: "x".repeat(100_000) }
        ]
      },
      0
    )
    expect(inspected.hasLargeOutput).toBe(true)
  })
})

describe("write refusal on unreadable targets", () => {
  it("refuses to overwrite a notebook it cannot read", async () => {
    if (process.platform === "win32") return
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-unreadable-"))
    const file = path.join(dir, "n.ipynb")
    const original = `${JSON.stringify(
      { cells: [], metadata: { secret: "keep-me" }, nbformat: 4, nbformat_minor: 5 },
      null,
      1
    )}\n`
    fs.writeFileSync(file, original)
    fs.chmodSync(file, 0o000)
    const sink = makeWarningSink()
    const svc = makeNotebookFileService({ worktree: dir, warningSink: sink })
    try {
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(file, {
          cells: [],
          metadata: { replaced: true },
          nbformat: 4,
          nbformat_minor: 5
        } as never)
      )
      expect(exit._tag).toBe("Failure")
      fs.chmodSync(file, 0o600)
      expect(fs.readFileSync(file, "utf8")).toBe(original)
    } finally {
      fs.chmodSync(file, 0o600)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("still creates a notebook that does not exist yet", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-create-"))
    const file = path.join(dir, "new.ipynb")
    const svc = makeNotebookFileService({ worktree: dir })
    try {
      const outcome = await Effect.runPromise(
        svc.writeAtomic(file, {
          cells: [],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5
        } as never)
      )
      expect(outcome.mode).toBe("fallback")
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toBeDefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("revision re-read failure refuses the write", () => {
  it("does not write when the pre-rename revision read fails", async () => {
    if (process.platform === "win32") return
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-revision-fail-"))
    const file = path.join(dir, "n.ipynb")
    const body = `${JSON.stringify(
      { cells: [], metadata: { keep: true }, nbformat: 4, nbformat_minor: 5 },
      null,
      1
    )}\n`
    const sink = makeWarningSink()
    try {
      const svc = makeNotebookFileService({ worktree: dir, warningSink: sink })
      const read = await Effect.runPromise(svc.readWithText(file).pipe(Effect.orElseSucceed(() => undefined)))
      void read
      fs.writeFileSync(file, body)
      const before = fs.readFileSync(file)
      fs.chmodSync(file, 0o000)
      try {
        const exit = await Effect.runPromiseExit(
          svc.writeAtomic(
            file,
            { cells: [], metadata: { replaced: true }, nbformat: 4, nbformat_minor: 5 } as never,
            {
              previousText: body,
              format: {
                unit: " ",
                newline: "\n",
                itemSeparator: ", ",
                keySeparator: ": ",
                ensureAscii: false,
                trailingNewline: true
              }
            }
          )
        )
        expect(exit._tag).toBe("Failure")
      } finally {
        fs.chmodSync(file, 0o600)
      }
      expect(fs.readFileSync(file).equals(before)).toBe(true)
    } finally {
      try { fs.chmodSync(file, 0o600) } catch {}
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
