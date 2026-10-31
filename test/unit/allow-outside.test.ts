import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildServices } from "../../src/services/index.js"
import type { ToolContext } from "../../src/tool.js"

const notebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: "x = 1"
    }
  ]
})

const makeContext = (
  directory: string,
  worktree: string,
  pluginOptions: Record<string, unknown>
): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "build",
    directory,
    worktree,
    abort: new AbortController().signal,
    pluginOptions,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

describe("buildServices allowOutsideWorktree", () => {
  it("reads an outside notebook when the escape hatch is enabled", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-allow-work-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-allow-out-"))
    const file = path.join(outside, "outside.ipynb")
    fs.writeFileSync(file, notebook)
    const previous = process.env.OPENCODE_IPYNB_OPTIONS
    delete process.env.OPENCODE_IPYNB_OPTIONS
    try {
      const allowed = buildServices(
        makeContext(worktree, worktree, { allowOutsideWorktree: true })
      )
      const read = await Effect.runPromise(allowed.file.read(file))
      expect(read.cells[0]?.source).toBe("x = 1")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_IPYNB_OPTIONS
      else process.env.OPENCODE_IPYNB_OPTIONS = previous
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects an outside notebook by default", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-allow-work-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-allow-out-"))
    const file = path.join(outside, "outside.ipynb")
    fs.writeFileSync(file, notebook)
    const previous = process.env.OPENCODE_IPYNB_OPTIONS
    delete process.env.OPENCODE_IPYNB_OPTIONS
    try {
      const services = buildServices(makeContext(worktree, worktree, {}))
      const result = await Effect.runPromiseExit(services.file.read(file))
      expect(result._tag).toBe("Failure")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_IPYNB_OPTIONS
      else process.env.OPENCODE_IPYNB_OPTIONS = previous
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
