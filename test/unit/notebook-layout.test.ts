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
import { splitSourceLines } from "../../src/domain/notebook.js"
import { detectNotebookFormat, stringifyNotebook } from "../../src/utils/json.js"
import type { KernelManagerShape } from "../../src/services/KernelManager.js"
import type { PythonServiceShape } from "../../src/services/PythonService.js"
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
    edit: makeEditImpl(pathSvc, fileSvc, permSvc)
  }
}

const withTempRepo = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-layout-"))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}


describe("layout-preserving writes", () => {
  it("collapses an emptied array to [] without stray whitespace", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "clear.ipynb")
      const text = `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": 1,
   "metadata": {},
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "hi"
     ]
    }
   ],
   "source": [
    "print(1)"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 4
}
`
      fs.writeFileSync(file, text)
      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "print(2)", clearOutputs: "always" })
      )
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain('"outputs": [],')
      expect(after).not.toContain('"outputs": [\n')
    })
  })

  it("does not reflow an untouched inline source array (repo fixture)", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "simple.ipynb")
      fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
      const before = fs.readFileSync(file, "utf8")
      expect(before).toContain('"source": ["## Section\\n", "\\n", "Some notes."]')

      const { edit } = setup(dir)
      // Cell 1 is the code cell; cell 2 is the untouched inline-array markdown.
      await runOrThrow(
        edit.editCell(file, { cellIndex: 1, source: "x = 1", clearOutputs: "never" })
      )

      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain('"source": ["## Section\\n", "\\n", "Some notes."]')
    })
  })

  it("does not reflow if the edited value already matches", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "simple.ipynb")
      fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
      const before = fs.readFileSync(file, "utf8")
      const source = (JSON.parse(before) as { cells: Array<{ source: string | string[] }> })
        .cells[1]!.source
      const { edit } = setup(dir)
      const result = await runOrThrow(
        edit.editCell(file, {
          cellIndex: 1,
          source: Array.isArray(source) ? source.join("") : source,
          clearOutputs: "never"
        })
      )
      expect(result.changed).toBe(false)
      expect(fs.readFileSync(file, "utf8")).toBe(before)
    })
  })

  it("preserves indentation wider than JSON.stringify's 10-space clamp", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "twelve.ipynb")
      const pad = (depth: number) => " ".repeat(depth * 12)
      const emit = (value: unknown, depth = 0): string => {
        if (value === null) return "null"
        if (typeof value === "string") return JSON.stringify(value)
        if (typeof value !== "object") return String(value)
        if (Array.isArray(value)) {
          if (value.length === 0) return "[]"
          return `[\n${value
            .map((item) => pad(depth + 1) + emit(item, depth + 1))
            .join(",\n")}\n${pad(depth)}]`
        }
        const record = value as Record<string, unknown>
        const keys = Object.keys(record)
        if (keys.length === 0) return "{}"
        return `{\n${keys
          .map(
            (key) =>
              `${pad(depth + 1)}${JSON.stringify(key)}: ${emit(record[key], depth + 1)}`
          )
          .join(",\n")}\n${pad(depth)}}`
      }
      const notebook = {
        cells: [
          { cell_type: "markdown", metadata: {}, source: ["# A"] },
          { cell_type: "markdown", metadata: {}, source: ["# B"] }
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
      }
      const twelve = `${emit(notebook)}\n`
      fs.writeFileSync(file, twelve)
      expect(twelve.split("\n")[1]).toBe(`${" ".repeat(12)}"cells": [`)

      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "# Edited", clearOutputs: "never" })
      )
      const after = fs.readFileSync(file, "utf8")
      expect(after.split("\n")[1]).toBe(`${" ".repeat(12)}"cells": [`)
      expect(after).toContain(`${" ".repeat(12 * 3)}"# B"`)
    })
  })

  it("keeps \\uXXXX escapes in untouched cells", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "escaped.ipynb")
      const text = `{
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "# A"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "print('hello \\u2014 dash')"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 4
}
`
      fs.writeFileSync(file, text)
      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "# Edited", clearOutputs: "never" })
      )
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain("\\u2014")
      expect(after).not.toContain("\u2014")
    })
  })

  it("keeps number literals in untouched metadata", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "numbers.ipynb")
      const text = `{
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "# A"
   ]
  }
 ],
 "metadata": {
  "big": 12345678901234567890,
  "float": 1.0,
  "exp": 1e20
 },
 "nbformat": 4,
 "nbformat_minor": 4
}
`
      fs.writeFileSync(file, text)
      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "# Edited", clearOutputs: "never" })
      )
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain("12345678901234567890")
      expect(after).toContain("1.0")
      expect(after).toContain("1e20")
    })
  })

  it("keeps single-line separators in untouched parts", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "oneline.ipynb")
      const text =
        '{"cells": [{"cell_type": "markdown", "metadata": {}, "source": "# A"}], "metadata": {}, "nbformat": 4, "nbformat_minor": 4}\n'
      fs.writeFileSync(file, text)
      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "# Edited", clearOutputs: "never" })
      )
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain('"cell_type": "markdown", "metadata": {}, "source": "# Edited"')
      expect(Object.keys(JSON.parse(after))).toEqual([
        "cells",
        "metadata",
        "nbformat",
        "nbformat_minor"
      ])
    })
  })

  it("only changes the edited cell's bytes in a 13-cell notebook", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "many.ipynb")
      const cells = Array.from({ length: 13 }, (_, i) => ({
        cell_type: i % 2 === 0 ? "markdown" : "code",
        ...(i % 2 === 0
          ? {}
          : { execution_count: null, outputs: [] }),
        metadata: { tag: `cell-${i}` },
        source: [`line ${i}\n`, `more ${i}`]
      }))
      const text = `${JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`
      fs.writeFileSync(file, text)
      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, { cellIndex: 3, source: "changed", clearOutputs: "never" })
      )
      const after = fs.readFileSync(file, "utf8")
      const oldBlock = [
        '   "source": [',
        '    "line 3\\n",',
        '    "more 3"',
        '   ]'
      ].join("\n")
      expect(text).toContain(oldBlock)
      // A line-array notebook keeps the array shape on the edited cell.
      const expected = text.replace(
        oldBlock,
        ['   "source": [', '    "changed"', "   ]"].join("\n")
      )
      expect(after).toBe(expected)
      expect(after).toContain('"line 12\\n"')
      expect(after).toContain('"source": [')
    })
  })
})

