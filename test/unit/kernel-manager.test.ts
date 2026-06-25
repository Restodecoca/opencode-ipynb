import { describe, expect, it, afterEach } from "bun:test"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { Effect } from "effect"
import { makeKernelManager } from "../../src/services/PythonService.js"
import { pythonHas } from "../helpers.js"

const HELPER = path.resolve("python", "ipynb_runner.py")
const FIXTURES = path.resolve("test", "fixtures")
const SKIP = !pythonHas("nbclient")
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

  it("restart kills the old PID and starts a new one", async () => {
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
})

describeIf(SKIP, "KernelManager (skipped)", () => {
  it("skipped because nbclient is not installed", () => {
    expect(true).toBe(true)
  })
})
