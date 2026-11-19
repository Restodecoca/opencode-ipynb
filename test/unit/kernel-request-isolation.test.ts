import { expect, it } from "bun:test"
import { describeIf, realHelperEnabled } from "../helpers.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeKernelManager } from "../../src/services/KernelManager.js"

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

describeIf(realHelperEnabled(), "kernel request isolation", () => {
  it("does not kill the kernel while another request is still pending", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-isolation-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(JSON.parse(notebook("import time\ntime.sleep(2)\nprint(1)"))))
    const manager = makeKernelManager({
      pythonPath: "python",
      helperPath: path.resolve("python", "ipynb_runner.py"),
      workingDirectory: dir,
      defaultTimeoutMs: 60_000
    })
    const request = (timeoutMs: number) => ({
      filePath: file,
      mode: "all" as const,
      timeoutMs,
      save: false,
      maxOutputChars: 2_000
    })
    const controller = new AbortController()
    try {
      const slow = Effect.runPromise(manager.execute(file, request(60_000)))
      await new Promise((resolve) => setTimeout(resolve, 300))
      const cancelled = Effect.runPromiseExit(
        manager.execute(file, request(60_000), undefined, {
          signal: controller.signal
        })
      )
      controller.abort()
      const cancelledExit = await cancelled
      expect(cancelledExit._tag).toBe("Failure")
      const survivor = await slow
      expect(survivor.success).toBe(true)
      expect(manager.isRunning(file)).toBe(true)
    } finally {
      await Effect.runPromise(manager.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
