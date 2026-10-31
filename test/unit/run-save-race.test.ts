import { describe, expect, it } from "bun:test"
import { Cause, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import type { KernelManagerShape } from "../../src/services/KernelManager.js"
import type { PythonServiceShape } from "../../src/services/PythonService.js"
import type { ToolContext } from "../../src/tool.js"

const makeContext = (dir: string): ToolContext =>
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

const notebook = (source: string) => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python", file_extension: ".py" }
  },
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

describe("ipynb_run save race", () => {
  it("refuses to save outputs if the notebook changed during execution", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-save-race-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook("x = 1")))
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc = {
      probe: () =>
        Effect.succeed({
          pythonPath: "/usr/bin/python3",
          version: "3",
          executable: "python3",
          from: "options" as const
        }),
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    const kernel = {
      execute: () =>
        Effect.sync(() => {
          fs.writeFileSync(file, JSON.stringify(notebook("x = 2")))
          return {
            success: true,
            executedCells: [0],
            durationMs: 1,
            outputs: [
              {
                cellIndex: 0,
                status: "ok" as const,
                stdout: "ok\n",
                executionCount: 1
              }
            ]
          }
        })
    } as unknown as KernelManagerShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      kernelManager: kernel,
      warmKernel: true,
      defaultTimeoutMs: 30_000
    })
    try {
      const exit = await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      if (exit._tag !== "Failure") throw new Error("expected a failure")
      const failure = Cause.findErrorOption(exit.cause)
      expect(failure._tag).toBe("Some")
      if (failure._tag === "Some") {
        expect((failure.value as { _tag?: string })._tag).toBe(
          "NotebookValidation"
        )
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("reports saved:false when no code cell was written", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-save-noop-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ cell_type: "markdown", metadata: {}, source: "# title" }]
      })
    )
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc = {
      probe: () =>
        Effect.succeed({
          pythonPath: "/usr/bin/python3",
          version: "3",
          executable: "python3",
          from: "options" as const
        }),
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    const kernel = {
      execute: () =>
        Effect.succeed({
          success: true,
          executedCells: [],
          durationMs: 1,
          outputs: []
        })
    } as unknown as KernelManagerShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      kernelManager: kernel,
      warmKernel: true,
      defaultTimeoutMs: 30_000
    })
    try {
      const result = await Effect.runPromise(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(result.saved).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a FIFO instead of blocking before execution", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-save-fifo-"))
    const file = path.join(dir, "n.ipynb")
    const made = Bun.spawnSync(["mkfifo", file])
    if (made.exitCode !== 0) {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    }
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc = {
      probe: () => Effect.succeed({ pythonPath: "/usr/bin/python3", version: "3", executable: "python3", from: "options" as const }),
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      warmKernel: false,
      defaultTimeoutMs: 30_000
    })
    try {
      const started = Date.now()
      const exit = await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(exit._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("runs and saves through a symlink to a regular notebook", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-save-link-"))
    const real = path.join(dir, "real.ipynb")
    const link = path.join(dir, "link.ipynb")
    fs.writeFileSync(real, JSON.stringify(notebook("x = 1")))
    fs.symlinkSync(real, link)
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc = {
      probe: () => Effect.succeed({ pythonPath: "/usr/bin/python3", version: "3", executable: "python3", from: "options" as const }),
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    let payloadPath: string | undefined
    const kernel = {
      execute: (_path: string, request: { filePath: string }) => {
        payloadPath = request.filePath
        return Effect.succeed({
          success: true,
          executedCells: [0],
          durationMs: 1,
          outputs: [{ cellIndex: 0, status: "ok" as const, stdout: "ok\n", executionCount: 7 }]
        })
      }
    } as unknown as KernelManagerShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      kernelManager: kernel,
      warmKernel: true,
      defaultTimeoutMs: 30_000
    })
    try {
      const result = await Effect.runPromise(
        exec.execute(link, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(result.saved).toBe(true)
      expect(payloadPath).toBe(fs.realpathSync(real))
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
      const onDisk = JSON.parse(fs.readFileSync(real, "utf8")) as {
        cells: Array<{ execution_count: number | null; outputs: unknown[] }>
      }
      expect(onDisk.cells[0]?.execution_count).toBe(7)
      expect(onDisk.cells[0]?.outputs.length).toBe(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("caps the failure message by maxOutputChars", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-fail-cap-"))
    const file = path.join(dir, "n.ipynb")
    const fakePython = path.join(dir, "fake-python")
    fs.writeFileSync(file, JSON.stringify(notebook("raise ValueError('x')")))
    fs.writeFileSync(
      fakePython,
      `#!/bin/sh
cat <<'JSON'
{"success":false,"executedCells":[],"durationMs":1,"outputs":[],"error":{"kind":"CellExecutionError","cellIndex":0,"ename":"ValueError","evalue":"${"V".repeat(50_000)}","traceback":["${"T".repeat(50_000)}"]}}
JSON
`,
      "utf8"
    )
    fs.chmodSync(fakePython, 0o755)
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc = {
      probe: () => Effect.succeed({ pythonPath: fakePython, version: "3", executable: fakePython, from: "options" as const }),
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      warmKernel: false,
      defaultTimeoutMs: 30_000
    })
    try {
      const exit = await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 200
        })
      )
      if (exit._tag !== "Failure") throw new Error("expected failure")
      const failure = Cause.findErrorOption(exit.cause)
      if (failure._tag !== "Some") throw new Error("expected typed error")
      expect((failure.value as { message: string }).message.length).toBeLessThanOrEqual(200)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a >50 MB notebook even with save=false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-run-big-"))
    const file = path.join(dir, "big.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook("x = 1")))
    fs.truncateSync(file, 51 * 1024 * 1024)
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    let probes = 0
    const pythonSvc = {
      probe: () => {
        probes += 1
        return Effect.succeed({ pythonPath: "/usr/bin/python3", version: "3", executable: "python3", from: "options" as const })
      },
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      warmKernel: false,
      defaultTimeoutMs: 30_000
    })
    try {
      const exit = await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(probes).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("saves to the pinned target when the notebook symlink is swapped during the prompt", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-save-swap-"))
    const first = path.join(dir, "first.ipynb")
    const second = path.join(dir, "second.ipynb")
    const link = path.join(dir, "link.ipynb")
    fs.writeFileSync(first, JSON.stringify(notebook("x = 1")))
    fs.writeFileSync(second, JSON.stringify(notebook("y = 2")))
    fs.symlinkSync(first, link)
    const secondBefore = fs.readFileSync(second, "utf8")
    let asked = 0
    const context = {
      ...makeContext(dir),
      ask: async () => {
        asked += 1
        if (asked === 1) {
          fs.unlinkSync(link)
          fs.symlinkSync(second, link)
        }
      }
    } as unknown as ToolContext
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(context)
    const pythonSvc = {
      probe: () => Effect.succeed({ pythonPath: "/usr/bin/python3", version: "3", executable: "python3", from: "options" as const }),
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    const kernel = {
      execute: () =>
        Effect.succeed({
          success: true,
          executedCells: [0],
          durationMs: 1,
          outputs: [{ cellIndex: 0, status: "ok" as const, executionCount: 77 }]
        })
    } as unknown as KernelManagerShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      kernelManager: kernel,
      warmKernel: true,
      defaultTimeoutMs: 30_000
    })
    try {
      const result = await Effect.runPromise(
        exec.execute(link, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(result.saved).toBe(true)
      const firstOnDisk = JSON.parse(fs.readFileSync(first, "utf8")) as {
        cells: Array<{ execution_count: number | null }>
      }
      expect(firstOnDisk.cells[0]?.execution_count).toBe(77)
      expect(fs.readFileSync(second, "utf8")).toBe(secondBefore)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses to save when raw outputs were omitted by the size cap", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-raw-omitted-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook("x = 1")))
    const before = fs.readFileSync(file, "utf8")
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc = {
      probe: () => Effect.succeed({ pythonPath: "/usr/bin/python3", version: "3", executable: "python3", from: "options" as const }),
      findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
      checkDependencies: () => Effect.succeed([]),
      candidates: () => Effect.succeed([]),
      checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
      doctor: () => Effect.succeed({} as never)
    } as unknown as PythonServiceShape
    const kernel = {
      execute: () =>
        Effect.succeed({
          success: true,
          executedCells: [0],
          durationMs: 1,
          outputs: [
            {
              cellIndex: 0,
              status: "ok" as const,
              executionCount: 1,
              rawOutputsOmitted: true
            }
          ]
        })
    } as unknown as KernelManagerShape
    const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      kernelManager: kernel,
      warmKernel: true,
      defaultTimeoutMs: 30_000
    })
    try {
      const exit = await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(fs.readFileSync(file, "utf8")).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})
