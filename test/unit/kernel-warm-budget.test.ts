import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeKernelManager } from "../../src/services/KernelManager.js"

const helperSource = `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let buf = ""
out({ ready: true, pid: process.pid, kernelPid: process.pid })
process.stdin.setEncoding("utf8")
process.stdin.on("data", async (c) => {
  buf += c
  let i
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const req = JSON.parse(line)
    if (req.mode === "shutdown") process.exit(0)
    const cells = req.mode === "all" ? 3 : 1
    for (let k = 0; k < cells; k += 1) await sleep(400)
    out({ id: req.id, success: true, executedCells: [0], durationMs: 1, outputs: [] })
  }
})
`

describe("warm kernel request budget", () => {
  it("counts the timeout per cell, not across the whole batch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warm-budget-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, "{}")
    const helper = path.join(dir, "helper.mjs")
    fs.writeFileSync(helper, helperSource)
    const manager = makeKernelManager({
      pythonPath: process.execPath,
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 60_000
    })
    const started = Date.now()
    try {
      const run = await Effect.runPromise(
        manager.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 700,
          save: false,
          maxOutputChars: 2_000
        })
      )
      const elapsed = Date.now() - started
      expect(run.success).toBe(true)
      expect(elapsed).toBeLessThan(5_000)
      expect(manager.isRunning(file)).toBe(true)
    } finally {
      await Effect.runPromise(manager.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
