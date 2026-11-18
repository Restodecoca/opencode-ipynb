import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ipynbDoctorTool } from "../../src/tools/doctor.js"
import type { ToolContext } from "../../src/tool.js"

const ENV = "OPENCODE_IPYNB_OPTIONS"

const context = (dir: string): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

const run = async (options: string): Promise<string> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-doctor-opts-"))
  const previous = process.env[ENV]
  process.env[ENV] = options
  try {
    const result = await ipynbDoctorTool.execute(
      { includeSuggestions: true },
      context(dir)
    )
    return typeof result === "string" ? result : result.output
  } finally {
    if (previous === undefined) delete process.env[ENV]
    else process.env[ENV] = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("ipynb_doctor plugin options warning", () => {
  it("reports an invalid options variable instead of silently defaulting", async () => {
    const output = await run(JSON.stringify({ warmKernel: "yes" }))
    expect(output).toContain("## Plugin options")
    expect(output).toContain("warmKernel")
    expect(output).toContain("invalid")
    expect(output).toContain("default options are in effect")
  })

  it("reports unparseable JSON with the parse failure", async () => {
    const output = await run("{ not json")
    expect(output).toContain("## Plugin options")
    expect(output).toContain("OPENCODE_IPYNB_OPTIONS is set but invalid")
  })

  it("renders no options section when the variable is valid", async () => {
    const output = await run(JSON.stringify({ warmKernel: true }))
    expect(output).not.toContain("## Plugin options")
  })
})
