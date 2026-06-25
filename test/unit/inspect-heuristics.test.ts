import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  makePathService,
  makeNotebookFileService
} from "../../src/services/index.js"
import {
  makeInspectImpl,
  formatInspectSummary,
  analyzeReproducibility,
  type InspectSummary,
  type CellInspection
} from "../../src/services/NotebookInspectService.js"
import type { CodeCellRaw, MarkdownCellRaw, RawCellRaw } from "../../src/domain/cell.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"

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

const codeCell = (
  source: string,
  outputs: ReadonlyArray<Record<string, unknown>> = []
): CodeCellRaw => ({
  cell_type: "code",
  execution_count: outputs.length > 0 ? 1 : null,
  metadata: {},
  outputs: [...outputs],
  source
})

const markdownCell = (source: string): MarkdownCellRaw => ({
  cell_type: "markdown",
  metadata: {},
  source
})

const rawCell = (source: string): RawCellRaw => ({
  cell_type: "raw",
  metadata: {},
  source
})

const buildNotebook = (cells: ReadonlyArray<CodeCellRaw | MarkdownCellRaw | RawCellRaw>): NotebookRaw => ({
  nbformat: 4,
  metadata: {},
  cells: [...cells]
})

const writeNotebook = (dir: string, name: string, cells: ReadonlyArray<unknown>): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(
    file,
    JSON.stringify({
      cells,
      metadata: {
        kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })
  )
  return file
}

const buildInspect = (directory: string, worktree: string) => {
  const pathSvc = makePathService({
    directory,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  return makeInspectImpl(pathSvc, fileSvc)
}

describe("analyzeReproducibility > long source", () => {
  it("flags a code cell with more than 500 lines", () => {
    const bigSource = Array.from({ length: 501 }, (_, i) => `x${i} = ${i}`).join("\n")
    const notebook = buildNotebook([codeCell(bigSource)])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toMatch(/^cell 0: source is 501 lines \(consider splitting\)$/)
  })

  it("does not flag a code cell with exactly 500 lines", () => {
    const source = Array.from({ length: 500 }, (_, i) => `x${i} = ${i}`).join("\n")
    const notebook = buildNotebook([codeCell(source)])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings.some((w) => w.includes("source is"))).toBe(false)
  })

  it("ignores markdown and raw cells when counting source lines", () => {
    const bigMarkdown = Array.from({ length: 800 }, (_, i) => `line ${i}`).join("\n")
    const notebook = buildNotebook([markdownCell(bigMarkdown), rawCell(bigMarkdown)])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toEqual([])
  })
})

describe("analyzeReproducibility > non-deterministic patterns", () => {
  it("flags random.seed( as a call site warning", () => {
    const notebook = buildNotebook([codeCell("import random\nrandom.seed(0)\nprint('ok')")])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toContain(
      "cell 0: random.seed is called inside the notebook (deterministic only when re-executed in order)"
    )
  })

  it("flags np.random without an explicit seed", () => {
    const notebook = buildNotebook([codeCell("import numpy as np\nx = np.random.rand(3)\nprint(x)")])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toContain("cell 0: uses np.random without an explicit seed")
  })

  it("flags numpy.random with its own dedicated warning", () => {
    const notebook = buildNotebook([codeCell("import numpy\nx = numpy.random.rand(3)")])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toContain("cell 0: uses numpy.random without an explicit seed")
  })

  it("emits a distinct warning text for numpy.random vs np.random", () => {
    const numpyRandom = buildNotebook([codeCell("import numpy\nx = numpy.random.rand(3)")])
    const npRandom = buildNotebook([codeCell("import numpy as np\nx = np.random.rand(3)")])
    expect(analyzeReproducibility(numpyRandom)).toContain("cell 0: uses numpy.random without an explicit seed")
    expect(analyzeReproducibility(numpyRandom)).not.toContain("cell 0: uses np.random without an explicit seed")
    expect(analyzeReproducibility(npRandom)).toContain("cell 0: uses np.random without an explicit seed")
    expect(analyzeReproducibility(npRandom)).not.toContain("cell 0: uses numpy.random without an explicit seed")
  })

  it("flags time.time, time.sleep, datetime.now, and datetime.today as wall-clock warnings", () => {
    const notebook = buildNotebook([
      codeCell("import time\nt = time.time()"),
      codeCell("import time\ntime.sleep(1)"),
      codeCell("import datetime\nn = datetime.datetime.now()"),
      codeCell("import datetime\nd = datetime.datetime.today()")
    ])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toContain("cell 0: depends on wall-clock time")
    expect(warnings).toContain("cell 1: depends on wall-clock time")
    expect(warnings).toContain("cell 2: depends on wall-clock time")
    expect(warnings).toContain("cell 3: depends on wall-clock time")
  })

  it("flags os.environ[ and os.getenv( as environment reads", () => {
    const notebook = buildNotebook([
      codeCell("import os\nkey = os.environ['API_KEY']"),
      codeCell("import os\ntoken = os.getenv('TOKEN', 'default')")
    ])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toContain("cell 0: reads environment variables (output may vary across machines)")
    expect(warnings).toContain("cell 1: reads environment variables (output may vary across machines)")
  })

  it("emits one warning per category even when a cell matches multiple times", () => {
    const notebook = buildNotebook([
      codeCell("import time\nprint(time.time())\nprint(time.time())\nprint(time.time())")
    ])
    const warnings = analyzeReproducibility(notebook)
    const wallClockWarnings = warnings.filter((w) => w === "cell 0: depends on wall-clock time")
    expect(wallClockWarnings.length).toBe(1)
  })

  it("does not flag clean code cells", () => {
    const notebook = buildNotebook([codeCell("x = 1\ny = 2\nprint(x + y)")])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toEqual([])
  })

  it("does not run non-deterministic rules on markdown or raw cells", () => {
    const notebook = buildNotebook([
      markdownCell("# heading\n\nrandom.seed(0) is mentioned in prose"),
      rawCell("np.random.rand(0)")
    ])
    const warnings = analyzeReproducibility(notebook)
    expect(warnings).toEqual([])
  })
})

describe("analyzeReproducibility > integration via inspect", () => {
  it("populates reproducibilityWarnings on InspectSummary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-inspect-"))
    try {
      const file = writeNotebook(dir, "rep.ipynb", [
        codeCell("import numpy as np\nx = np.random.rand(3)"),
        codeCell("import os\nkey = os.environ['FOO']"),
        codeCell("x = 1")
      ])
      const inspect = buildInspect(dir, dir)
      const summary = await runOrThrow(inspect.inspect(file))
      expect(summary.reproducibilityWarnings).toBeDefined()
      expect(summary.reproducibilityWarnings).toContain("cell 0: uses np.random without an explicit seed")
      expect(summary.reproducibilityWarnings).toContain(
        "cell 1: reads environment variables (output may vary across machines)"
      )
      expect(summary.reproducibilityWarnings?.length).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns an empty array for a fixture that has no warnings", async () => {
    const inspect = buildInspect(FIXTURES, FIXTURES)
    const summary = await runOrThrow(inspect.inspect(path.join(FIXTURES, "simple.ipynb")))
    expect(summary.reproducibilityWarnings).toBeDefined()
    expect(summary.reproducibilityWarnings).toEqual([])
  })
})

