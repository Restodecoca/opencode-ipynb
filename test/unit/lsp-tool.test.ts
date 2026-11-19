import { afterEach, describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ipynbLspTool } from "../../src/tools/lsp.js"
import type { ToolContext } from "../../src/tool.js"
import { makeWarningSink, type WarningSink } from "../../src/utils/warnings.js"

type ObjectToolResult = { output: string; metadata?: Record<string, unknown> }
const runTool = async (
  filePath: string,
  context: ToolContext
): Promise<ObjectToolResult> =>
  (await ipynbLspTool.execute({ filePath, operation: "diagnostics" }, context)) as ObjectToolResult

const ENV = "OPENCODE_IPYNB_OPTIONS"
const previousEnv = process.env[ENV]

const makeNotebook = (language = "python"): string =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: language, language, name: `${language}3` },
      language_info: { name: language }
    },
    cells: [
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: language === "python" ? "x = 1" : "x <- 1"
      }
    ]
  })

const makeContext = (dir: string, warningSink?: WarningSink): ToolContext => ({
  sessionID: "ses_1",
  messageID: "msg_1",
  agent: "build",
  directory: dir,
  worktree: dir,
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
  ...(warningSink === undefined ? {} : { warningSink })
})

const fakePyright = (dir: string, body: string): string => {
  const script = path.join(dir, "fake-pyright")
  fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, "utf8")
  fs.chmodSync(script, 0o755)
  return script
}

