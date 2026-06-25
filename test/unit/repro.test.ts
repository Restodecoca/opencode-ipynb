import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePythonService } from "../../src/services/PythonService.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import {
  detectFilesystemReads,
  detectRandomSeeds,
  runRepro
} from "../../src/tools/repro.js"
import type { CodeCellRaw, MarkdownCellRaw, RawCellRaw } from "../../src/domain/cell.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"
import { buildServices } from "../../src/services/index.js"

const FIXTURES = path.resolve(__dirname, "..", "fixtures")

const pythonOnPath = (): boolean => {
  const r = spawnSync("python", ["-c", "import sys; print(sys.version)"], { encoding: "utf8" })
  return r.status === 0
}

const describeIf = (cond: boolean, name: string, fn: () => void): void => {
  if (cond) describe(name, fn)
  else describe.skip(name, fn)
}

const makeContext = (dir: string) =>
  (({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown) as Parameters<typeof makePermissionService>[0]

const codeCell = (source: string): CodeCellRaw => ({
  cell_type: "code",
  execution_count: null,
  metadata: {},
  outputs: [],
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
  metadata: {
    kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
    language_info: { name: "python" }
  },
  cells: [...cells]
})

describe("detectFilesystemReads", () => {
  it("flags cells with pd.read_csv, np.load, and open()", () => {
    const notebook = buildNotebook([
      codeCell("import pandas as pd\ndf = pd.read_csv('data.csv')"),
      codeCell("import numpy as np\na = np.load('weights.npy')"),
      codeCell("with open('notes.txt', 'r') as f:\n    text = f.read()")
    ])
    const hits = detectFilesystemReads(notebook)
    const patterns = hits.map((h) => `${h.cellIndex}:${h.pattern}`).sort()
    expect(patterns).toContain("0:pd.read_*")
    expect(patterns).toContain("0:read_csv")
    expect(patterns).toContain("1:np.load")
    expect(patterns).toContain("2:open(")
  })

  it("flags pd.read_json / pd.read_parquet / pd.read_excel / pd.read_table", () => {
    const notebook = buildNotebook([
      codeCell("pd.read_json('a.json')"),
      codeCell("pd.read_parquet('a.parquet')"),
      codeCell("pd.read_excel('a.xlsx')"),
      codeCell("pd.read_table('a.tsv')")
    ])
    const hits = detectFilesystemReads(notebook)
    const patterns = hits.map((h) => `${h.cellIndex}:${h.pattern}`).sort()
    expect(patterns).toEqual([
      "0:pd.read_*",
      "0:read_json",
      "1:pd.read_*",
      "1:read_parquet",
      "2:pd.read_*",
      "2:read_excel",
      "3:pd.read_*",
      "3:read_table"
    ])
  })

  it("flags pickle.load", () => {
    const notebook = buildNotebook([codeCell("import pickle\nx = pickle.load(open('x.pkl', 'rb'))")])
    const hits = detectFilesystemReads(notebook)
    expect(hits.some((h) => h.cellIndex === 0 && h.pattern === "pickle.load")).toBe(true)
    expect(hits.some((h) => h.cellIndex === 0 && h.pattern === "open(")).toBe(true)
  })

  it("returns an empty list for clean code cells", () => {
    const notebook = buildNotebook([codeCell("x = 1\ny = 2\nprint(x + y)")])
    expect(detectFilesystemReads(notebook)).toEqual([])
  })

  it("ignores markdown and raw cells", () => {
    const notebook = buildNotebook([
      markdownCell("You can use `pd.read_csv` and `open()` from the docs."),
      rawCell("np.load('x.npy')")
    ])
    expect(detectFilesystemReads(notebook)).toEqual([])
  })
})

describe("detectRandomSeeds", () => {
  it("flags cells with np.random.seed(...)", () => {
    const notebook = buildNotebook([
      codeCell("import numpy as np\nnp.random.seed(42)\nx = np.random.rand(3)")
    ])
    const hits = detectRandomSeeds(notebook)
    expect(hits).toEqual([{ cellIndex: 0, name: "np.random.seed" }])
  })

  it("flags cells with random.seed(", () => {
    const notebook = buildNotebook([codeCell("import random\nrandom.seed(0)")])
    const hits = detectRandomSeeds(notebook)
    expect(hits).toEqual([{ cellIndex: 0, name: "random.seed" }])
  })

  it("flags torch.manual_seed and tf.random.set_seed", () => {
    const notebook = buildNotebook([
      codeCell("import torch\ntorch.manual_seed(0)"),
      codeCell("import tensorflow as tf\ntf.random.set_seed(0)")
    ])
    const hits = detectRandomSeeds(notebook)
    expect(hits).toContainEqual({ cellIndex: 0, name: "torch.manual_seed" })
    expect(hits).toContainEqual({ cellIndex: 1, name: "tf.random.set_seed" })
  })

  it("returns an empty list for clean code cells", () => {
    const notebook = buildNotebook([codeCell("x = 1\ny = 2")])
    expect(detectRandomSeeds(notebook)).toEqual([])
  })

  it("ignores markdown and raw cells", () => {
    const notebook = buildNotebook([
      markdownCell("Use `np.random.seed(42)` to make this reproducible."),
      rawCell("random.seed(0)")
    ])
    expect(detectRandomSeeds(notebook)).toEqual([])
  })
})

describe("ipynb_repro > analyzeReproducibility integration", () => {
  it("renders long-source and non-determinism warnings in the report", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-repro-"))
    try {
      const bigSource = Array.from({ length: 501 }, (_, i) => `x${i} = ${i}`).join("\n")
      const file = path.join(dir, "x.ipynb")
      fs.writeFileSync(
        file,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
            language_info: { name: "python" }
          },
          cells: [
            { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: bigSource },
            { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "import numpy as np\nx = np.random.rand(3)" }
          ]
        })
      )
      const services = buildServices(makeContext(dir))
      const result = await Effect.runPromise(
        runRepro(services, { filePath: file })
      )
      expect(result.output).toContain("## Reproducibility warnings")
      expect(result.output).toContain("cell 0: source is 501 lines (consider splitting)")
      expect(result.output).toContain("cell 1: uses np.random without an explicit seed")
      expect(result.metadata.reproWarningCount).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it("renders Filesystem reads and Random seeds sections for a clean notebook", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-repro-"))
    try {
      const file = path.join(dir, "clean.ipynb")
      fs.writeFileSync(
        file,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
            language_info: { name: "python" }
          },
          cells: [
            { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "x = 1\nprint(x)" }
          ]
        })
      )
      const services = buildServices(makeContext(dir))
      const result = await Effect.runPromise(
        runRepro(services, { filePath: file })
      )
      expect(result.output).toContain("## Filesystem reads")
      expect(result.output).toMatch(/## Filesystem reads\n\(none\)/)
      expect(result.output).toContain("## Random seeds")
      expect(result.output).toMatch(/## Random seeds\n\(none\)/)
      expect(result.metadata.filesystemReadCount).toBe(0)
      expect(result.metadata.seedCount).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})

describeIf(pythonOnPath(), "ipynb_runner.py env mode (real Python)", () => {
  const HELPER = path.resolve(__dirname, "..", "..", "python", "ipynb_runner.py")
  const PYTHON = "python"

  const runHelper = (req: Record<string, unknown>): {
    status: number | null
    stdout: string
    stderr: string
  } => {
    const r = spawnSync(PYTHON, [HELPER], {
      encoding: "utf8",
      input: JSON.stringify(req)
    })
    return { status: r.status, stdout: r.stdout, stderr: r.stderr }
  }

  it("returns a valid env report for the sales fixture", () => {
    const filePath = path.join(FIXTURES, "sales.ipynb")
    const r = runHelper({ filePath, mode: "env" })
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      success: boolean
      executedCells: number[]
      durationMs: number
      env: {
        kernelDisplayName: string | null
        kernelName: string | null
        language: string | null
        pythonVersion: string
        pythonExecutable: string
        platform: string
        pipFreeze: string[]
      }
    }
    expect(parsed.success).toBe(true)
    expect(parsed.executedCells).toEqual([])
    expect(typeof parsed.durationMs).toBe("number")
    expect(parsed.env.kernelDisplayName).toBe("Python 3")
    expect(parsed.env.kernelName).toBe("python3")
    expect(parsed.env.language).toBe("python")
    expect(parsed.env.pythonVersion).toMatch(/^\d+\.\d+/)
    expect(parsed.env.pythonExecutable.length).toBeGreaterThan(0)
    expect(parsed.env.platform.length).toBeGreaterThan(0)
    expect(Array.isArray(parsed.env.pipFreeze)).toBe(true)
  })

  it("rejects when the notebook path is invalid (returns success: false with an error)", () => {
    const filePath = path.join(os.tmpdir(), "ipynb-does-not-exist-xyz.ipynb")
    const r = runHelper({ filePath, mode: "env" })
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      success: boolean
      error: { ename: string; evalue: string }
    }
    expect(parsed.success).toBe(false)
    expect(parsed.error.ename).toBe("FileNotFoundError")
    expect(parsed.error.evalue).toContain("Notebook not found")
  })

  it("rejects when the notebook is not valid JSON", () => {
    const filePath = path.join(os.tmpdir(), `ipynb-bad-json-${Date.now()}.ipynb`)
    fs.writeFileSync(filePath, "{not valid json")
    try {
      const r = runHelper({ filePath, mode: "env" })
      expect(r.status).toBe(0)
      const parsed = JSON.parse(r.stdout) as {
        success: boolean
        error: { ename: string }
      }
      expect(parsed.success).toBe(false)
      expect(parsed.error.ename).toBe("JSONDecodeError")
    } finally {
      fs.rmSync(filePath, { force: true })
    }
  })

  it("rejects when the mode is invalid", () => {
    const r = runHelper({ filePath: path.join(FIXTURES, "sales.ipynb"), mode: "bogus" })
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      success: boolean
      error: { ename: string; evalue: string }
    }
    expect(parsed.success).toBe(false)
    expect(parsed.error.evalue).toContain("invalid mode")
  })
})

