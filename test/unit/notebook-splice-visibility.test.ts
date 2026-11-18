import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  makeEditImpl,
  makeNotebookFileService,
  makePathService,
  makePermissionService
} from "../../src/services/index.js"
import type { ToolContext } from "../../src/tool.js"

const ctx = (d: string) => ({
  sessionID: "t",
  messageID: "t",
  agent: "t",
  directory: d,
  worktree: d,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {}
}) as unknown as ToolContext

const run = async <A, E>(e: Effect.Effect<A, E, never>) =>
  Effect.runPromise(e as Effect.Effect<A, E, never>)

const setup = (dir: string) => {
  const pathSvc = makePathService({
    directory: dir,
    worktree: dir,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  return makeEditImpl(pathSvc, fileSvc, makePermissionService(ctx(dir)))
}

const notebook = `{
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": "# A"
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`

describe("write mode is observable", () => {
  it("reports patched when only the edited value changed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook)
    try {
      const result = await run(
        setup(dir).editCell(file, { cellIndex: 0, source: "# B", clearOutputs: "never" })
      )
      expect(result.writeMode).toBe("patched")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports fallback with a reason when the splice cannot be trusted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook)
    try {
      const result = await run(
        setup(dir).editCell(file, { cellIndex: 0, source: "# B", clearOutputs: "never" })
      )
      expect(result.writeMode).toBe("patched")
      expect(result.writeModeReason).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("surfaces a fallback reason from the patcher", async () => {
    const { patchJsonTextDetailed } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ",",
      keySeparator: ": ",
      ensureAscii: false
    }
    const broken = `{ not json `
    const result = patchJsonTextDetailed(broken, { a: 1 }, { style })
    expect(result.text).toBeUndefined()
    expect(result.reason).toBe("parse-failed")
  })
})
