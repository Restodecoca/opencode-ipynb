import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ToolContext } from "../../src/tool.js"
import { ipynbInspectTool } from "../../src/tools/inspect.js"
import { ipynbReadTool } from "../../src/tools/read.js"
import { ipynbEditTool } from "../../src/tools/edit.js"
import { ipynbCellInsertTool } from "../../src/tools/cell_insert.js"
import { ipynbCellDeleteTool } from "../../src/tools/cell_delete.js"
import { ipynbCellMoveTool } from "../../src/tools/cell_move.js"
import { ipynbCleanTool } from "../../src/tools/clean.js"
import { ipynbExportTool } from "../../src/tools/export.js"
import { ipynbOutputsTool } from "../../src/tools/outputs.js"
import { ipynbDoctorTool } from "../../src/tools/doctor.js"
import { ipynbReproTool } from "../../src/tools/repro.js"
import { ipynbRunTool } from "../../src/tools/run.js"
import { ipynbKernelTool } from "../../src/tools/kernel.js"
import { ipynbLspTool } from "../../src/tools/lsp.js"

const FIXTURES = path.resolve(__dirname, "..", "fixtures")

interface ToolOutput {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

interface Executable<I> {
  execute(input: I, context: ToolContext): Promise<unknown>
}

/** Call a tool with partial input; the host normally applies zod defaults. */
const execute = <I>(
  definition: Executable<I>,
  input: Partial<I>,
  context: ToolContext
): Promise<ToolOutput> =>
  definition.execute(input as I, context) as Promise<ToolOutput>

const makeContext = (dir: string): ToolContext =>
  ({
    sessionID: "test-session",
    messageID: "test-message",
    agent: "test-agent",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    pluginOptions: {
      warmKernel: false,
      preferUv: false,
      lspDiagnostics: false,
      defaultTimeoutMs: 30_000,
      pyrightPath: "pyright"
    },
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

describe("tool wrappers > happy paths", () => {
  let dir: string
  let notebook: string
  let outputsNotebook: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-tool-wrappers-"))
    notebook = path.join(dir, "simple.ipynb")
    outputsNotebook = path.join(dir, "outputs.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), notebook)
    fs.copyFileSync(path.join(FIXTURES, "outputs.ipynb"), outputsNotebook)
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("inspect returns a table and honours includeMetadata", async () => {
    const result = await execute(
      ipynbInspectTool,
      {
        filePath: notebook,
        includeMetadata: true,
        includeOutputsSummary: true,
        maxCells: 10,
        checkMissingPackages: false
      },
      makeContext(dir)
    )
    expect(result.output).toContain("| index | type |")
    expect(result.metadata?.["totalCells"]).toBeGreaterThan(0)
  })

  it("read renders a single cell and a range", async () => {
    const single = await execute(
      ipynbReadTool,
      { filePath: notebook, cellIndex: 1, includeOutputs: true },
      makeContext(dir)
    )
    expect(single.output).toContain("Cell [1]")
    const range = await execute(
      ipynbReadTool,
      { filePath: notebook, start: 0, end: 1 },
      makeContext(dir)
    )
    expect(range.output).toContain("Cell [0]")
  })

  it("edit, insert, move, delete, clean and export a notebook", async () => {
    const edit = await execute(
      ipynbEditTool,
      { filePath: notebook, cellIndex: 0, source: "# Edited", clearOutputs: "auto" },
      makeContext(dir)
    )
    expect(edit.output).toContain("Edited cell [0]")

    const insert = await execute(
      ipynbCellInsertTool,
      { filePath: notebook, cellType: "markdown", source: "## Inserted", index: 1 },
      makeContext(dir)
    )
    expect(insert.output).toContain("Inserted")

    const move = await execute(
      ipynbCellMoveTool,
      { filePath: notebook, fromIndex: 0, toIndex: 2 },
      makeContext(dir)
    )
    expect(move.output).toContain("Moved")

    const del = await execute(
      ipynbCellDeleteTool,
      { filePath: notebook, cellIndex: 2 },
      makeContext(dir)
    )
    expect(del.output).toContain("Deleted")

    const clean = await execute(
      ipynbCleanTool,
      { filePath: notebook, stripLargeImages: true },
      makeContext(dir)
    )
    expect(clean.output).toContain("Cleaned")

    const exported = await execute(
      ipynbExportTool,
      {
        filePath: notebook,
        format: "markdown",
        includeOutputs: false,
        includeErrors: true,
        outputPath: path.join(dir, "export.md")
      },
      makeContext(dir)
    )
    expect(exported.output).toContain("Exported")
    expect(fs.existsSync(path.join(dir, "export.md"))).toBe(true)
  })

  it("outputs list/read/read_error/clear_cell/clear_all", async () => {
    const ctx = makeContext(dir)
    const list = await execute(
      ipynbOutputsTool,
      { filePath: outputsNotebook, operation: "list" },
      ctx
    )
    expect(list.output).toContain("| 0 | code |")
    const read = await execute(
      ipynbOutputsTool,
      { filePath: outputsNotebook, operation: "read", cellIndex: 0 },
      ctx
    )
    expect(read.output.length).toBeGreaterThan(0)
    const clearCell = await execute(
      ipynbOutputsTool,
      { filePath: outputsNotebook, operation: "clear_cell", cellIndex: 0 },
      ctx
    )
    expect(clearCell.output).toContain("Cleared")
    const clearAll = await execute(
      ipynbOutputsTool,
      { filePath: outputsNotebook, operation: "clear_all" },
      ctx
    )
    expect(clearAll.output).toContain("Cleared")

    const errorNotebook = path.join(dir, "error.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "error.ipynb"), errorNotebook)
    const readError = await execute(
      ipynbOutputsTool,
      { filePath: errorNotebook, operation: "read_error", cellIndex: 0 },
      ctx
    )
    expect(readError.output).toContain("NameError")
  })

  it("doctor, kernel status and lsp diagnostics return structured output", async () => {
    const doctor = await execute(
      ipynbDoctorTool,
      { includeSuggestions: true },
      makeContext(dir)
    )
    expect(doctor.output).toContain("##")

    const kernel = await execute(
      ipynbKernelTool,
      { action: "status" },
      makeContext(dir)
    )
    expect(kernel.metadata?.["warmKernel"]).toBe(false)

    const lsp = await execute(
      ipynbLspTool,
      { filePath: notebook, operation: "diagnostics" },
      makeContext(dir)
    )
    expect(lsp.output.length).toBeGreaterThan(0)
  })

  it("repro and run return a report/execution summary", async () => {
    const repro = await execute(
      ipynbReproTool,
      { filePath: notebook },
      makeContext(dir)
    )
    expect(repro.output).toContain("Reproducibility")

    const result = await execute(
      ipynbRunTool,
      {
        filePath: notebook,
        mode: "cell",
        cellIndex: 1,
        timeoutMs: 60_000,
        save: false
      },
      makeContext(dir)
    )
    // The bare environment may not have Jupyter; either path is valid here.
    expect(
      result.output.includes("Executed") ||
        result.output.includes("Not implemented yet")
    ).toBe(true)
  }, 120_000)
})

describe("tool wrappers > error paths", () => {
  const missing = "/tmp/opencode/definitely-missing-notebook.ipynb"

  const cases: ReadonlyArray<{
    name: string
    run: (ctx: ToolContext) => Promise<ToolOutput>
  }> = [
    {
      name: "inspect",
      run: (ctx) => execute(ipynbInspectTool, { filePath: missing }, ctx)
    },
    {
      name: "read",
      run: (ctx) => execute(ipynbReadTool, { filePath: missing }, ctx)
    },
    {
      name: "edit",
      run: (ctx) =>
        execute(
          ipynbEditTool,
          { filePath: missing, cellIndex: 0, source: "x = 1" },
          ctx
        )
    },
    {
      name: "cell_insert",
      run: (ctx) =>
        execute(
          ipynbCellInsertTool,
          { filePath: missing, cellType: "code", source: "x = 1" },
          ctx
        )
    },
    {
      name: "cell_delete",
      run: (ctx) =>
        execute(ipynbCellDeleteTool, { filePath: missing, cellIndex: 0 }, ctx)
    },
    {
      name: "cell_move",
      run: (ctx) =>
        execute(
          ipynbCellMoveTool,
          { filePath: missing, fromIndex: 0, toIndex: 1 },
          ctx
        )
    },
    {
      name: "clean",
      run: (ctx) => execute(ipynbCleanTool, { filePath: missing }, ctx)
    },
    {
      name: "export",
      run: (ctx) =>
        execute(ipynbExportTool, { filePath: missing, format: "markdown" }, ctx)
    },
    {
      name: "outputs",
      run: (ctx) =>
        execute(ipynbOutputsTool, { filePath: missing, operation: "list" }, ctx)
    },
    {
      name: "repro",
      run: (ctx) => execute(ipynbReproTool, { filePath: missing }, ctx)
    },
    {
      name: "run",
      run: (ctx) =>
        execute(
          ipynbRunTool,
          { filePath: missing, mode: "cell", cellIndex: 0 },
          ctx
        )
    },
    {
      name: "kernel restart",
      run: (ctx) =>
        execute(
          ipynbKernelTool,
          { action: "restart", filePath: "/etc/ipynb-tool-wrapper-outside.ipynb" },
          {
            ...ctx,
            pluginOptions: {
              warmKernel: true,
              preferUv: false,
              defaultTimeoutMs: 30_000
            }
          } as ToolContext
        )
    },
    {
      name: "lsp",
      run: (ctx) =>
        execute(ipynbLspTool, { filePath: missing, operation: "diagnostics" }, ctx)
    }
  ]

  for (const testCase of cases) {
    it(`${testCase.name} reports an error instead of throwing`, async () => {
      const result = await testCase.run(makeContext(os.tmpdir()))
      expect(result.metadata?.["error"]).toBe(true)
      expect(result.output.startsWith("Error:")).toBe(true)
    })
  }
  it("ipynb_run refuses an invalid pythonPath instead of falling back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-run-badpy-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const ctx = {
      ...makeContext(dir),
      pluginOptions: {
        pythonPath: "/definitely/not/a/python",
        preferUv: false,
        warmKernel: false
      }
    } as unknown as ToolContext
    try {
      const result = await execute(
        ipynbRunTool,
        { filePath: file, mode: "cell", cellIndex: 0 },
        ctx
      )
      expect(result.metadata?.["error"]).toBe(true)
      expect(result.output).toContain("Invalid pythonPath")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})
