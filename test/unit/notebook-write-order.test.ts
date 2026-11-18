import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  makeCleanImpl,
  makeEditImpl,
  makeExecutionImpl,
  makeNotebookFileService,
  makeOutputImpl,
  makePathService,
  makePermissionService
} from "../../src/services/index.js"
import type { CodeCellRaw } from "../../src/domain/cell.js"
import type { KernelManagerShape } from "../../src/services/KernelManager.js"
import type { PythonServiceShape } from "../../src/services/PythonService.js"
import type { ToolContext } from "../../src/tool.js"

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

/**
 * The notebook convention described in issue #2: `json.dumps(..., sort_keys=True,
 * indent=1)`, which is what nbformat's writer, VS Code, and Databricks produce.
 * Insertion order below is already alphabetical so the stored text is realistic.
 */
const storedNotebook = (): Record<string, unknown> => ({
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: {
        "application/vnd.databricks.v1+cell": { showTitle: false }
      },
      source: ["# Title"]
    },
    {
      cell_type: "code",
      execution_count: 1,
      id: "code",
      metadata: {},
      outputs: [
        { name: "stdout", output_type: "stream", text: ["hi\n"] }
      ],
      source: ["print(1)\n", "print(2)"]
    }
  ],
  metadata: { language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: 4
})

const writeStored = (file: string): void => {
  fs.writeFileSync(file, `${JSON.stringify(storedNotebook(), null, 1)}\n`)
}

const TOP_LEVEL_ORDER = ["cells", "metadata", "nbformat", "nbformat_minor"]
const CODE_CELL_ORDER = [
  "cell_type",
  "execution_count",
  "id",
  "metadata",
  "outputs",
  "source"
]

