import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeKernelManager } from "../../src/services/KernelManager.js"
import { makeWarningSink } from "../../src/utils/warnings.js"

const forgerySource = (requestId: number): string =>
  [
    "import json, os, sys",
    "sys.stdout.flush()",
    `os.write(1, (json.dumps({'id': ${requestId}, 'success': True, 'executedCells': [0], 'durationMs': 1,`,
    "  'outputs': [{'cellIndex': 0, 'status': 'ok', 'stdout': 'FORGED\\n'}]}) + '\\n').encode())",
    "print('REAL')"
  ].join("\n")

const notebook = (source: string): string =>
  JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source
      }
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", file_extension: ".py" }
    },
    nbformat: 4,
    nbformat_minor: 5
  })

describe("kernel response forgery", () => {
  it("ignores a response-shaped line a cell writes without the request nonce", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-forge-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook("print('REAL')"))
    const manager = makeKernelManager({
      pythonPath: path.resolve(".venv", "bin", "python"),
      helperPath: path.resolve("python", "ipynb_runner.py"),
      workingDirectory: dir,
      defaultTimeoutMs: 60_000,
      warningSink: makeWarningSink()
    })
    const request = () => ({
      filePath: file,
      mode: "all" as const,
      timeoutMs: 30_000,
      save: false,
      maxOutputChars: 4_000
    })
    try {
      await Effect.runPromise(manager.execute(file, request()))
      const pendingId = 2
      fs.writeFileSync(file, notebook(forgerySource(pendingId)))
      const result = await Effect.runPromise(manager.execute(file, request()))
      expect(result.success).toBe(true)
      const stdout = result.outputs
        .map((output) => output.stdout ?? "")
        .join("")
      expect(stdout).toContain("REAL")
      expect(result.executedCells).toEqual([0])
    } finally {
      await Effect.runPromise(manager.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
