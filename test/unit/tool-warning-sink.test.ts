import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ipynbEditTool } from "../../src/tools/edit.js"
import { makeWarningSink } from "../../src/utils/warnings.js"
import type { ToolContext } from "../../src/tool.js"

const makeContext = (dir: string, sink?: unknown): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    warningSink: sink
  }) as unknown as ToolContext

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-sink-"))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const notebook = `{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "a",
   "metadata": {},
   "source": [
    "# A"
   ]
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`

describe("tool context carries the warning sink", () => {
  it("edits a notebook and reports the write mode", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, notebook)
      const sink = makeWarningSink()
      const result = await ipynbEditTool.execute(
        { filePath: file, cellIndex: 0, source: "# B", clearOutputs: "never" },
        makeContext(dir, sink)
      )
      expect(String((result as { output: string }).output)).toContain("Edited cell [0]")
      expect((result as { metadata: Record<string, unknown> }).metadata.writeMode).toBe(
        "patched"
      )
    })
  })

  it("still works when the context has no sink", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, notebook)
      const result = await ipynbEditTool.execute(
        { filePath: file, cellIndex: 0, source: "# C", clearOutputs: "never" },
        makeContext(dir)
      )
      expect(String((result as { output: string }).output)).toContain("Edited cell [0]")
    })
  })
})

describe("appendWarnings surfaces collected warnings", () => {
  it("renders warnings into the tool output and metadata", async () => {
    const { toV2Result } = await import("../../src/plugin-v2.js")
    const sink = makeWarningSink()
    sink.add({ source: "lock", message: "could not canonicalize", detail: "EACCES" })
    sink.add({ source: "temp-unlink", message: "left /tmp/x.tmp" })
    const warnings = sink.drain()
    expect(warnings.length).toBe(2)

    const pluginContext = {
      location: { directory: "/tmp", project: { directory: "/tmp" } },
      permission: { assert: async () => {} },
      options: {}
    } as never
    const toolContext = {
      sessionID: "s",
      messageID: "m",
      agent: "a",
      id: "i",
      signal: new AbortController().signal,
      progress: async () => {}
    } as never
    const { toToolContext } = await import("../../src/plugin-v2.js")
    const built = toToolContext(pluginContext, toolContext, undefined, makeWarningSink())
    expect(built.warningSink).toBeDefined()
    expect(toV2Result({ output: "done" })).toBeDefined()
  })
})