const setup = (dir: string) => {
  const pathSvc = makePathService({
    directory: dir,
    worktree: dir,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const permSvc = makePermissionService(makeFakeContext(dir, dir))
  return {
    pathSvc,
    fileSvc,
    permSvc,
    edit: makeEditImpl(pathSvc, fileSvc, permSvc),
    output: makeOutputImpl(pathSvc, fileSvc, permSvc),
    clean: makeCleanImpl(pathSvc, fileSvc, permSvc)
  }
}

describe("NotebookFileService key order", () => {
  it("returns the raw parsed JSON instead of the zod-rebuilt object", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-read-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { fileSvc } = setup(dir)
      const snapshot = await runOrThrow(fileSvc.readWithText(file))
      expect(Object.keys(snapshot.notebook)).toEqual(TOP_LEVEL_ORDER)
      expect(Object.keys(snapshot.notebook.cells[1] as unknown as object)).toEqual(
        CODE_CELL_ORDER
      )
      expect(
        Object.keys((snapshot.notebook.cells[1] as CodeCellRaw).outputs[0] as object)
      ).toEqual(["name", "output_type", "text"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ipynb_edit byte stability", () => {
  it("preserves the notebook's existing indentation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-indent-"))
    const file = path.join(dir, "stored.ipynb")
    const twoSpace = `${JSON.stringify(storedNotebook(), null, 2)}\n`
    fs.writeFileSync(file, twoSpace)
    try {
      const { edit } = setup(dir)
      const expected = storedNotebook()
      ;(expected.cells as Array<{ source: string | string[] }>)[1]!.source = [
        "print(1)\n",
        "print(22)"
      ]
      await runOrThrow(
        edit.editCell(file, {
          cellIndex: 1,
          source: "print(1)\nprint(22)",
          clearOutputs: "never"
        })
      )
      expect(fs.readFileSync(file, "utf8")).toBe(
        `${JSON.stringify(expected, null, 2)}\n`
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves tab indentation and a missing trailing newline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-indent-"))
    const file = path.join(dir, "stored.ipynb")
    const tabbed = JSON.stringify(storedNotebook(), null, "\t")
    fs.writeFileSync(file, tabbed)
    try {
      const { edit } = setup(dir)
      const expected = storedNotebook()
      ;(expected.cells as Array<{ source: string | string[] }>)[0]!.source = [
        "# Edited"
      ]
      await runOrThrow(
        edit.editCell(file, {
          cellIndex: 0,
          source: "# Edited",
          clearOutputs: "never"
        })
      )
      expect(fs.readFileSync(file, "utf8")).toBe(
        JSON.stringify(expected, null, "\t")
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("only changes the edited cell's bytes and keeps nbformat key order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-edit-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { edit } = setup(dir)
      const before = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      const result = await runOrThrow(
        edit.editCell(file, {
          cellIndex: 1,
          source: "print(1)\nprint(22)",
          clearOutputs: "never"
        })
      )
      expect(result.changed).toBe(true)
      const expected = before
      expected.cells[1]!.source = ["print(1)\n", "print(22)"]
      expect(fs.readFileSync(file, "utf8")).toBe(
        `${JSON.stringify(expected, null, 1)}\n`
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps array source shape when the notebook stores line arrays", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-array-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { edit } = setup(dir)
      const result = await runOrThrow(
        edit.editCell(file, {
          cellIndex: 1,
          source: "print(1)\nprint(22)",
          clearOutputs: "never"
        })
      )
      const cell = result.notebook.cells[1] as CodeCellRaw
      expect(Array.isArray(cell.source)).toBe(true)
      expect(cell.source).toEqual(["print(1)\n", "print(22)"])
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      expect(onDisk.cells[1]?.source).toEqual(["print(1)\n", "print(22)"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps string source shape when the notebook stores a single string", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-string-"))
    const file = path.join(dir, "stored.ipynb")
    const stored = {
      cells: [
        { cell_type: "markdown", metadata: {}, source: "# A" },
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: "print(1)"
        }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    }
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 1)}\n`)
    try {
      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, {
          cellIndex: 0,
          source: "# B\n\nMore",
          clearOutputs: "never"
        })
      )
      const expected = {
        ...stored,
        cells: [
          { cell_type: "markdown", metadata: {}, source: "# B\n\nMore" },
          stored.cells[1]
        ]
      }
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      expect(typeof onDisk.cells[0]?.source).toBe("string")
      expect(onDisk.cells[0]?.source).toBe("# B\n\nMore")
      expect(fs.readFileSync(file, "utf8")).toBe(
        `${JSON.stringify(expected, null, 1)}\n`
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps key order when auto-clearing outputs and execution_count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-clear-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { edit } = setup(dir)
      const result = await runOrThrow(
        edit.editCell(file, { cellIndex: 1, source: "print(3)" })
      )
      expect(result.clearedOutputs).toBe(true)
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ execution_count: unknown; outputs: unknown[]; source: unknown }>
      }
      expect(after.cells[1]?.execution_count).toBeNull()
      expect(after.cells[1]?.outputs).toEqual([])
      expect(after.cells[1]?.source).toEqual(["print(3)"])
      expect(Object.keys(after)).toEqual(TOP_LEVEL_ORDER)
      expect(Object.keys(after.cells[1] as unknown as object)).toEqual(
        CODE_CELL_ORDER
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("other notebook writers keep key order", () => {
  it("ipynb_cell_insert keeps top-level order and untouched cell order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-insert-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { edit } = setup(dir)
      await runOrThrow(edit.insertCell(file, "markdown", "# Inserted", 1))
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: unknown[]
      }
      expect(after.cells.length).toBe(3)
      expect(Object.keys(after)).toEqual(TOP_LEVEL_ORDER)
      expect(Object.keys(after.cells[0] as object)).toEqual([
        "cell_type",
        "id",
        "metadata",
        "source"
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a newly inserted code cell uses the nbformat key order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-insert-code-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { edit } = setup(dir)
      await runOrThrow(edit.insertCell(file, "code", "print(9)", 0))
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: unknown[]
      }
      expect(Object.keys(after.cells[0] as object)).toEqual([
        "cell_type",
        "execution_count",
        "metadata",
        "outputs",
        "source"
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("newly inserted markdown and raw cells use the nbformat key order", async () => {
    for (const [cellType, prefix] of [
      ["markdown", "md"],
      ["raw", "raw"]
    ] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ipynb-order-insert-${prefix}-`))
      const file = path.join(dir, "stored.ipynb")
      writeStored(file)
      try {
        const { edit } = setup(dir)
        await runOrThrow(edit.insertCell(file, cellType, "body", 0))
        const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
          cells: unknown[]
        }
        const keys = Object.keys(after.cells[0] as object)
        expect(keys.indexOf("cell_type")).toBe(0)
        expect(keys.indexOf("metadata")).toBeLessThan(keys.indexOf("source"))
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it("ipynb_outputs clear_cell clears the cell and keeps order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-outputs-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { output } = setup(dir)
      await runOrThrow(output.clearCellOutputs(file, 1))
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ outputs: unknown[]; execution_count: unknown }>
      }
      expect(after.cells[1]?.outputs).toEqual([])
      expect(after.cells[1]?.execution_count).toBeNull()
      expect(Object.keys(after)).toEqual(TOP_LEVEL_ORDER)
      expect(Object.keys(after.cells[1] as unknown as object)).toEqual(
        CODE_CELL_ORDER
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_outputs clear_all keeps untouched bytes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-clearall-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { output } = setup(dir)
      await runOrThrow(output.clearAllOutputs(file))
      const raw = fs.readFileSync(file, "utf8")
      expect(Object.keys(JSON.parse(raw))).toEqual(TOP_LEVEL_ORDER)
      expect(raw).toContain('"id": "intro"')
      expect(raw).toContain('"application/vnd.databricks.v1+cell": {')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_clean normalizeSource=false keeps source arrays and order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-clean-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { clean } = setup(dir)
      const result = await runOrThrow(
        clean.clean(file, {
          clearOutputs: false,
          clearExecutionCount: false,
          stripWidgetState: false,
          stripLargeImages: false,
          normalizeSource: false
        })
      )
      expect(result.affectedCells).toBe(0)
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      expect(Array.isArray(after.cells[1]?.source)).toBe(true)
      expect(Object.keys(after)).toEqual(TOP_LEVEL_ORDER)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_clean's default normalizeSource rewrites arrays to strings", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-clean2-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { clean } = setup(dir)
      await runOrThrow(clean.clean(file))
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      expect(typeof after.cells[0]?.source).toBe("string")
      expect(Object.keys(after)).toEqual(TOP_LEVEL_ORDER)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_run save=true keeps top-level order and untouched cells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-run-"))
    const file = path.join(dir, "stored.ipynb")
    writeStored(file)
    try {
      const { pathSvc, fileSvc, permSvc } = setup(dir)
      const pythonSvc = {
        probe: () =>
          Effect.succeed({
            pythonPath: "/usr/bin/python3",
            version: "3",
            executable: "python3",
            from: "options" as const
          }),
        findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
        checkDependencies: () => Effect.succeed([]),
        candidates: () => Effect.succeed([]),
        checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
        doctor: () => Effect.succeed({} as never)
      } as unknown as PythonServiceShape
      const kernel = {
        execute: () =>
          Effect.succeed({
            success: true,
            executedCells: [1],
            durationMs: 1,
            outputs: [
              {
                cellIndex: 1,
                status: "ok" as const,
                stdout: "hello\n",
                executionCount: 3
              }
            ]
          })
      } as unknown as KernelManagerShape
      const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
        kernelManager: kernel,
        warmKernel: true,
        defaultTimeoutMs: 30_000
      })
      const result = await runOrThrow(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 1,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(result.saved).toBe(true)
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ execution_count: unknown; outputs: unknown[] }>
      }
      expect(Object.keys(after)).toEqual(TOP_LEVEL_ORDER)
      expect(Object.keys(after.cells[0] as unknown as object)).toEqual([
        "cell_type",
        "id",
        "metadata",
        "source"
      ])
      expect(Object.keys(after.cells[1] as unknown as object)).toEqual(
        CODE_CELL_ORDER
      )
      expect(after.cells[1]?.execution_count).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("line endings", () => {
  it("preserves CRLF notebooks instead of rewriting every line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-crlf-"))
    const file = path.join(dir, "stored.ipynb")
    const crlf = `${JSON.stringify(storedNotebook(), null, 1)}\n`.replace(
      /\n/g,
      "\r\n"
    )
    fs.writeFileSync(file, crlf)
    try {
      const { edit } = setup(dir)
      const expected = storedNotebook()
      ;(expected.cells as Array<{ source: string | string[] }>)[1]!.source = [
        "print(1)\n",
        "print(22)"
      ]
      await runOrThrow(
        edit.editCell(file, {
          cellIndex: 1,
          source: "print(1)\nprint(22)",
          clearOutputs: "never"
        })
      )
      const after = fs.readFileSync(file, "utf8")
      expect(after.includes("\r\n")).toBe(true)
      expect(after).not.toContain("\r\r\n")
      expect((after.match(/\r\n/g) ?? []).length).toBe(
        (after.match(/\n/g) ?? []).length
      )
      expect(after.replace(/\r\n/g, "\n")).toBe(
        `${JSON.stringify(expected, null, 1)}\n`
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("re-serializes a CRLF notebook without doubling carriage returns", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-order-crlf2-"))
    const file = path.join(dir, "stored.ipynb")
    const crlf = `${JSON.stringify(storedNotebook(), null, 1)}\n`.replace(
      /\n/g,
      "\r\n"
    )
    fs.writeFileSync(file, crlf)
    try {
      const { edit } = setup(dir)
      // Deleting the first cell takes the re-serialization path.
      await runOrThrow(edit.deleteCell(file, 0))
      const after = fs.readFileSync(file, "utf8")
      expect(after).not.toContain("\r\r\n")
      expect((after.match(/\r\n/g) ?? []).length).toBe(
        (after.match(/\n/g) ?? []).length
      )
      expect(JSON.parse(after).cells.length).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
