import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildNotebookVirtualDocument } from "../../src/lsp.js"
import {
  diagnoseNotebook,
  diagnosticTempPath,
  sanitizeNotebookText
} from "../../src/notebook-diagnostics.js"

const notebook = {
  metadata: {
    kernelspec: { name: "python3", language: "python" },
    language_info: { name: "python", file_extension: ".py" }
  },
  cells: [
    { cell_type: "code", source: "x = 1" },
    { cell_type: "code", source: "print(y)" }
  ]
}

const makeFakePyright = (
  dir: string,
  line = 1,
  character = 6,
  rule: string | null | undefined = "reportUndefinedVariable"
): string => {
  const ruleJson = rule == null ? "" : `,"rule":"${rule}"`
  const script = path.join(dir, "fake-pyright")
  fs.writeFileSync(
    script,
    `#!/bin/sh
for last; do :; done
if [ -n "$CAPTURE_PATH" ]; then cp "$last" "$CAPTURE_PATH"; fi
cat <<EOF
{"generalDiagnostics":[{"file":"$last","severity":"error","message":"\\"y\\" is not defined"${ruleJson},"range":{"start":{"line":${line},"character":${character}},"end":{"line":${line},"character":${character + 1}}}}]}
EOF
`,
    "utf8"
  )
  fs.chmodSync(script, 0o755)
  return script
}

