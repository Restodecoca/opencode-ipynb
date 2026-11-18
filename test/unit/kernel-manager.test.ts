import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { Effect } from "effect"
import { makeKernelManager, killPidTree } from "../../src/services/KernelManager.js"
import { pythonHas } from "../helpers.js"

const HELPER = path.resolve("python", "ipynb_runner.py")
const FIXTURES = path.resolve("test", "fixtures")
const SKIP = !pythonHas("nbclient")

describe("killPidTree failure reporting", () => {
  it("reports when the group kill fails and the direct kill is refused", () => {
    if (process.platform === "win32") return
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    const failures: unknown[] = []
    killPidTree(2, "SIGTERM", (error) => failures.push(error))
    expect(failures.length).toBe(1)
    expect((failures[0] as NodeJS.ErrnoException).code).toBe("EPERM")
  })

  it("stays silent when the process is already gone", () => {
    if (process.platform === "win32") return
    const failures: unknown[] = []
    killPidTree(10_000_000, "SIGTERM", (error) => failures.push(error))
    killPidTree(10_000_001, "SIGKILL", (error) => failures.push(error))
    expect(failures.length).toBe(0)
  })
})

const describeIf = (cond: boolean, name: string, fn: () => void): void => {
  if (cond) describe(name, fn)
  else describe.skip(name, fn)
}

const makeManager = (workingDir = process.cwd()) =>
  makeKernelManager({
    pythonPath: "python",
    helperPath: HELPER,
    workingDirectory: workingDir,
    defaultTimeoutMs: 60_000
  })

const copyFixture = (name: string): { dir: string; file: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-"))
  const file = path.join(dir, name)
  fs.copyFileSync(path.join(FIXTURES, name), file)
  return { dir, file }
}

