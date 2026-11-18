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
import { makeWarningSink } from "../../src/utils/warnings.js"

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

  it("reports no write mode when the edit changes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook)
    const before = fs.readFileSync(file, "utf8")
    try {
      const result = await run(
        setup(dir).editCell(file, { cellIndex: 0, source: "# A", clearOutputs: "never" })
      )
      expect(result.changed).toBe(false)
      expect(result.writeMode).toBeUndefined()
      expect(fs.readFileSync(file, "utf8")).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports fallback with a reason when the splice cannot be trusted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook)
    const sink = makeWarningSink()
    try {
      const fileSvc = makeNotebookFileService({ warningSink: sink })
      const document = JSON.parse(notebook) as {
        cells: Array<Record<string, unknown>>
        metadata: Record<string, unknown>
      }
      const next = {
        ...document,
        metadata: { ...document.metadata, ans: NaN }
      }
      const read = await Effect.runPromise(fileSvc.readWithText(file))
      const outcome = await Effect.runPromise(
        fileSvc.writeAtomic(file, next as never, {
          format: read.format,
          previousText: read.text
        })
      )
      expect(outcome.mode).toBe("fallback")
      expect(outcome.reason).toBe("verification-failed")
      expect(sink.drain().some((warning: { source: string }) => warning.source === "json-patch")).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("propagates the write outcome from the service instead of assuming a patch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "splice-outcome-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook)
    try {
      const pathSvc = makePathService({
        directory: dir,
        worktree: dir,
        platform: process.platform
      })
      const real = makeNotebookFileService()
      const fileSvc = {
        ...real,
        writeAtomic: (() => Effect.succeed({ mode: "fallback" as const, reason: "not-representable" as const })) as typeof real.writeAtomic
      }
      const edit = makeEditImpl(pathSvc, fileSvc, makePermissionService(ctx(dir)))
      const result = await run(
        edit.editCell(file, { cellIndex: 0, source: "# B", clearOutputs: "never" })
      )
      expect(result.writeMode).toBe("fallback")
      expect(result.writeModeReason).toBe("not-representable")
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

  it("patches an inline object whose every key is replaced", async () => {
    const { patchJsonTextDetailed } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ",",
      keySeparator: ": ",
      ensureAscii: false
    }
    const result = patchJsonTextDetailed('{"x": 1}', { y: 2 }, { style })
    expect(result.reason).toBeUndefined()
    expect(result.text).toBe('{"y": 2}')
  })

  it("patches a multiline object whose every key is replaced", async () => {
    const { patchJsonTextDetailed } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ",",
      keySeparator: ": ",
      ensureAscii: false
    }
    const result = patchJsonTextDetailed('{\n "x": 1\n}', { y: 2 }, { style })
    expect(result.reason).toBeUndefined()
    expect(result.text).toBe('{\n "y": 2\n}')
  })

  it("keeps sibling bytes when a nested object replaces every key", async () => {
    const { patchJsonTextDetailed } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ",",
      keySeparator: ": ",
      ensureAscii: false
    }
    const previous = `{
 "a": "untouched",
 "metadata": {
  "x": 1
 }
}`
    const result = patchJsonTextDetailed(
      previous,
      { a: "untouched", metadata: { y: 2 } },
      { style }
    )
    expect(result.reason).toBeUndefined()
    expect(result.text).toBe(`{
 "a": "untouched",
 "metadata": {
  "y": 2
 }
}`)
  })

  it("anchors an added key before the first surviving key that sorts after it", async () => {
    const { patchJsonTextDetailed } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false
    }
    const previous = `{
 "z": 1,
 "a": 2
}`
    const result = patchJsonTextDetailed(previous, { z: 1, a: 2, c: 3 }, { style })
    expect(result.reason).toBeUndefined()
    expect(result.text).toBe(`{
 "c": 3,
 "z": 1,
 "a": 2
}`)
  })

  it("keeps an added container value inline when its object is inline", async () => {
    const { patchJsonTextDetailed } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false
    }
    const previous = `{
 "inline": {"a": 1},
 "other": 2
}`
    const result = patchJsonTextDetailed(
      previous,
      { inline: { a: 1, arr: [1, 2] }, other: 2 },
      { style }
    )
    expect(result.reason).toBeUndefined()
    expect(result.text).toBe(`{
 "inline": {"a": 1, "arr": [1, 2]},
 "other": 2
}`)
  })

  it("keeps an added container value multiline when its object is multiline", async () => {
    const { patchJsonTextDetailed } = await import("../../src/utils/json-patch.js")
    const style = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false
    }
    const previous = `{
 "block": {
  "a": 1
 },
 "other": 2
}`
    const result = patchJsonTextDetailed(
      previous,
      { block: { a: 1, arr: [1, 2] }, other: 2 },
      { style }
    )
    expect(result.reason).toBeUndefined()
    expect(result.text).toBe(`{
 "block": {
  "a": 1,
  "arr": [
   1,
   2
  ]
 },
 "other": 2
}`)
  })
})
