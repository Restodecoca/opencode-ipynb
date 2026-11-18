import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ipynbEditTool } from "../../src/tools/edit.js"
import { ipynbCleanTool } from "../../src/tools/clean.js"
import { ipynbCellInsertTool } from "../../src/tools/cell_insert.js"
import type { ToolContext } from "../../src/tool.js"

const SECRET = "AWS_SECRET_ACCESS_KEY_HEAD_SUPERSECRET_999"

const brokenNotebook = `{ "cells": [ ${SECRET} `

type Ask = { permission: string; patterns?: string[] }

const denyingReadContext = (dir: string, asks: Ask[]): ToolContext =>
  ({
    sessionID: "t",
    messageID: "t",
    agent: "t",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async (request: Ask) => {
      asks.push(request)
      if (request.permission === "read") {
        throw new Error("read denied by policy")
      }
    }
  }) as unknown as ToolContext

const outputOf = (result: unknown): string => {
  if (typeof result === "string") return result
  const record = result as { output?: string; content?: string; message?: string }
  return record.output ?? record.content ?? record.message ?? ""
}

const tools = {
  ipynb_edit: (file: string, context: ToolContext) =>
    ipynbEditTool.execute(
      { filePath: file, cellIndex: 0, source: "# B", clearOutputs: "never" },
      context
    ),
  ipynb_clean: (file: string, context: ToolContext) =>
    ipynbCleanTool.execute(
      {
        filePath: file,
        clearOutputs: true,
        clearExecutionCount: true,
        stripWidgetState: true,
        stripLargeImages: true,
        normalizeSource: true
      },
      context
    ),
  ipynb_cell_insert: (file: string, context: ToolContext) =>
    ipynbCellInsertTool.execute(
      { filePath: file, cellType: "markdown", source: "# C" },
      context
    )
}

describe("a denied read never discloses notebook bytes", () => {
  for (const [name, execute] of Object.entries(tools)) {
    it(`${name} asks for read before parsing the notebook`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-leak-"))
      const file = path.join(dir, "s.ipynb")
      fs.writeFileSync(file, brokenNotebook)
      const asks: Ask[] = []
      const before = fs.readFileSync(file)
      try {
        let surfaced = ""
        try {
          surfaced = outputOf(await execute(file, denyingReadContext(dir, asks)))
        } catch (error) {
          surfaced = error instanceof Error ? error.message : String(error)
        }
        expect(surfaced).not.toContain(SECRET)
        expect(asks[0]?.permission).toBe("read")
        expect(fs.readFileSync(file).equals(before)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