describe("nbformat output shape on ipynb_run save", () => {
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

  it("persists nbformat's line arrays for stream text and text/* data", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "outputs.ipynb")
      const text = `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "print(1)"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "print(2)"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 4
}
`
      fs.writeFileSync(file, text)
      const { pathSvc, fileSvc, permSvc } = setup(dir)
      // What nbformat.read() hands back: rejoin_lines turned arrays into strings.
      const rawOutputs = [
        { name: "stdout", output_type: "stream", text: "line1\nline2\n" },
        {
          data: { "text/html": "<b>1</b>", "text/plain": "a\nb" },
          execution_count: 1,
          metadata: {},
          output_type: "execute_result"
        }
      ]
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
                stdout: "line1\nline2\n",
                executionCount: 1,
                rawOutputs
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

      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ outputs: Array<Record<string, unknown>> }>
      }
      const outputs = stored.cells[1]!.outputs
      expect(outputs[0]).toEqual({
        name: "stdout",
        output_type: "stream",
        text: ["line1\n", "line2\n"]
      })
      expect((outputs[1]!.data as Record<string, unknown>)["text/html"]).toEqual([
        "<b>1</b>"
      ])
      expect((outputs[1]!.data as Record<string, unknown>)["text/plain"]).toEqual([
        "a\n",
        "b"
      ])
      // The unexecuted cell must stay byte-identical.
      expect(fs.readFileSync(file, "utf8")).toContain(`"source": [
    "print(1)"
   ]`)
    })
  })

  it("keeps stored text arrays in a hybrid notebook with string sources", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "hybrid.ipynb")
      // String `source`, but the outputs were stored as line arrays.
      const text = `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "old\\n"
     ]
    }
   ],
   "source": "print(1)"
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 4
}
`
      fs.writeFileSync(file, text)
      const { pathSvc, fileSvc, permSvc } = setup(dir)
      const kernel = {
        execute: () =>
          Effect.succeed({
            success: true,
            executedCells: [0],
            durationMs: 1,
            outputs: [
              {
                cellIndex: 0,
                status: "ok" as const,
                stdout: "new\nline\n",
                executionCount: 1,
                rawOutputs: [
                  { name: "stdout", output_type: "stream", text: "new\nline\n" }
                ]
              }
            ]
          })
      } as unknown as KernelManagerShape
      const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
        kernelManager: kernel,
        warmKernel: true,
        defaultTimeoutMs: 30_000
      })
      await runOrThrow(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[]; outputs: Array<Record<string, unknown>> }>
      }
      expect(stored.cells[0]?.outputs[0]?.text).toEqual(["new\n", "line\n"])
      expect(typeof stored.cells[0]?.source).toBe("string")
    })
  })
})