const cleanup = (dir: string): void => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describeIf(!SKIP, "KernelManager", () => {
  it("starts a kernel on first execute and reuses it on the second", async () => {
    const { dir, file } = copyFixture("simple.ipynb")
    const mgr = makeManager(dir)
    try {
      const r1 = await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(r1.success).toBe(true)
      const after1 = mgr.list()
      expect(after1.length).toBe(1)
      const pid1 = after1[0]?.pid ?? -1
      expect(pid1).toBeGreaterThan(0)
      expect(mgr.isRunning(file)).toBe(true)

      const r2 = await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(r2.success).toBe(true)
      const after2 = mgr.list()
      expect(after2.length).toBe(1)
      const pid2 = after2[0]?.pid ?? -1
      expect(pid2).toBe(pid1)
      const requests = after2[0]?.requestsHandled ?? 0
      expect(requests).toBeGreaterThanOrEqual(2)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 120_000)

  it("restart stops the old kernel; the next execute starts a new one", async () => {
    const { dir, file } = copyFixture("simple.ipynb")
    const mgr = makeManager(dir)
    try {
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      const pid1 = mgr.list()[0]?.pid ?? -1
      expect(pid1).toBeGreaterThan(0)
      expect(mgr.isRunning(file)).toBe(true)

      await Effect.runPromise(mgr.restart(file))
      expect(mgr.isRunning(file)).toBe(false)

      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      const pid2 = mgr.list()[0]?.pid ?? -1
      expect(pid2).toBeGreaterThan(0)
      expect(pid2).not.toBe(pid1)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 120_000)

  it("shutdown kills the PID and removes the state", async () => {
    const { dir, file } = copyFixture("simple.ipynb")
    const mgr = makeManager(dir)
    try {
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(mgr.isRunning(file)).toBe(true)
      const pid = mgr.list()[0]?.pid ?? -1

      await Effect.runPromise(mgr.shutdown(file))
      expect(mgr.isRunning(file)).toBe(false)
      expect(mgr.list().length).toBe(0)
      // Process is no longer running.
      let stillRunning = true
      try {
        process.kill(pid, 0)
      } catch {
        stillRunning = false
      }
      expect(stillRunning).toBe(false)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 60_000)

  it("disposeAll kills every live kernel", async () => {
    const { dir: dir1, file: file1 } = copyFixture("simple.ipynb")
    const { dir: dir2, file: file2 } = copyFixture("outputs.ipynb")
    const mgr = makeManager(process.cwd())
    try {
      await Effect.runPromise(
        mgr.execute(file1, {
          filePath: file1,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      await Effect.runPromise(
        mgr.execute(file2, {
          filePath: file2,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(mgr.list().length).toBe(2)
      const pids = mgr.list().map((k) => k.pid)
      expect(pids.length).toBe(2)
      expect(pids.every((p) => p > 0)).toBe(true)

      await Effect.runPromise(mgr.disposeAll())
      expect(mgr.list().length).toBe(0)
      for (const pid of pids) {
        let stillRunning = true
        try {
          process.kill(pid, 0)
        } catch {
          stillRunning = false
        }
        expect(stillRunning).toBe(false)
      }
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir1)
      cleanup(dir2)
    }
  }, 120_000)

  it("two different filePaths get different kernels", async () => {
    const { dir: dir1, file: file1 } = copyFixture("simple.ipynb")
    const { dir: dir2, file: file2 } = copyFixture("outputs.ipynb")
    const mgr = makeManager(process.cwd())
    try {
      await Effect.runPromise(
        mgr.execute(file1, {
          filePath: file1,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      await Effect.runPromise(
        mgr.execute(file2, {
          filePath: file2,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      const list = mgr.list()
      expect(list.length).toBe(2)
      const pids = new Set(list.map((k) => k.pid))
      expect(pids.size).toBe(2)
      const paths = new Set(list.map((k) => k.filePath))
      expect(paths.has(file1)).toBe(true)
      expect(paths.has(file2)).toBe(true)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir1)
      cleanup(dir2)
    }
  }, 120_000)
  it("restarts when the requested kernel name changes", async () => {
    const { dir, file } = copyFixture("simple.ipynb")
    const mgr = makeManager(dir)
    try {
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      const pid1 = mgr.list()[0]?.pid
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          kernel: "python3",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(mgr.list()[0]?.pid).not.toBe(pid1)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 120_000)

  it("aborts a warm kernel that is still starting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-abort-"))
    const file = path.join(dir, "slow.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const helper = path.join(dir, "slow_helper.py")
    fs.writeFileSync(
      helper,
      "import time\ntime.sleep(3)\nprint('{\"ready\":true}')\n",
      "utf8"
    )
    const mgr = makeKernelManager({
      pythonPath: "python",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 60_000
    })
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)
    try {
      const exit = await Effect.runPromiseExit(
        mgr.execute(
          file,
          {
            filePath: file,
            mode: "all",
            timeoutMs: 60_000,
            save: false,
            maxOutputChars: 4_000
          },
          undefined,
          { signal: controller.signal }
        )
      )
      expect(exit._tag).toBe("Failure")
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 30_000)

  it("kills processes started by a timed-out cell", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-children-"))
    const file = path.join(dir, "children.ipynb")
    const pidFile = path.join(dir, "child.pid")
    const writeNotebook = (source: string): void => {
      fs.writeFileSync(
        file,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
          cells: [
            {
              cell_type: "code",
              execution_count: null,
              metadata: {},
              outputs: [],
              source
            }
          ]
        })
      )
    }
    writeNotebook('print("warm")')
    const mgr = makeManager(dir)
    try {
      // Start the kernel with a generous timeout so CI startup jitter does
      // not consume the short cell timeout used below.
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "cell",
          cellIndex: 0,
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      writeNotebook(
        `import subprocess, time\np = subprocess.Popen(["sleep", "300"])\nopen(${JSON.stringify(pidFile)}, "w").write(str(p.pid))\ntime.sleep(30)`
      )
      let failed = false
      try {
        await Effect.runPromise(
          mgr.execute(file, {
            filePath: file,
            mode: "cell",
            cellIndex: 0,
            timeoutMs: 1_000,
            save: false,
            maxOutputChars: 4_000
          })
        )
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
      const deadline = Date.now() + 6_000
      let pid = 0
      while (Date.now() < deadline) {
        if (fs.existsSync(pidFile)) {
          pid = Number(fs.readFileSync(pidFile, "utf8"))
          if (pid > 0) break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(pid).toBeGreaterThan(0)
      let alive = true
      while (Date.now() < deadline && alive) {
        try {
          process.kill(pid, 0)
          await new Promise((resolve) => setTimeout(resolve, 100))
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 30_000)


  it("uses one kernel for symlink aliases of the same notebook", async () => {
    if (process.platform === "win32") return
    const { dir, file } = copyFixture("simple.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    fs.symlinkSync(file, alias)
    const mgr = makeManager(dir)
    try {
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      await Effect.runPromise(
        mgr.execute(alias, {
          filePath: alias,
          mode: "all",
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(mgr.list()).toHaveLength(1)
      expect(mgr.isRunning(alias)).toBe(true)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 120_000)
  it("serializes concurrent kernel switches without overwriting live state", async () => {
    const { dir, file } = copyFixture("simple.ipynb")
    const mgr = makeManager(dir)
    const run = (kernel: string | undefined) =>
      Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          kernel,
          timeoutMs: 60_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
    try {
      await run(undefined)
      const results = await Promise.allSettled([run("python3"), run(undefined)])
      // Switching the kernel is disruptive: one in-flight request may be
      // rejected, but the manager must keep exactly one tracked kernel and
      // must not leak the replaced helper process.
      expect(results.some((result) => result.status === "fulfilled")).toBe(true)
      expect(mgr.list()).toHaveLength(1)
      expect(mgr.stats().liveKernels).toBe(1)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 120_000)

  it("preserves UTF-8 split across stdout chunks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-utf8-"))
    const file = path.join(dir, "n.ipynb")
    const helper = path.join(dir, "fake_helper.py")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    fs.writeFileSync(
      helper,
      `import json, os, sys, time
sys.stdin.readline()
print(json.dumps({"ready": True, "pid": os.getpid(), "kernelPid": 424242}), flush=True)
req = json.loads(sys.stdin.readline())
payload = json.dumps({"id": req["id"], "success": True, "executedCells": [], "durationMs": 1, "outputs": [{"cellIndex": 0, "status": "ok", "stdout": "\u00e9"}]}, ensure_ascii=False).encode()
marker = "\u00e9".encode()
idx = payload.find(marker)
sys.stdout.buffer.write(payload[:idx + 1])
sys.stdout.buffer.flush()
time.sleep(0.05)
sys.stdout.buffer.write(payload[idx + 1:] + bytes([10]))
sys.stdout.buffer.flush()
`,
      "utf8"
    )
    const mgr = makeKernelManager({
      pythonPath: "python",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000
    })
    try {
      const response = await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "cell",
          cellIndex: 0,
          timeoutMs: 10_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(response.outputs[0]?.stdout).toBe("é")
      expect(response.outputs[0]?.stdout?.includes("\uFFFD")).toBe(false)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      cleanup(dir)
    }
  }, 30_000)

})
