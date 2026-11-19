import { expect, it } from "bun:test"
import { describeIf, realHelperEnabled } from "../helpers.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const helper = path.resolve("python", "ipynb_runner.py")
const python = "python"

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

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describeIf(realHelperEnabled(), "queued shutdown preempts a running cell", () => {
  it("returns promptly and reaps the kernel instead of waiting for the cell", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-shutdown-preempt-"))
    const file = path.join(dir, "n.ipynb")
    // A cell far longer than the test budget: without preemption this test
    // would have to wait for it.
    fs.writeFileSync(file, notebook("import time\ntime.sleep(120)\nprint(1)"))
    const child = Bun.spawn([python, helper], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    })
    const writer = child.stdin as import("bun").FileSink
    const send = (value: unknown): void => {
      writer.write(`${JSON.stringify(value)}\n`)
      writer.flush()
    }
    try {
      send({ mode: "serve", filePath: file, timeoutMs: 300_000 })
      const ready = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no ready line")), 30_000)
        let buffer = ""
        const decoder = new TextDecoder()
        const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
        const pump = async (): Promise<void> => {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            buffer += decoder.decode(value, { stream: true })
            const line = buffer.split("\n").find((candidate) => candidate.includes('"ready"'))
            if (line !== undefined) {
              clearTimeout(timer)
              resolve(line)
              return
            }
          }
        }
        void pump()
      })
      expect(ready).toContain('"ready"')
      send({ id: 1, mode: "cell", cellIndex: 0, timeoutMs: 300_000 })
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const started = Date.now()
      send({ mode: "shutdown" })
      const exitCode = await Promise.race([
        child.exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25_000))
      ])
      const elapsed = Date.now() - started
      expect(exitCode).not.toBe("timeout")
      expect(elapsed).toBeLessThan(25_000)
      expect(child.pid).toBeDefined()
      expect(alive(child.pid)).toBe(false)
    } finally {
      try {
        child.kill("SIGKILL")
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