describe("formatInspectSummary > reproducibility section", () => {
  const cellInspection: CellInspection = {
    index: 0,
    cellType: "code",
    executionCount: null,
    sourceLines: 1,
    hasOutputs: false,
    hasError: false,
    hasLargeOutput: false,
    hasImage: false,
    firstLine: "x = 1",
    outputSummary: "(no output)"
  }

  const emptyNotebook: NotebookRaw = buildNotebook([codeCell("x = 1")])

  it("renders (none) when reproducibilityWarnings is empty", () => {
    const summary: InspectSummary = {
      filePath: "/x.ipynb",
      displayPath: "x.ipynb",
      notebook: emptyNotebook,
      cells: [cellInspection],
      totalCells: 1,
      truncated: false,
      reproducibilityWarnings: []
    }
    const out = formatInspectSummary(summary)
    expect(out).toContain("## Reproducibility warnings")
    expect(out).toContain("(none)")
  })

  it("renders one bullet per warning when warnings are present", () => {
    const summary: InspectSummary = {
      filePath: "/x.ipynb",
      displayPath: "x.ipynb",
      notebook: emptyNotebook,
      cells: [cellInspection],
      totalCells: 1,
      truncated: false,
      reproducibilityWarnings: ["cell 0: uses np.random without an explicit seed"]
    }
    const out = formatInspectSummary(summary)
    expect(out).toContain("## Reproducibility warnings")
    expect(out).toContain("- cell 0: uses np.random without an explicit seed")
    expect(out).not.toContain("(none)")
  })

  it("places the section after the cell table", () => {
    const summary: InspectSummary = {
      filePath: "/x.ipynb",
      displayPath: "x.ipynb",
      notebook: emptyNotebook,
      cells: [cellInspection],
      totalCells: 1,
      truncated: false,
      reproducibilityWarnings: ["cell 0: depends on wall-clock time"]
    }
    const out = formatInspectSummary(summary)
    const tableEnd = out.indexOf("| 0 | code |")
    const sectionStart = out.indexOf("## Reproducibility warnings")
    expect(tableEnd).toBeGreaterThan(-1)
    expect(sectionStart).toBeGreaterThan(-1)
    expect(sectionStart).toBeGreaterThan(tableEnd)
  })
})
