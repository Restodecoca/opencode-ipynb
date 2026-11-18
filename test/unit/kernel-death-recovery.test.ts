import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeKernelManager } from "../../src/services/KernelManager.js"

const notebook = {
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: "print(1)"
    }
  ],
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python", file_extension: ".py" }
  },
  nbformat: 4,
  nbformat_minor: 5
}

describe("kernel death recovery", () => {
  it("drops a dead kernel state so the next request starts a fresh one", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-dead-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const flag = path.join(dir, "crashed.flag")
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...notebook,
        cells: [
          {
            ...notebook.cells[0]!,
            source: `import os, pathlib\nflag = pathlib.Path(${JSON.stringify(flag)})\nif not flag.exists():\n    flag.write_text('1')\n    os._exit(1)\nprint(1)`
          }
        ]
      })
    )
    const helper = path.resolve("python", "ipynb_runner.py")
    const manager = makeKernelManager({
      pythonPath: path.resolve(".venv", "bin", "python"),
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 30_000
    })
    const request = {
      filePath: file,
      mode: "all" as const,
      timeoutMs: 30_000,
      save: false,
      maxOutputChars: 2_000
    }
    try {
      const first = await Effect.runPromiseExit(manager.execute(file, request))
      expect(first._tag).toBe("Failure")
      expect(manager.isRunning(file)).toBe(false)
      const second = await Effect.runPromiseExit(manager.execute(file, request))
      expect(second._tag).toBe("Success")
      expect(manager.isRunning(file)).toBe(true)
    } finally {
      await Effect.runPromise(manager.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