describe("ipynb_lsp tool", () => {
  afterEach(() => {
    if (previousEnv === undefined) delete process.env[ENV]
    else process.env[ENV] = previousEnv
  })

  it("reports timeout instead of claiming a clean notebook", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-timeout-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    process.env[ENV] = JSON.stringify({
      pyrightPath: fakePyright(dir, "sleep 30"),
      diagnosticsTimeoutMs: 200
    })
    try {
      const result = await runTool(file, makeContext(dir))
      expect(result.output).toContain("timed out")
      expect(result.metadata?.skipped).toBe("timeout")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports invalid output instead of claiming a clean notebook", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-invalid-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    process.env[ENV] = JSON.stringify({
      pyrightPath: fakePyright(dir, "exit 1"),
      diagnosticsTimeoutMs: 5_000
    })
    try {
      const result = await runTool(file, makeContext(dir))
      expect(result.output).toContain("Diagnostics failed")
      expect(result.metadata?.skipped).toBe("invalid-output")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports missing pyright and records the configured path that failed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-missing-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    const configured = path.join(dir, "does-not-exist")
    process.env[ENV] = JSON.stringify({ pyrightPath: configured })
    const sink = makeWarningSink()
    try {
      const result = await runTool(file, makeContext(dir, sink))
      expect(result.output).toContain("pyright was not found")
      expect(result.metadata?.skipped).toBe("pyright-not-found")
      const warnings = sink.drain()
      expect(warnings.some((warning) => (warning.detail ?? "").includes(configured))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses non-Python notebooks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-r-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook("r"))
    try {
      const result = await runTool(file, makeContext(dir))
      expect(result.output).toContain("Python notebooks only")
      expect(result.metadata?.skipped).toBe("unsupported-language")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("materializes the virtual document and returns the cell map", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-materialize-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
          language_info: { name: "python" }
        },
        cells: [
          {
            cell_type: "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: "def add(a: int, b: int) -> int:\n    return a + b"
          },
          {
            cell_type: "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: "result = add(1, 2)"
          }
        ]
      })
    )
    try {
      const result = (await ipynbLspTool.execute(
        { filePath: file, operation: "materialize" },
        makeContext(dir)
      )) as ObjectToolResult
      expect(result.output).toContain("Virtual Python document:")
      expect(result.output).toContain("cell 0 (code): lines 1-2")
      expect(result.output).toContain("cell 1 (code): line 3")
      const virtualPath = result.metadata?.virtualPath
      expect(typeof virtualPath).toBe("string")
      expect(fs.readFileSync(String(virtualPath), "utf8")).toContain("result = add(1, 2)")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("asks permission before materializing and propagates a denial", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-permission-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    let asked = 0
    const context = {
      ...makeContext(dir),
      ask: async () => {
        asked += 1
        if (asked === 2) throw new Error("host rejected the permission")
      }
    }
    try {
      await expect(
        ipynbLspTool.execute(
          { filePath: file, operation: "materialize" },
          context
        )
      ).rejects.toThrow("host rejected the permission")
      expect(asked).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("materializes under the session directory when the worktree is a parent", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-sub-"))
    const sub = path.join(project, "sub")
    fs.mkdirSync(sub)
    const file = path.join(sub, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    const context = { ...makeContext(sub), worktree: project }
    try {
      const result = (await ipynbLspTool.execute(
        { filePath: file, operation: "materialize" },
        context
      )) as ObjectToolResult
      const virtualPath = String(result.metadata?.virtualPath)
      expect(path.dirname(virtualPath)).toBe(sub)
      expect(path.basename(virtualPath)).toMatch(/^opencode-ipynb-lsp-[0-9a-f]{16}\.py$/)
      expect(fs.existsSync(virtualPath)).toBe(true)
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it("propagates a host rejection for the lsp permission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-diag-permission-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    const fake = path.join(dir, "fake-pyright")
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n")
    fs.chmodSync(fake, 0o755)
    process.env[ENV] = JSON.stringify({ pyrightPath: fake })
    let calls = 0
    const context = {
      ...makeContext(dir),
      ask: async () => {
        calls += 1
        if (calls === 2) throw new Error("diagnostics denied")
      }
    }
    try {
      await expect(
        ipynbLspTool.execute(
          { filePath: file, operation: "diagnostics" },
          context
        )
      ).rejects.toThrow("diagnostics denied")
      expect(calls).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns a clean result for a successful diagnostics run", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-clean-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    process.env[ENV] = JSON.stringify({
      pyrightPath: fakePyright(
        dir,
        'echo \'{"generalDiagnostics":[]}\''
      )
    })
    try {
      const result = await runTool(file, makeContext(dir))
      expect(result.output).toBe("No errors found.")
      expect(result.metadata?.notebookDiagnostics).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("propagates a denial for the diagnostics temp-file write", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-diag-edit-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    const fake = path.join(dir, "fake-pyright")
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n")
    fs.chmodSync(fake, 0o755)
    process.env[ENV] = JSON.stringify({ pyrightPath: fake })
    let calls = 0
    const context = {
      ...makeContext(dir),
      ask: async () => {
        calls += 1
        if (calls === 3) throw new Error("temp write denied")
      }
    }
    try {
      await expect(
        ipynbLspTool.execute(
          { filePath: file, operation: "diagnostics" },
          context
        )
      ).rejects.toThrow("temp write denied")
      expect(calls).toBe(3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("propagates a fallback-temp permission denial instead of returning normal content", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-fallback-denial-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    const script = fakePyright(dir, 'echo \'{"generalDiagnostics":[],"summary":{"filesAnalyzed":1}}\'')
    process.env[ENV] = JSON.stringify({ pyrightPath: script })
    let calls = 0
    const context = {
      ...makeContext(dir),
      ask: async () => {
        calls += 1
        if (calls === 4) throw new Error("fallback denied")
      }
    }
    const originalMode = fs.statSync(dir).mode
    try {
      fs.chmodSync(dir, 0o555)
      await expect(
        ipynbLspTool.execute(
          { filePath: file, operation: "diagnostics" },
          context
        )
      ).rejects.toThrow("fallback denied")
      expect(calls).toBe(4)
    } finally {
      fs.chmodSync(dir, originalMode)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("asks read/lsp (not edit) when pyright is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-no-pyright-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, makeNotebook())
    process.env[ENV] = JSON.stringify({
      pyrightPath: path.join(dir, "missing-pyright")
    })
    let asked = 0
    const context = {
      ...makeContext(dir),
      ask: async () => {
        asked += 1
      }
    }
    try {
      const result = (await ipynbLspTool.execute(
        { filePath: file, operation: "diagnostics" },
        context
      )) as ObjectToolResult
      expect(result.output).toContain("pyright was not found")
      expect(result.metadata?.skipped).toBe("pyright-not-found")
      // read + lsp are asserted; the temp edit prompt is skipped because
      // pyright is not spawned at all.
      expect(asked).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})
