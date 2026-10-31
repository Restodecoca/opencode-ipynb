import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ipynbReproTool } from "../../src/tools/repro.js"
import { ipynbDoctorTool } from "../../src/tools/doctor.js"
import type { ToolContext } from "../../src/tool.js"

const notebook = {
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
}

describe("ipynb_repro permission ordering", () => {
  it("never spawns the interpreter when shell is denied", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-repro-perm-"))
    const file = path.join(dir, "n.ipynb")
    const log = path.join(dir, "python-called.log")
    const wrapper = path.join(dir, "python-wrapper")
    fs.writeFileSync(file, JSON.stringify(notebook))
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\necho called >> ${JSON.stringify(log)}\nexec /usr/bin/python3 "$@"\n`,
      "utf8"
    )
    fs.chmodSync(wrapper, 0o755)
    const context = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      pluginOptions: { pythonPath: wrapper, preferUv: false },
      metadata: () => {},
      ask: async (request: { permission: string; patterns?: string[] }) => {
        if (request.permission === "shell") {
          patterns.push(...(request.patterns ?? []))
          throw new Error("shell denied by host")
        }
      }
    } as unknown as ToolContext
    const patterns: string[] = []
    try {
      await expect(
        ipynbReproTool.execute({ filePath: file }, context)
      ).rejects.toThrow()
      expect(fs.existsSync(log)).toBe(false)
      expect(
        patterns.some((pattern) => pattern.endsWith("ipynb_runner.py"))
      ).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_doctor also refuses to probe when shell is denied", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-doctor-perm-"))
    const log = path.join(dir, "python-called.log")
    const wrapper = path.join(dir, "python-wrapper")
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\necho called >> ${JSON.stringify(log)}\nexec /usr/bin/python3 "$@"\n`,
      "utf8"
    )
    fs.chmodSync(wrapper, 0o755)
    const context = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      pluginOptions: { pythonPath: wrapper, preferUv: false },
      metadata: () => {},
      ask: async (request: { permission: string }) => {
        if (request.permission === "shell") {
          throw new Error("shell denied by host")
        }
      }
    } as unknown as ToolContext
    try {
      await expect(
        ipynbDoctorTool.execute({ includeSuggestions: true }, context)
      ).rejects.toThrow()
      expect(fs.existsSync(log)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
