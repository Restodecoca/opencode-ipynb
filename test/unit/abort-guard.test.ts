import { describe, expect, it } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { toV2Tool } from "../../src/plugin-v2.js"
import { v2ToolRegistrations } from "../../src/registrations.js"
import { ipynbEditTool } from "../../src/tools/edit.js"
import type { ToolContext } from "../../src/tool.js"

const notebook = `${JSON.stringify(
  {
    cells: [
      { cell_type: "markdown", metadata: {}, source: ["# A"] }
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  },
  null,
  1
)}\n`

const pluginContext = (dir: string): Plugin.Context =>
  ({
    location: { directory: dir, project: { directory: dir } },
    options: {},
    permission: { assert: async () => {} },
    tool: { transform: async () => ({ dispose: async () => {} }) }
  }) as unknown as Plugin.Context

const registration = v2ToolRegistrations.find(
  (entry) => entry.name === "ipynb_edit"
)!

describe("an already-cancelled tool call", () => {
  it("changes nothing and reports the cancellation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-abort-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook)
    const before = fs.readFileSync(file)
    const controller = new AbortController()
    controller.abort()
    try {
      const toolInfo = toV2Tool(pluginContext(dir), registration, {})
      const result = (await toolInfo.execute(
        { filePath: file, cellIndex: 0, source: "# B", clearOutputs: "never" },
        {
          sessionID: "ses_1",
          messageID: "msg_1",
          agent: "build",
          id: "call_1",
          signal: controller.signal,
          progress: async () => {}
        } as never
      )) as { content: string; metadata?: { error?: boolean; message?: string } }
      expect(result.content).toContain("cancelled")
      expect(result.metadata?.error).toBe(true)
      expect(fs.readFileSync(file).equals(before)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("also refuses a raw tool definition invoked directly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-abort-raw-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook)
    const before = fs.readFileSync(file)
    const controller = new AbortController()
    controller.abort()
    try {
      const result = await ipynbEditTool.execute(
        {
          filePath: file,
          cellIndex: 0,
          source: "# RAW",
          clearOutputs: "never"
        },
        {
          sessionID: "t",
          messageID: "t",
          agent: "t",
          directory: dir,
          worktree: dir,
          abort: controller.signal,
          metadata: () => {},
          ask: async () => {}
        } as unknown as ToolContext
      )
      expect(typeof result !== "string" && result.metadata?.error).toBe(true)
      expect(fs.readFileSync(file).equals(before)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