describe("notebook diagnostics", () => {

  it("rejects a FIFO at the deterministic temp path without blocking", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-fifo-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const temp = diagnosticTempPath(file)
    const made = Bun.spawnSync(["mkfifo", temp])
    if (made.exitCode !== 0) {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    }
    try {
      const started = Date.now()
      const outcome = await Promise.race([
        diagnoseNotebook({
          filePath: file,
          document,
          displayPath: "notebook.ipynb",
          pyrightPath: makeFakePyright(dir)
        }).then((result) => ({ status: "resolved" as const, result })),
        new Promise<{ status: "hung" }>((resolve) =>
          setTimeout(() => resolve({ status: "hung" }), 2_000)
        )
      ])
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(outcome.status).toBe("resolved")
      if (outcome.status === "resolved") {
        expect(outcome.result.skipped).toBe("temp-unwritable")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })


  it("reports a non-executable pyright as pyright-not-executable", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-noexec-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const fake = path.join(dir, "fake-pyright")
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", "utf8")
    fs.chmodSync(fake, 0o644)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        displayPath: "notebook.ipynb",
        pyrightPath: fake
      })
      expect(result.skipped).toBe("pyright-not-executable")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })


  it("refuses a hardlinked diagnostics temp file without touching the victim", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-hardlink-"))
    const file = path.join(dir, "notebook.ipynb")
    const victim = path.join(dir, "victim.txt")
    const temp = diagnosticTempPath(file)
    fs.writeFileSync(victim, "ORIGINAL CONTENT")
    fs.linkSync(victim, temp)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        tempFilePath: temp,
        ownedTempFile: true,
        pyrightPath: "definitely-not-pyright"
      })
      expect(result.skipped).toBe("temp-unwritable")
      expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL CONTENT")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })


  it("reports temp-unwritable when the fallback temp directory is also unwritable", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-ro-"))
    const fallback = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-ro-tmp-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const previousTmp = process.env.TMPDIR
    fs.chmodSync(dir, 0o555)
    fs.chmodSync(fallback, 0o555)
    process.env.TMPDIR = fallback
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        displayPath: "notebook.ipynb",
        pyrightPath: "definitely-not-pyright"
      })
      expect(result.skipped).toBe("temp-unwritable")
    } finally {
      if (previousTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmp
      fs.chmodSync(dir, 0o755)
      fs.chmodSync(fallback, 0o755)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(fallback, { recursive: true, force: true })
    }
  })


  it("preserves UTF-8 split across pyright stdout chunks", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-utf8-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const script = path.join(dir, "utf8-pyright")
    fs.writeFileSync(
      script,
      `#!/usr/bin/env python3
import json, sys, time
path = sys.argv[-1]
payload = json.dumps({"generalDiagnostics": [{"file": path, "severity": "error", "message": "é", "rule": "r", "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 1}}}], "summary": {"filesAnalyzed": 1}}, ensure_ascii=False).encode()
marker = "é".encode()
idx = payload.find(marker)
sys.stdout.buffer.write(payload[:idx + 1])
sys.stdout.buffer.flush()
time.sleep(0.05)
sys.stdout.buffer.write(payload[idx + 1:])
sys.stdout.buffer.flush()
`,
      "utf8"
    )
    fs.chmodSync(script, 0o755)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        displayPath: "notebook.ipynb",
        pyrightPath: script
      })
      expect(result.diagnostics[0]?.message).toBe("é")
      expect(result.diagnostics[0]?.message.includes("\uFFFD")).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })


  it("refuses a world-readable pre-existing diagnostics temp file", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-mode-"))
    const file = path.join(dir, "notebook.ipynb")
    const temp = diagnosticTempPath(file)
    fs.writeFileSync(temp, "ORIGINAL")
    fs.chmodSync(temp, 0o666)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        tempFilePath: temp,
        ownedTempFile: true,
        pyrightPath: "definitely-not-pyright"
      })
      expect(result.skipped).toBe("temp-unwritable")
      expect(fs.readFileSync(temp, "utf8")).toBe("ORIGINAL")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("maps pyright errors back to cells", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        displayPath: "notebook.ipynb",
        where: "this file",
        pyrightPath: makeFakePyright(dir)
      })
      expect(result.skipped).toBeUndefined()
      expect(result.diagnostics).toEqual([
        {
          cellIndex: 1,
          line: 0,
          character: 6,
          endLine: 0,
          endCharacter: 7,
          severity: "error",
          message: '"y" is not defined',
          rule: "reportUndefinedVariable"
        }
      ])
      expect(result.text).toContain("LSP errors detected in this file")
      expect(result.text).toContain(`<diagnostics file="${file}">`)
      expect(result.text).toContain("ERROR [cell 1, line 1:7]")
      expect(result.text).not.toContain("(reportUndefinedVariable)")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("blanks IPython magics while preserving line positions", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-magic-"))
    const file = path.join(dir, "notebook.ipynb")
    const capture = path.join(dir, "captured.py")
    const document = buildNotebookVirtualDocument(
      {
        metadata: notebook.metadata,
        cells: [
          { cell_type: "code", source: "%matplotlib inline\nx = 1" },
          { cell_type: "code", source: "!ls" },
          { cell_type: "code", source: "%%time\nprint(undefined)" }
        ]
      },
      { filePath: file }
    )
    const previous = process.env.CAPTURE_PATH
    process.env.CAPTURE_PATH = capture
    try {
      await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: makeFakePyright(dir, 0, 0)
      })
      const captured = fs.readFileSync(capture, "utf8")
      expect(captured.split("\n")[0]?.trim()).toBe("pass")
      expect(captured.split("\n")[1]).toBe("x = 1")
      expect(captured.split("\n")[2]?.trim()).toBe("pass")
      expect(captured.split("\n")[3]?.trim()).toBe("pass")
      expect(captured.split("\n")[4]).toBe("print(undefined)")
    } finally {
      if (previous === undefined) delete process.env.CAPTURE_PATH
      else process.env.CAPTURE_PATH = previous
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("times out promptly even when a child keeps stdout open", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-slow-"))
    const file = path.join(dir, "notebook.ipynb")
    const script = path.join(dir, "slow-pyright")
    fs.writeFileSync(script, "#!/bin/sh\nsleep 30\n", "utf8")
    fs.chmodSync(script, 0o755)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const started = Date.now()
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script,
        timeoutMs: 250
      })
      expect(result.skipped).toBe("timeout")
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips gracefully when pyright is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-missing-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: path.join(dir, "does-not-exist")
      })
      expect(result.skipped).toBe("pyright-not-found")
      expect(result.diagnostics).toEqual([])
      expect(result.text).toBe("")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("treats a fatal pyright exit as invalid output, not a clean notebook", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-fatal-"))
    const file = path.join(dir, "notebook.ipynb")
    const script = path.join(dir, "fatal-pyright")
    fs.writeFileSync(
      script,
      '#!/bin/sh\necho \'{"generalDiagnostics":[]}\'\nexit 3\n',
      "utf8"
    )
    fs.chmodSync(script, 0o755)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.skipped).toBe("invalid-output")
      expect(result.text).toBe("")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses a stable temp path so an always-allow edit grant keeps working", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-stable-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, "{}")
    try {
      expect(diagnosticTempPath(file)).toBe(diagnosticTempPath(file))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("never deletes a caller-supplied temp path it did not create", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-existing-"))
    const file = path.join(dir, "notebook.ipynb")
    const existing = path.join(dir, "existing.py")
    fs.writeFileSync(existing, "keep me")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        tempFilePath: existing,
        pyrightPath: "definitely-not-a-pyright-binary"
      })
      expect(result.skipped).toBe("temp-unwritable")
      expect(fs.readFileSync(existing, "utf8")).toBe("keep me")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not report a pyright config rejection as clean", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-config-"))
    const file = path.join(dir, "notebook.ipynb")
    const script = path.join(dir, "config-pyright")
    fs.writeFileSync(
      script,
      '#!/bin/sh\necho \'Config "include" entry must contain an array.\' >&2\necho \'{"generalDiagnostics":[]}\'\nexit 0\n',
      "utf8"
    )
    fs.chmodSync(script, 0o755)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.skipped).toBe("invalid-output")
      expect(result.text).toBe("")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not report clean when pyright analyzed zero files", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-zero-"))
    const file = path.join(dir, "notebook.ipynb")
    const script = path.join(dir, "zero-pyright")
    fs.writeFileSync(
      script,
      '#!/bin/sh\necho \'{"generalDiagnostics":[],"summary":{"filesAnalyzed":0}}\'\nexit 0\n',
      "utf8"
    )
    fs.chmodSync(script, 0o755)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.skipped).toBe("not-analyzed")
      expect(result.text).toBe("")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("recovers from a stale production temp file when the plugin owns it", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-stale-"))
    const file = path.join(dir, "notebook.ipynb")
    const script = path.join(dir, "ok-pyright")
    fs.writeFileSync(
      script,
      '#!/bin/sh\necho \'{"generalDiagnostics":[],"summary":{"filesAnalyzed":1}}\'\nexit 0\n',
      "utf8"
    )
    fs.chmodSync(script, 0o755)
    const stale = diagnosticTempPath(file)
    fs.writeFileSync(stale, "stale")
    fs.chmodSync(stale, 0o600)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        tempFilePath: stale,
        ownedTempFile: true,
        pyrightPath: script
      })
      expect(result.skipped).toBeUndefined()
      expect(result.text).toBe("")
      expect(fs.existsSync(stale)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to the system temp dir when the notebook directory is read-only", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-ro-"))
    const file = path.join(dir, "notebook.ipynb")
    const script = path.join(os.tmpdir(), `ok-pyright-${process.pid}-${Date.now()}`)
    fs.writeFileSync(
      script,
      '#!/bin/sh\necho \'{"generalDiagnostics":[],"summary":{"filesAnalyzed":1}}\'\nexit 0\n',
      "utf8"
    )
    fs.chmodSync(script, 0o755)
    const tempFile = diagnosticTempPath(file)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const originalMode = fs.statSync(dir).mode
    try {
      fs.chmodSync(dir, 0o555)
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        tempFilePath: tempFile,
        ownedTempFile: true,
        pyrightPath: script
      })
      expect(result.skipped).toBeUndefined()
      expect(result.text).toBe("")
    } finally {
      fs.chmodSync(dir, originalMode)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(script, { force: true })
    }
  })

  it("places diagnostics next to the real notebook for symlink aliases", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-alias-"))
    const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-alias-link-"))
    const real = path.join(dir, "notebook.ipynb")
    const alias = path.join(aliasDir, "notebook.ipynb")
    fs.writeFileSync(real, "{}")
    fs.symlinkSync(real, alias)
    try {
      // The temp file lands next to the real notebook, which is the resolved
      // directory; on macOS the lexical temp dir spells it through a symlink.
      expect(path.dirname(diagnosticTempPath(alias))).toBe(fs.realpathSync(dir))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(aliasDir, { recursive: true, force: true })
    }
  })


  it("blanks leading IPython help prefixes", () => {
    const document = buildNotebookVirtualDocument(
      { metadata: {}, cells: [{ cell_type: "code", source: "?df.head\n??df.tail" }] },
      { filePath: "/tmp/help-prefix.ipynb" }
    )
    const text = sanitizeNotebookText(document)
    expect(text.split("\n")[0]?.trim()).toBe("pass")
    expect(text.split("\n")[1]?.trim()).toBe("pass")
    expect(text.split("\n")[0]?.length).toBe("?df.head".length)
  })

  it("blanks IPython help suffixes while keeping positions", () => {
    const document = buildNotebookVirtualDocument(
      { metadata: {}, cells: [{ cell_type: "code", source: "df.head?\nx = 1" }] },
      { filePath: "/tmp/help.ipynb" }
    )
    const text = sanitizeNotebookText(document)
    expect(text).toContain("pass")
    expect(text).toContain("x = 1")
    expect(text.split("\n")[0]?.length).toBe("df.head?".length)
  })

  it("maps an incomplete-construct error at a cell boundary to the previous cell", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-boundary-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          { cell_type: "code", source: "def f():" },
          { cell_type: "code", source: "x = 1" }
        ]
      },
      { filePath: file }
    )
    const script = makeFakePyright(dir, 1, 0, null)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.diagnostics).toHaveLength(1)
      expect(result.diagnostics[0]?.cellIndex).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not remap a real error in the next cell", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-negative-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          { cell_type: "code", source: "if True:" },
          { cell_type: "code", source: "    x: int = \"bad\"" }
        ]
      },
      { filePath: file }
    )
    const script = makeFakePyright(dir, 1, 9)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.diagnostics[0]?.cellIndex).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not treat a bracket inside a string as an open construct", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-string-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          { cell_type: "code", source: "s = \"(\"" },
          { cell_type: "code", source: "undefined_name" }
        ]
      },
      { filePath: file }
    )
    const script = makeFakePyright(dir, 1, 0)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.diagnostics[0]?.cellIndex).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not remap a semantic error after a comment ending in a colon", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-comment-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          { cell_type: "code", source: "# TODO:" },
          { cell_type: "code", source: "undefined_name" }
        ]
      },
      { filePath: file }
    )
    const script = makeFakePyright(dir, 1, 0)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.diagnostics[0]?.cellIndex).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("handles comments around an incomplete construct at a cell boundary", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-comment-boundary-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          { cell_type: "code", source: "def f():  # comment\n    # body" },
          { cell_type: "code", source: "x = 1" }
        ]
      },
      { filePath: file }
    )
    const script = makeFakePyright(dir, 2, 0, null)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.diagnostics[0]?.cellIndex).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not treat a comment-only colon as an open construct", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-comment-fp-"))
    const file = path.join(dir, "notebook.ipynb")
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          { cell_type: "code", source: "# TODO:" },
          { cell_type: "code", source: ")" }
        ]
      },
      { filePath: file }
    )
    const script = makeFakePyright(dir, 1, 0, null)
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.diagnostics[0]?.cellIndex).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses to follow a symlink at the owned diagnostics temp path", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-temp-link-"))
    const file = path.join(dir, "notebook.ipynb")
    const victim = path.join(dir, "victim.py")
    const temp = diagnosticTempPath(file)
    fs.writeFileSync(victim, "keep")
    fs.symlinkSync(victim, temp)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        tempFilePath: temp,
        ownedTempFile: true,
        pyrightPath: "definitely-not-pyright"
      })
      expect(result.skipped).toBe("temp-unwritable")
      expect(fs.readFileSync(victim, "utf8")).toBe("keep")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps a real diagnostic on a line whose comment ends with a question mark", () => {
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          {
            cell_type: "code",
            source: 'x: int = "bad"  # why?'
          }
        ]
      },
      { filePath: "/tmp/comment-question.ipynb" }
    )
    expect(sanitizeNotebookText(document)).toContain('x: int = "bad"  # why?')
  })

  it("uses column-zero pass for non-Python cell magic bodies", () => {
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          {
            cell_type: "code",
            source: "%%bash\nfor i in 1 2; do\n  echo $i\ndone"
          }
        ]
      },
      { filePath: "/tmp/bash-magic.ipynb" }
    )
    const lines = sanitizeNotebookText(document).split("\n")
    expect(lines.every((line) => !line.startsWith(" "))).toBe(true)
    expect(lines.every((line) => line.trim() === "pass")).toBe(true)
  })

})