describe("defaults keep nbformat key order", () => {
  it("inserts a defaulted outputs key in sorted position", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "missing.ipynb")
      const text = `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "source": [
    "x = 1"
   ]
  }
 ],
 "nbformat": 4,
 "nbformat_minor": 5
}
`
      fs.writeFileSync(file, text)
      const { edit } = setup(dir)
      await runOrThrow(
        edit.editCell(file, { cellIndex: 0, source: "x = 2", clearOutputs: "never" })
      )
      const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      expect(Object.keys(after)).toEqual([
        "cells",
        "metadata",
        "nbformat",
        "nbformat_minor"
      ])
      expect(Object.keys(after.cells[0]!)).toEqual([
        "cell_type",
        "execution_count",
        "metadata",
        "outputs",
        "source"
      ])
    })
  })
})

describe("splitSourceLines matches Python splitlines(keepends=True)", () => {
  it("splits on every boundary Python honors", () => {
    expect(splitSourceLines("a\nb")).toEqual(["a\n", "b"])
    expect(splitSourceLines("a\rb")).toEqual(["a\r", "b"])
    expect(splitSourceLines("a\r\nb")).toEqual(["a\r\n", "b"])
    expect(splitSourceLines("a\vb")).toEqual(["a\v", "b"])
    expect(splitSourceLines("a\fb")).toEqual(["a\f", "b"])
    expect(splitSourceLines("a\x1cb")).toEqual(["a\x1c", "b"])
    expect(splitSourceLines("a\x1db")).toEqual(["a\x1d", "b"])
    expect(splitSourceLines("a\x1eb")).toEqual(["a\x1e", "b"])
    expect(splitSourceLines("a\x85b")).toEqual(["a\x85", "b"])
    expect(splitSourceLines("a\u2028b")).toEqual(["a\u2028", "b"])
    expect(splitSourceLines("a\u2029b")).toEqual(["a\u2029", "b"])
    expect(splitSourceLines("")).toEqual([])
    expect(splitSourceLines("\n\n")).toEqual(["\n", "\n"])
    expect(splitSourceLines("a\r\nb\r\n")).toEqual(["a\r\n", "b\r\n"])
    expect(splitSourceLines("abc")).toEqual(["abc"])
    expect(splitSourceLines("a\nb\r\nc\rd")).toEqual(["a\n", "b\r\n", "c\r", "d"])
  })
})