describeIf(pythonOnPath(), "NotebookExecutionService.reportEnv", () => {
  const buildExec = (dir: string) => {
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const permSvc = makePermissionService(makeContext(dir))
    const fileSvc = makeNotebookFileService()
    const pythonSvc = makePythonService({
      pythonPath: "python",
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    return makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc)
  }

  it("returns an env report for the sales fixture end-to-end", async () => {
    const env = await Effect.runPromise(
      buildExec(FIXTURES).reportEnv(path.join(FIXTURES, "sales.ipynb"))
    )
    expect(env.kernelDisplayName).toBe("Python 3")
    expect(env.kernelName).toBe("python3")
    expect(env.language).toBe("python")
    expect(env.pythonVersion).toMatch(/^\d+\.\d+/)
    expect(env.pythonExecutable.length).toBeGreaterThan(0)
    expect(env.platform.length).toBeGreaterThan(0)
    expect(Array.isArray(env.pipFreeze)).toBe(true)
  }, 60_000)

  it("fails with NotebookNotFoundError for a missing file", async () => {
    const exit = await Effect.runPromiseExit(
      buildExec(FIXTURES).reportEnv(path.join(os.tmpdir(), "missing-xyz.ipynb"))
    )
    expect(exit._tag).toBe("Failure")
  })

  it("fails with NotebookValidationError for a non-notebook JSON file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-repro-"))
    try {
      const file = path.join(dir, "notebook.json")
      fs.writeFileSync(file, JSON.stringify({ hello: "world" }))
      const exit = await Effect.runPromiseExit(buildExec(dir).reportEnv(file))
      expect(exit._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