describe("pyright file-level errors", () => {
  it("keeps the batch when a diagnostic has no range", async () => {
    if (process.platform === "win32") return
    // The fake pyright is a python script; skip where no interpreter is usable.
    const pythonUsable = (() => {
      try {
        return Bun.spawnSync(["python", "-c", "print(1)"], {
          stdout: "pipe",
          stderr: "pipe"
        }).exitCode === 0
      } catch {
        return false
      }
    })()
    if (!pythonUsable) return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-diag-norange-"))
    const file = path.join(dir, "notebook.ipynb")
    const script = path.join(dir, "norange-pyright")
    // A real pyright exits 1 when it reports errors, and omits `range` for a
    // file-level report such as "Code is too complex to analyze".
    fs.writeFileSync(
      script,
      `#!/bin/sh
exec python -c 'import json,sys
target = sys.argv[2]
print(json.dumps({
  "version": "1.1.0",
  "generalDiagnostics": [
    {"file": target, "severity": "error", "message": "Code is too complex to analyze"},
    {"file": target, "severity": "error", "message": "real problem",
     "range": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 4}}}
  ],
  "summary": {"filesAnalyzed": 1, "errorCount": 2, "warningCount": 0}
}))' "$@"
exit 1
`,
      "utf8"
    )
    fs.chmodSync(script, 0o755)
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document,
        pyrightPath: script
      })
      expect(result.skipped).toBeUndefined()
      const messages = result.diagnostics.map((diagnostic) => diagnostic.message)
      expect(messages).toContain("Code is too complex to analyze")
      expect(messages).toContain("real problem")
      expect(
        result.diagnostics.some((diagnostic) => diagnostic.fileLevel === true)
      ).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