describe("untouched bytes across every writer", () => {
  const literalNotebook = `{
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": ["# A", "# B"]
  },
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "# C"
   ]
  }
 ],
 "metadata": {
  "big": 12345678901234567890,
  "float": 1.0,
  "inline": ["x"]
 },
 "nbformat": 4,
 "nbformat_minor": 4
}
`

  const withFile = async (
    text: string,
    action: (dir: string, file: string) => Promise<void>
  ): Promise<{ before: string; after: string }> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-writer-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, text)
    try {
      await action(dir, file)
      return { before: text, after: fs.readFileSync(file, "utf8") }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it("ipynb_cell_delete(0) keeps literals, inline arrays and untouched cells", async () => {
    const { before, after } = await withFile(literalNotebook, async (dir, file) => {
      await runOrThrow(setup(dir).edit.deleteCell(file, 0))
    })
    expect(after).toContain("12345678901234567890")
    expect(after).toContain("1.0")
    expect(after).toContain('"inline": ["x"]')
    expect(JSON.parse(after).cells.length).toBe(1)
    expect(JSON.parse(after).cells[0].source).toEqual(["# C"])
    expect(before.length - after.length).toBeLessThan(120)
  })

  it("ipynb_cell_move keeps literals and inline arrays", async () => {
    const { after } = await withFile(literalNotebook, async (dir, file) => {
      await runOrThrow(setup(dir).edit.moveCell(file, 0, 1))
    })
    expect(after).toContain("12345678901234567890")
    expect(after).toContain("1.0")
    expect(after).toContain('"inline": ["x"]')
    expect(Object.keys(JSON.parse(after))).toEqual([
      "cells",
      "metadata",
      "nbformat",
      "nbformat_minor"
    ])
  })

  it("ipynb_outputs clear_all keeps literals and inline arrays", async () => {
    const { after } = await withFile(literalNotebook, async (dir, file) => {
      await runOrThrow(
        makeOutputImpl(
          makePathService({ directory: dir, worktree: dir, platform: process.platform }),
          makeNotebookFileService(),
          makePermissionService(makeFakeContext(dir, dir))
        ).clearAllOutputs(file)
      )
    })
    expect(after).toContain("12345678901234567890")
    expect(after).toContain("1.0")
    expect(after).toContain('"inline": ["x"]')
  })

  it("clearOutputs: never preserves a committed execution_count", async () => {
    const { after } = await withFile(literalNotebook, async (dir, file) => {
      const stored = JSON.parse(literalNotebook) as {
        cells: Array<Record<string, unknown>>
      }
      stored.cells[0] = {
        cell_type: "code",
        execution_count: 7,
        metadata: {},
        outputs: [{ name: "stdout", output_type: "stream", text: ["hi\n"] }],
        source: ["print(1)"]
      }
      fs.writeFileSync(file, `${JSON.stringify(stored, null, 1)}\n`)
      await runOrThrow(
        setup(dir).edit.editCell(file, {
          cellIndex: 0,
          source: "print(2)",
          clearOutputs: "never"
        })
      )
    })
    const cell = (JSON.parse(after) as { cells: Array<Record<string, unknown>> }).cells[0]!
    expect(cell.execution_count).toBe(7)
    expect((cell.outputs as unknown[]).length).toBe(1)
    expect(cell.source).toEqual(["print(2)"])
  })
})

describe("inserted cells mirror the notebook's source shape", () => {
  it("inserts array source into a line-array notebook", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "arrays.ipynb")
      fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
      const { edit } = setup(dir)
      await runOrThrow(edit.insertCell(file, "code", "a = 1\nb = 2", 1))
      const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      expect(stored.cells[1]?.source).toEqual(["a = 1\n", "b = 2"])
    })
  })
})

