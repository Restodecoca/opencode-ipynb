import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  makePathService,
  makePermissionService,
  makeNotebookFileService,
  makeOutputImpl
} from "../../src/services/index.js"

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

const buildOutput = (directory: string, worktree: string) => {
  const pathSvc = makePathService({
    directory,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const permSvc = makePermissionService(makeFakeContext(directory, worktree))
  return makeOutputImpl(pathSvc, fileSvc, permSvc)
}

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

const codeCell = (source: string, outputs: ReadonlyArray<unknown> = []) => ({
  cell_type: "code",
  execution_count: outputs.length > 0 ? 1 : null,
  metadata: {},
  outputs,
  source
})

const streamOutput = (text: string) => ({
  name: "stdout",
  output_type: "stream",
  text
})

const FOUR_CELL_NOTEBOOK = (): ReadonlyArray<unknown> => [
  codeCell("x = 1", [streamOutput("1\n")]),
  codeCell("y = 2", [streamOutput("2\n")]),
  codeCell("z = 3", [streamOutput("3\n")]),
  codeCell("w = 4", [streamOutput("4\n")])
]

describe("NotebookOutputService > listOutputs pagination", () => {
  it("defaults to offset=0 and limit=50 with total reported", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(output.listOutputs(file))

      expect(result.total).toBe(4)
      expect(result.entries.length).toBe(4)
      expect(result.offset).toBe(0)
      expect(result.limit).toBe(50)
      expect(result.entries.map((e) => e.cellIndex)).toEqual([0, 1, 2, 3])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("slices with offset=2, limit=2 and reports pagination metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(output.listOutputs(file, 2, 2))

      expect(result.total).toBe(4)
      expect(result.entries.length).toBe(2)
      expect(result.offset).toBe(2)
      expect(result.limit).toBe(2)
      expect(result.entries.map((e) => e.cellIndex)).toEqual([2, 3])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns an empty page when offset >= total (no error)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(output.listOutputs(file, 10, 5))

      expect(result.total).toBe(4)
      expect(result.entries.length).toBe(0)
      expect(result.offset).toBe(10)
      expect(result.limit).toBe(5)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("treats limit <= 0 as no limit and returns all entries from offset", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const output = buildOutput(dir, dir)

      const fromStart = await runOrThrow(output.listOutputs(file, 0, 0))
      expect(fromStart.total).toBe(4)
      expect(fromStart.entries.length).toBe(4)
      expect(fromStart.offset).toBe(0)
      expect(fromStart.limit).toBe(4)
      expect(fromStart.entries.map((e) => e.cellIndex)).toEqual([0, 1, 2, 3])

      const fromMiddle = await runOrThrow(output.listOutputs(file, 2, -1))
      expect(fromMiddle.total).toBe(4)
      expect(fromMiddle.entries.length).toBe(2)
      expect(fromMiddle.offset).toBe(2)
      expect(fromMiddle.limit).toBe(2)
      expect(fromMiddle.entries.map((e) => e.cellIndex)).toEqual([2, 3])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("caps limit at 500 to avoid OOM on huge notebooks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(output.listOutputs(file, 0, 1000))

      expect(result.total).toBe(4)
      expect(result.entries.length).toBe(4)
      expect(result.offset).toBe(0)
      expect(result.limit).toBe(500)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ignores non-code cells in the entry list (only counts code cells)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "mixed.ipynb", [
        { cell_type: "markdown", metadata: {}, source: ["# title\n"] },
        codeCell("a = 1", [streamOutput("1\n")]),
        { cell_type: "raw", metadata: {}, source: ["raw"] },
        codeCell("b = 2", [streamOutput("2\n")]),
        { cell_type: "markdown", metadata: {}, source: ["notes"] }
      ])
      const output = buildOutput(dir, dir)
      const result = await runOrThrow(output.listOutputs(file))

      expect(result.total).toBe(2)
      expect(result.entries.length).toBe(2)
      expect(result.entries.map((e) => e.cellIndex)).toEqual([1, 3])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ipynb_outputs tool > list operation formatting", () => {
  const importTool = async () => {
    const mod = await import("../../src/tools/outputs.js")
    return mod.ipynbOutputsTool
  }

  const asObject = (r: unknown): { title?: string; output: string; metadata?: Record<string, unknown> } => {
    if (typeof r !== "object" || r === null || !("output" in r)) {
      throw new Error(`expected object tool result, got: ${String(r)}`)
    }
    return r as { title?: string; output: string; metadata?: Record<string, unknown> }
  }

  it("renders the table without a footer when the result fits in one page", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const ipynbOutputsTool = await importTool()
      const result = asObject(
        await ipynbOutputsTool.execute(
          {
            filePath: file,
            operation: "list",
            cellIndex: undefined,
            offset: undefined,
            limit: undefined,
            includeImages: false,
            maxOutputChars: 6_000
          },
          makeFakeContext(dir, dir)
        )
      )

      const output = result.output
      expect(output).toContain("| cell | type | #outputs | hasError | hasImage | total bytes |")
      expect(output).toContain("| 0 | code | 1 | no | no | 2 |")
      expect(output).toContain("| 3 | code | 1 | no | no | 2 |")
      expect(output).not.toContain("(showing entries")
      expect(result.metadata).toEqual({
        filePath: expect.stringContaining("four.ipynb"),
        count: 4,
        offset: 0,
        limit: 50,
        total: 4
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("renders the table and a footer line when pagination is active", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const ipynbOutputsTool = await importTool()
      const result = asObject(
        await ipynbOutputsTool.execute(
          {
            filePath: file,
            operation: "list",
            cellIndex: undefined,
            offset: 2,
            limit: 2,
            includeImages: false,
            maxOutputChars: 6_000
          },
          makeFakeContext(dir, dir)
        )
      )

      const output = result.output
      expect(output).toContain("| cell | type | #outputs | hasError | hasImage | total bytes |")
      expect(output).toContain("| 2 | code | 1 | no | no | 2 |")
      expect(output).toContain("| 3 | code | 1 | no | no | 2 |")
      expect(output).not.toContain("| 0 | code |")
      expect(output).not.toContain("| 1 | code |")
      expect(output).toContain("\n(showing entries 3..4 of 4)")
      expect(result.metadata).toEqual({
        filePath: expect.stringContaining("four.ipynb"),
        count: 2,
        offset: 2,
        limit: 2,
        total: 4
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ignores offset/limit when operation is not 'list'", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-pag-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const ipynbOutputsTool = await importTool()
      const result = asObject(
        await ipynbOutputsTool.execute(
          {
            filePath: file,
            operation: "read",
            cellIndex: 0,
            offset: 99,
            limit: 99,
            includeImages: false,
            maxOutputChars: 6_000
          },
          makeFakeContext(dir, dir)
        )
      )

      expect(result.metadata).not.toHaveProperty("offset")
      expect(result.metadata).not.toHaveProperty("limit")
      expect(result.metadata).not.toHaveProperty("total")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ipynb_read tool > swapped-range validation", () => {
  const importTool = async () => {
    const mod = await import("../../src/tools/read.js")
    return mod.ipynbReadTool
  }

  const asObject = (r: unknown): { title?: string; output: string; metadata?: Record<string, unknown> } => {
    if (typeof r !== "object" || r === null || !("output" in r)) {
      throw new Error(`expected object tool result, got: ${String(r)}`)
    }
    return r as { title?: string; output: string; metadata?: Record<string, unknown> }
  }

  it("rejects a range where start > end with a clear validation message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-read-validate-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const ipynbReadTool = await importTool()
      const result = asObject(
        await ipynbReadTool.execute(
          {
            filePath: file,
            cellIndex: undefined,
            start: 5,
            end: 2,
            includeOutputs: false,
            includeErrors: true,
            includeMetadata: false,
            includeImages: false,
            maxSourceChars: 12_000,
            maxOutputChars: 6_000
          },
          makeFakeContext(dir, dir)
        )
      )
      expect(result.output).toContain("Error")
      expect(result.output).toMatch(/start.*<=.*end|must be <=/)
      expect(result.metadata).toEqual({ error: true, message: expect.any(String) })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a request that provides neither cellIndex nor start/end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-read-validate-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const ipynbReadTool = await importTool()
      const result = asObject(
        await ipynbReadTool.execute(
          {
            filePath: file,
            cellIndex: undefined,
            start: undefined,
            end: undefined,
            includeOutputs: false,
            includeErrors: true,
            includeMetadata: false,
            includeImages: false,
            maxSourceChars: 12_000,
            maxOutputChars: 6_000
          },
          makeFakeContext(dir, dir)
        )
      )
      expect(result.output).toContain("Error")
      expect(result.output).toMatch(/cellIndex.*start.*end|Provide either/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a request that combines cellIndex with start/end", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-read-validate-"))
    try {
      const file = writeNotebook(dir, "four.ipynb", FOUR_CELL_NOTEBOOK())
      const ipynbReadTool = await importTool()
      const result = asObject(
        await ipynbReadTool.execute(
          {
            filePath: file,
            cellIndex: 0,
            start: 1,
            end: 2,
            includeOutputs: false,
            includeErrors: true,
            includeMetadata: false,
            includeImages: false,
            maxSourceChars: 12_000,
            maxOutputChars: 6_000
          },
          makeFakeContext(dir, dir)
        )
      )
      expect(result.output).toContain("Error")
      expect(result.output).toMatch(/cellIndex.*start|cannot be combined/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
