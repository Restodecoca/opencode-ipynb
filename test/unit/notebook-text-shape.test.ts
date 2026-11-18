import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  makeExecutionImpl,
  makeNotebookFileService,
  makePathService,
  makePermissionService
} from "../../src/services/index.js"
import { textShapeOfCell } from "../../src/services/NotebookExecutionService.js"
import type { KernelManagerShape } from "../../src/services/KernelManager.js"
import type { PythonServiceShape } from "../../src/services/PythonService.js"
import type { ToolContext } from "../../src/tool.js"

const ctx = (d: string) => ({
  sessionID: "t", messageID: "t", agent: "t", directory: d, worktree: d,
  abort: new AbortController().signal, metadata: () => {}, ask: async () => {}
}) as unknown as ToolContext

const pythonSvc = {
  probe: () => Effect.succeed({ pythonPath: "/usr/bin/python3", version: "3", executable: "python3", from: "options" as const }),
  findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
  checkDependencies: () => Effect.succeed([]),
  candidates: () => Effect.succeed([]),
  checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
  doctor: () => Effect.succeed({} as never)
} as unknown as PythonServiceShape

const run = async <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e as Effect.Effect<A, E, never>)

describe("text shape is decided per cell", () => {
  it("ignores application/json arrays, which nbformat never splits", () => {
    const cell = {
      cell_type: "code", execution_count: null, metadata: {}, source: "x",
      outputs: [{ output_type: "display_data", data: { "application/json": [{ a: 1 }] } }]
    }
    expect(textShapeOfCell(cell as never, "arrays")).toBe("strings")
  })

  it("classifies a cell by its own text, not the notebook", () => {
    const arrayCell = {
      cell_type: "code", execution_count: 1, metadata: {}, source: ["x"],
      outputs: [{ output_type: "stream", name: "stdout", text: ["a\n"] }]
    }
    const stringCell = {
      cell_type: "code", execution_count: 1, metadata: {}, source: ["x"],
      outputs: [{ output_type: "stream", name: "stdout", text: "a\n" }]
    }
    expect(textShapeOfCell(arrayCell as never, "strings")).toBe("arrays")
    expect(textShapeOfCell(stringCell as never, "arrays")).toBe("strings")
  })

  it("falls back to the cell source, then the notebook shape", () => {
    const noOutputs = {
      cell_type: "code", execution_count: null, metadata: {}, source: ["x"], outputs: []
    }
    expect(textShapeOfCell(noOutputs as never, "strings")).toBe("arrays")
    const bare = { cell_type: "code", metadata: {}, outputs: [] } as never
    expect(textShapeOfCell(bare, "arrays")).toBe("arrays")
    expect(textShapeOfCell(bare, "strings")).toBe("strings")
  })
})

describe("ipynb_run save keeps each cell's own text shape", () => {
  const saveWith = async (text: string, executed: number[], rawByCell: Map<number, any[]>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shape-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, text)
    try {
      const kernel = {
        execute: () => Effect.succeed({
          success: true,
          executedCells: executed,
          durationMs: 1,
          outputs: executed.map((idx) => ({
            cellIndex: idx, status: "ok" as const, executionCount: 1,
            rawOutputs: rawByCell.get(idx) ?? [],
            stdout: "x\n"
          }))
        })
      } as unknown as KernelManagerShape
      const exec = makeExecutionImpl(
        makePathService({ directory: dir, worktree: dir, platform: process.platform }),
        makeNotebookFileService(),
        makePermissionService(ctx(dir)),
        pythonSvc,
        { kernelManager: kernel, warmKernel: true, defaultTimeoutMs: 30_000 }
      )
      await run(exec.execute(file, {
        mode: "all", cellIndex: undefined, start: undefined, end: undefined,
        kernel: undefined, timeoutMs: 30_000, save: true,
        workingDirectory: undefined, maxOutputChars: 4_000
      }))
      return JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ outputs: Array<Record<string, unknown>> }>
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it("splits a cell that stored arrays", async () => {
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
   "source": [
    "a"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`
    const raw = [{ name: "stdout", output_type: "stream", text: "new\nline\n" }]
    const out = await saveWith(text, [0], new Map([[0, raw]]))
    expect(out.cells[0]?.outputs[0]?.text).toEqual(["new\n", "line\n"])
  })

  it("keeps strings when the executed cell stored strings, even if another cell has an array", async () => {
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
     "text": "old\\n"
    }
   ],
   "source": [
    "a"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "stray\\n"
     ]
    }
   ],
   "source": [
    "b"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`
    const raw = [{ name: "stdout", output_type: "stream", text: "new\nline\n" }]
    const out = await saveWith(text, [0], new Map([[0, raw]]))
    expect(out.cells[0]?.outputs[0]?.text).toBe("new\nline\n")
  })
})