describe("format detection and serialization round-trip", () => {
  const notebook = {
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# A"] },
      { cell_type: "code", execution_count: 1, metadata: {}, outputs: [], source: ["x"] }
    ],
    metadata: { big: "12345678901234567890" },
    nbformat: 4,
    nbformat_minor: 4
  }

  const emit = (indent: string): string => {
    const pad = (depth: number) => indent.repeat(depth)
    const walk = (value: unknown, depth: number): string => {
      if (value === null) return "null"
      if (typeof value === "string") return JSON.stringify(value)
      if (typeof value !== "object") return String(value)
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]"
        return `[\n${value
          .map((item) => pad(depth + 1) + walk(item, depth + 1))
          .join(",\n")}\n${pad(depth)}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
      if (keys.length === 0) return "{}"
      return `{\n${keys
        .map((key) => `${pad(depth + 1)}${JSON.stringify(key)}: ${walk(record[key], depth + 1)}`)
        .join(",\n")}\n${pad(depth)}}`
    }
    return walk(notebook, 0)
  }

  for (const indent of [" ", "  ", "    ", "\t", " ".repeat(12)]) {
    for (const newline of ["\n", "\r\n"] as const) {
      for (const trailingNewline of [true, false]) {
        const label = `indent=${JSON.stringify(indent)} newline=${JSON.stringify(newline)} trailing=${trailingNewline}`
        it(`round-trips ${label}`, () => {
          const text = `${emit(indent).replace(/\n/g, newline)}${
            trailingNewline ? newline : ""
          }`
          const format = detectNotebookFormat(text)
          expect(format.newline).toBe(newline)
          expect(format.trailingNewline).toBe(trailingNewline)
          expect(format.unit).toBe(indent)
          const out = stringifyNotebook(notebook, format)
          expect(out).toBe(text)
          expect(out).not.toContain("\r\r\n")
        })
      }
    }
  }

  it("emits LF for an LF format and CRLF for a CRLF format", () => {
    const lf = stringifyNotebook(notebook, { ...detectNotebookFormat("{}\n"), newline: "\n" })
    expect(lf).not.toContain("\r")
    const crlf = stringifyNotebook(notebook, { ...detectNotebookFormat("{}\n"), newline: "\r\n" })
    expect((crlf.match(/\r\n/g) ?? []).length).toBe((crlf.match(/\n/g) ?? []).length)
  })

  it("detects ASCII escapes", () => {
    const escaped = `{\n "cells": [],\n "metadata": {},\n "nbformat": 4,\n "note": "caf\\u00e9"\n}\n`
    expect(detectNotebookFormat(escaped).ensureAscii).toBe(true)
    expect(detectNotebookFormat(`${escaped}`.replace("caf\\u00e9", "café")).ensureAscii).toBe(false)
  })

})

describe("large notebooks stay linear", () => {
  const build = (cells: number): string => {
    const list = Array.from({ length: cells }, (_, i) => ({
      cell_type: "code",
      execution_count: i,
      metadata: {},
      outputs: [{ name: "stdout", output_type: "stream", text: [`line ${i}\n`] }],
      source: [`print(${i})`]
    }))
    return `${JSON.stringify({ cells: list, metadata: {}, nbformat: 4, nbformat_minor: 4 }, null, 1)}\n`
  }

  it("clears every output in 4000 cells without quadratic blowup", async () => {
    const measure = async (cells: number): Promise<number> => {
      const text = build(cells)
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ipynb-linear-${cells}-`))
      const file = path.join(dir, "many.ipynb")
      fs.writeFileSync(file, text)
      try {
        const { pathSvc, fileSvc, permSvc } = setup(dir)
        const output = makeOutputImpl(pathSvc, fileSvc, permSvc)
        const started = Date.now()
        const result = await runOrThrow(output.clearAllOutputs(file))
        expect(result.clearedCells).toBe(cells)
        const after = JSON.parse(fs.readFileSync(file, "utf8")) as {
          cells: Array<{ outputs: unknown[]; execution_count: unknown }>
        }
        expect(after.cells.every((cell) => cell.outputs.length === 0)).toBe(true)
        expect(after.cells.every((cell) => cell.execution_count === null)).toBe(true)
        return Date.now() - started
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    // A 4x larger notebook must not cost 4x more per cell (quadratic is ~8-11x).
    await measure(500)
    await measure(1000)
    const small = await measure(1000)
    const large = await measure(4000)
    expect(large).toBeLessThan(Math.max(150, small * 5))
  })
})

describe("external writers are never silently overwritten", () => {
  it("rejects a write when the file changed during serialization", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "race.ipynb")
      const cells = Array.from({ length: 4000 }, (_, i) => ({
        cell_type: "code",
        execution_count: i,
        metadata: {},
        outputs: [{ name: "stdout", output_type: "stream", text: [`l${i}\n`] }],
        source: [`print(${i})`]
      }))
      const base = `${JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 4 }, null, 1)}\n`
      fs.writeFileSync(file, base)
      const sentinel = base.replace('"print(0)"', '"EXTERNAL"')
      const { edit } = setup(dir)
      const timer = setTimeout(() => fs.writeFileSync(file, sentinel), 30)
      try {
        const exit = await Effect.runPromiseExit(
          edit.editCell(file, { cellIndex: 5, source: "print('X')", clearOutputs: "never" })
        )
        const after = fs.readFileSync(file, "utf8")
        if (exit._tag === "Failure") {
          // Detected the external edit: its content is intact and ours is absent.
          expect(after).toContain("EXTERNAL")
          expect(after).not.toContain("print('X')")
        } else {
          // The external write landed after ours completed.
          expect(after).not.toContain("EXTERNAL")
        }
      } finally {
        clearTimeout(timer)
      }
    })
  })
})

describe("key insertions and empty arrays stay spliceable", () => {
  const style = {
    unit: " ",
    newline: "\n" as const,
    itemSeparator: ", ",
    keySeparator: ": ",
    ensureAscii: false
  }

  it("inserts several new keys into an empty object", async () => {
    const { patchJsonText } = await import("../../src/utils/json-patch.js")
    for (const next of [{ a: 1 }, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }]) {
      const text = `{\n "m": {}\n}\n`
      const out = patchJsonText(text, { m: next }, { style })
      expect(out).toBeDefined()
      expect(JSON.parse(out!)).toEqual({ m: next })
      expect(out).not.toContain('"a":1')
    }
  })

  it("inserts a new key before and after existing keys", async () => {
    const { patchJsonText } = await import("../../src/utils/json-patch.js")
    const text = `{\n "m": {\n  "x": 0\n }\n}\n`
    const out = patchJsonText(text, { m: { a: 1, x: 0, z: 2 } }, { style })
    expect(out).toBeDefined()
    expect(JSON.parse(out!)).toEqual({ m: { a: 1, x: 0, z: 2 } })
    expect(out).toContain('"a": 1')
    expect(out).toContain('"z": 2')
  })

  it("expands a previously empty array into nbformat layout", async () => {
    const { patchJsonText } = await import("../../src/utils/json-patch.js")
    const text = `{\n "cells": [\n  {\n   "cell_type": "code",\n   "outputs": [],\n   "source": [\n    "print(1)"\n   ]\n  }\n ],\n "nbformat": 4\n}\n`
    const next = JSON.parse(text) as {
      cells: Array<{ outputs: unknown[] }>
    }
    next.cells[0]!.outputs = [
      { name: "stdout", output_type: "stream", text: ["a\n"] }
    ]
    const out = patchJsonText(text, next, { style })
    expect(out).toBeDefined()
    expect(JSON.parse(out!).cells[0].outputs).toEqual(next.cells[0]!.outputs)
    expect(out).toContain('"outputs": [\n')
    expect(out).not.toContain('"outputs": [{')
  })

  it("keeps an in-place metadata strip spliceable through ipynb_clean", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "widgets.ipynb")
      const text = `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {
    "jupyter": {
     "outputs": {},
     "widgets": {}
    },
    "tags": [
     "keep"
    ]
   },
   "outputs": [],
   "source": [
    "x = 1"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`
      fs.writeFileSync(file, text)
      const inline = `"source": ["x = 1"]`
      const md = text.replace(`"source": [\n    "x = 1"\n   ]`, inline)
      fs.writeFileSync(file, md)
      const { pathSvc, fileSvc, permSvc } = setup(dir)
      const clean = makeCleanImpl(pathSvc, fileSvc, permSvc)
      await runOrThrow(
        clean.clean(file, {
          clearOutputs: false,
          clearExecutionCount: false,
          stripWidgetState: true,
          stripLargeImages: false,
          normalizeSource: false
        })
      )
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain(inline)
      const metadata = (JSON.parse(after) as { cells: Array<{ metadata: unknown }> })
        .cells[0]!.metadata as Record<string, unknown>
      expect(metadata["jupyter"]).toEqual({})
      expect(metadata["tags"]).toEqual(["keep"])
    })
  })
})

describe("numeric literals survive reordering", () => {
  const literal = `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {
    "cellId": 12345678901234567890,
    "version": 1.0
   },
   "outputs": [],
   "source": [
    "a"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "b"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 4
}
`

  it("ipynb_cell_move keeps 20-digit ids and 1.0 in the moved cell", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, literal)
      const { edit } = setup(dir)
      await runOrThrow(edit.moveCell(file, 0, 1))
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain("12345678901234567890")
      expect(after).toContain('"version": 1.0')
      expect(after).not.toContain("12345678901234567000")
    })
  })

  it("ipynb_cell_delete keeps literals in the surviving cell", async () => {
    await withTempRepo(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, literal)
      const { edit } = setup(dir)
      await runOrThrow(edit.deleteCell(file, 1))
      const after = fs.readFileSync(file, "utf8")
      expect(after).toContain("12345678901234567890")
      expect(after).toContain('"version": 1.0')
    })
  })

  it("applyNotebookDefaults never turns __proto__ into a prototype write", async () => {
    const { applyNotebookDefaults } = await import("../../src/domain/notebook.js")
    const raw = JSON.parse(
      `{"cells":[{"__proto__":{"polluted":"yes"},"cell_type":"code","execution_count":null,"metadata":{}}],"nbformat":4,"nbformat_minor":5}`
    )
    const out = applyNotebookDefaults(raw)
    const cell = out.cells[0] as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(cell, "__proto__")).toBe(true)
    expect((cell as { polluted?: unknown }).polluted).toBeUndefined()
    expect(Object.keys(cell)).toEqual([
      "__proto__",
      "cell_type",
      "execution_count",
      "metadata",
      "outputs"
    ])
  })
})

describe("format detection edge cases", () => {
  it("does not conflate an empty object with an empty array", async () => {
    const { jsonEqual } = await import("../../src/utils/json-patch.js")
    expect(jsonEqual({}, [])).toBe(false)
    expect(jsonEqual([], {})).toBe(false)
    expect(jsonEqual([], [])).toBe(true)
    expect(jsonEqual({}, {})).toBe(true)
    expect(jsonEqual({ a: [] }, { a: {} })).toBe(false)
  })

  it("patches an empty array into an empty object", async () => {
    const { patchJsonText } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ",",
      keySeparator: ": ",
      ensureAscii: false
    }
    const text = `{\n "cells": [\n  {\n   "metadata": [],\n   "source": ["# a"]\n  }\n ]\n}\n`
    const next = JSON.parse(text) as { cells: Array<{ metadata: unknown }> }
    next.cells[0]!.metadata = {}
    const out = patchJsonText(text, next, { style })
    expect(out).toBeDefined()
    expect((JSON.parse(out!) as { cells: Array<{ metadata: unknown }> }).cells[0]!.metadata).toEqual({})
  })

  it("detects compact separators instead of injecting spaces", async () => {
    const tight = `{"cells":[{"cell_type":"markdown","metadata":{},"source":["# a"]}],"metadata":{},"nbformat":4}\n`
    const format = detectNotebookFormat(tight)
    expect(format.itemSeparator).toBe(",")
    expect(format.keySeparator).toBe(":")
    const spaced = `{\n "cells": [\n  {\n   "cell_type": "markdown"\n  }\n ]\n}\n`
    expect(detectNotebookFormat(spaced).itemSeparator).toBe(",")
    expect(detectNotebookFormat(spaced).keySeparator).toBe(": ")
  })

  it("sees non-ASCII escapes after ASCII control escapes", () => {
    const ansi = `{\n "outputs": [\n  {\n   "text": "\\u001b[0;31mred\\u001b[0m caf\\u00e9"\n  }\n ]\n}\n`
    expect(detectNotebookFormat(ansi).ensureAscii).toBe(true)
  })
})

describe("ASCII escape detection", () => {
  const detect = (text: string) => detectNotebookFormat(text).ensureAscii

  it("detects a real non-ASCII escape", () => {
    expect(detect(`{\n "n": "caf\\u00e9"\n}\n`)).toBe(true)
    expect(detect(`{\n "n": "\\u2014"\n}\n`)).toBe(true)
    expect(detect(`{\n "n": "\\u4e2d"\n}\n`)).toBe(true)
    expect(detect(`{\n "n": "\\ud83d"\n}\n`)).toBe(true)
  })

  it("ignores ASCII-only escapes", () => {
    expect(detect(`{\n "n": "a\\u0000b"\n}\n`)).toBe(false)
    expect(detect(`{\n "n": "a\\u001bb"\n}\n`)).toBe(false)
    expect(detect(`{\n "n": "a\\u007fb"\n}\n`)).toBe(false)
  })

  it("ignores an escaped backslash before a u sequence", () => {
    expect(detect(`{\n "n": "s = \\"\\\\u00e9\\""\n}\n`)).toBe(false)
  })

  it("finds a non-ASCII escape that follows an ASCII one", () => {
    expect(detect(`{\n "n": "\\u001b[31m caf\\u00e9"\n}\n`)).toBe(true)
  })

  it("ignores plain unicode", () => {
    expect(detect(`{\n "n": "café — 中文"\n}\n`)).toBe(false)
  })
})
