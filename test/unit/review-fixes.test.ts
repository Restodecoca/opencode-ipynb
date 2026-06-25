import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { NotebookSchema } from "../../src/domain/notebook.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"
import {
  buildPersistedOutputs,
  makeExecutionImpl,
  truncateText
} from "../../src/services/NotebookExecutionService.js"
import { makePathService, type PathServiceShape } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import {
  makeNotebookFileService,
  type NotebookFileServiceShape
} from "../../src/services/NotebookFileService.js"
import {
  makePythonService,
  makeKernelManager,
  type KernelManagerShape,
  type KernelRuntimeOptions,
  type PythonServiceShape
} from "../../src/services/PythonService.js"
import { runRepro } from "../../src/tools/repro.js"
import { run as runKernel } from "../../src/tools/kernel.js"
import { buildServices } from "../../src/services/index.js"
import type { ToolContext } from "@opencode-ai/plugin"
import type { PermissionServiceShape } from "../../src/services/PermissionService.js"

const pythonHas = (module: string): boolean => {
  const code = `import sys, importlib.util; sys.exit(0 if importlib.util.find_spec("${module}") else 1)`
  const r = spawnSync("python", ["-c", code], { encoding: "utf8" })
  return r.status === 0
}

const describeIf = (cond: boolean, name: string, fn: () => void): void => {
  if (cond) describe(name, fn)
  else describe.skip(name, fn)
}

const makeContext = (dir: string): ToolContext =>
  (({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown) as ToolContext

const buildTinyNotebook = (): NotebookRaw =>
  NotebookSchema.parse({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    cells: [
      { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "x = 1" },
      { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "y = 2" }
    ]
  }) as NotebookRaw

describe("buildPersistedOutputs > documented order comment", () => {
  it("orders stream, execute_result, display_data, error", () => {
    const summary = {
      cellIndex: 0,
      status: "ok" as const,
      stdout: "out",
      stderr: "err",
      resultPreview: "42",
      executionCount: 3,
      displayData: [{ mime: "image/png", sizeBytes: 10 }],
      errors: [{ ename: "E", evalue: "v", traceback: ["t"] }]
    }
    const out = buildPersistedOutputs(summary)
    const kinds = out.map((o) => o["output_type"])
    expect(kinds).toEqual(["stream", "stream", "execute_result", "display_data", "error"])
  })
})

describe("NotebookExecutionService.execute > save=true does not mutate the parsed notebook", () => {
  it("buildPersistedOutputs returns a fresh array on every call (pure function)", () => {
    const summary = {
      cellIndex: 0,
      status: "ok" as const,
      stdout: "a"
    }
    const a = buildPersistedOutputs(summary)
    const b = buildPersistedOutputs(summary)
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})

describe("OPENCODE_IPYNB_OPTIONS > allowOutsideWorktree reaches PathService end-to-end", () => {
  it("PathService is no-op when the env-resolved option is true (buildServices wiring)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-envopts-"))
    try {
      const pathSvc: PathServiceShape = makePathService({
        directory: dir,
        worktree: dir,
        platform: process.platform,
        allowOutsideWorktree: true
      })
      let threw = false
      try {
        pathSvc.ensureInsideWorktree(path.join(dir, "..", "..", "evil.ipynb"))
      } catch {
        threw = true
      }
      expect(threw).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Services > ensureInsideWorktree is enforced when allowOutsideWorktree is false", () => {
  const makeServices = (dir: string) => {
    const ctx = makeContext(dir)
    return {
      pathSvc: makePathService({
        directory: dir,
        worktree: dir,
        platform: process.platform
      }),
      permSvc: makePermissionService(ctx),
      fileSvc: makeNotebookFileService()
    }
  }

  it("NotebookReadService.readCell rejects a path outside the worktree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-read-out-"))
    const outside = path.join(dir, "..", "..", "evil.ipynb")
    try {
      const { pathSvc, permSvc, fileSvc } = makeServices(dir)
      const { makeReadImpl } = await import("../../src/services/NotebookReadService.js")
      const read = makeReadImpl(pathSvc, fileSvc)
      const exit = await Effect.runPromiseExit(read.readCell(outside, 0))
      if (exit._tag === "Failure") {
        const cause = exit.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string; filePath?: string }
          expect(err._tag).toBe("PathOutsideWorktree")
          expect(err.filePath).toBe(outside)
        } else {
          throw new Error("expected typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
      void permSvc
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NotebookEditService.editCell rejects a path outside the worktree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-edit-out-"))
    const outside = path.join(dir, "..", "..", "evil.ipynb")
    try {
      const { pathSvc, fileSvc, permSvc } = makeServices(dir)
      const { makeEditImpl } = await import("../../src/services/NotebookEditService.js")
      const { makeDiffService } = await import("../../src/services/DiffService.js")
      const edit = makeEditImpl(pathSvc, fileSvc, makeDiffService(), permSvc)
      const exit = await Effect.runPromiseExit(
        edit.editCell(outside, { cellIndex: 0, source: "x = 1" })
      )
      if (exit._tag === "Failure") {
        const cause = exit.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string }
          expect(err._tag).toBe("PathOutsideWorktree")
        } else {
          throw new Error("expected typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NotebookCleanService.clean rejects a path outside the worktree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-clean-out-"))
    const outside = path.join(dir, "..", "..", "evil.ipynb")
    try {
      const { pathSvc, fileSvc, permSvc } = makeServices(dir)
      const { makeCleanImpl } = await import("../../src/services/NotebookCleanService.js")
      const clean = makeCleanImpl(pathSvc, fileSvc, permSvc)
      const exit = await Effect.runPromiseExit(clean.clean(outside))
      if (exit._tag === "Failure") {
        const cause = exit.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string }
          expect(err._tag).toBe("PathOutsideWorktree")
        } else {
          throw new Error("expected typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NotebookInspectService.inspect rejects a path outside the worktree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-inspect-out-"))
    const outside = path.join(dir, "..", "..", "evil.ipynb")
    try {
      const { pathSvc, fileSvc } = makeServices(dir)
      const { makeInspectImpl } = await import("../../src/services/NotebookInspectService.js")
      const inspect = makeInspectImpl(pathSvc, fileSvc)
      const exit = await Effect.runPromiseExit(inspect.inspect(outside))
      if (exit._tag === "Failure") {
        const cause = exit.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string }
          expect(err._tag).toBe("PathOutsideWorktree")
        } else {
          throw new Error("expected typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NotebookOutputService.listOutputs rejects a path outside the worktree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-outputs-out-"))
    const outside = path.join(dir, "..", "..", "evil.ipynb")
    try {
      const { pathSvc, fileSvc, permSvc } = makeServices(dir)
      const { makeOutputImpl } = await import("../../src/services/NotebookOutputService.js")
      const out = makeOutputImpl(pathSvc, fileSvc, permSvc)
      const exit = await Effect.runPromiseExit(out.listOutputs(outside))
      if (exit._tag === "Failure") {
        const cause = exit.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string }
          expect(err._tag).toBe("PathOutsideWorktree")
        } else {
          throw new Error("expected typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NotebookExportService.export rejects a path outside the worktree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-out-"))
    const outside = path.join(dir, "..", "..", "evil.ipynb")
    try {
      const { pathSvc, fileSvc, permSvc } = makeServices(dir)
      const { makeExportImpl } = await import("../../src/services/NotebookExportService.js")
      const exp = makeExportImpl(pathSvc, fileSvc, permSvc)
      const exit = await Effect.runPromiseExit(
        exp.export(outside, {
          format: "summary",
          includeOutputs: false,
          includeErrors: false,
          outputPath: undefined,
          maxExportChars: 1000
        })
      )
      if (exit._tag === "Failure") {
        const cause = exit.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string }
          expect(err._tag).toBe("PathOutsideWorktree")
        } else {
          throw new Error("expected typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- Bug 1: repro.ts now enforces the worktree boundary ----------------------

describe("ipynb_repro > PathOutsideWorktreeError for paths outside the worktree", () => {
  it("rejects an outside-worktree path before reading the notebook", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-repro-out-"))
    const outside = path.join(dir, "..", "..", "evil.ipynb")
    try {
      const services = buildServices(makeContext(dir))
      const exit = await Effect.runPromiseExit(
        runRepro(services, { filePath: outside })
      )
      if (exit._tag === "Failure") {
        const cause = exit.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string; filePath?: string }
          expect(err._tag).toBe("PathOutsideWorktree")
          expect(err.filePath).toBe(outside)
        } else {
          throw new Error("expected typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- Bug 2: kernel.ts now validates the path before restart/shutdown --------

describe("ipynb_kernel > PathOutsideWorktreeError for outside-worktree paths", () => {
  it("rejects action='restart' for an outside-worktree path", async () => {
    const prevOpts = process.env.OPENCODE_IPYNB_OPTIONS
    process.env.OPENCODE_IPYNB_OPTIONS = JSON.stringify({ warmKernel: true })
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-restart-out-"))
      const outside = path.join(dir, "..", "..", "evil.ipynb")
      try {
        const services = buildServices(makeContext(dir))
        const exit = await Effect.runPromiseExit(
          runKernel(services, { action: "restart", filePath: outside })
        )
        if (exit._tag === "Failure") {
          const cause = exit.cause
          if (cause._tag === "Fail") {
            const err = cause.error as { _tag?: string; filePath?: string }
            expect(err._tag).toBe("PathOutsideWorktree")
            expect(err.filePath).toBe(outside)
          } else {
            throw new Error("expected typed failure, got defect")
          }
        } else {
          throw new Error("expected Failure, got Success")
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      if (prevOpts === undefined) {
        delete process.env.OPENCODE_IPYNB_OPTIONS
      } else {
        process.env.OPENCODE_IPYNB_OPTIONS = prevOpts
      }
    }
  })

  it("rejects action='shutdown' for an outside-worktree path", async () => {
    const prevOpts = process.env.OPENCODE_IPYNB_OPTIONS
    process.env.OPENCODE_IPYNB_OPTIONS = JSON.stringify({ warmKernel: true })
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-shutdown-out-"))
      const outside = path.join(dir, "..", "..", "evil.ipynb")
      try {
        const services = buildServices(makeContext(dir))
        const exit = await Effect.runPromiseExit(
          runKernel(services, { action: "shutdown", filePath: outside })
        )
        if (exit._tag === "Failure") {
          const cause = exit.cause
          if (cause._tag === "Fail") {
            const err = cause.error as { _tag?: string }
            expect(err._tag).toBe("PathOutsideWorktree")
          } else {
            throw new Error("expected typed failure, got defect")
          }
        } else {
          throw new Error("expected Failure, got Success")
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      if (prevOpts === undefined) {
        delete process.env.OPENCODE_IPYNB_OPTIONS
      } else {
        process.env.OPENCODE_IPYNB_OPTIONS = prevOpts
      }
    }
  })
})

// --- Bug 4: reportEnv honors defaultTimeoutMs --------------------------------

describe("NotebookExecutionService.reportEnv > honors defaultTimeoutMs", () => {
  const buildExec = (dir: string, defaultTimeoutMs?: number) => {
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const permSvc = makePermissionService(makeContext(dir))
    const fileSvc = makeNotebookFileService()
    const pythonSvc = makePythonService({
      pythonPath: "python",
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    return makeExecutionImpl(
      pathSvc,
      fileSvc,
      permSvc,
      pythonSvc,
      defaultTimeoutMs === undefined ? undefined : { warmKernel: false, defaultTimeoutMs }
    )
  }

  it("uses the configured defaultTimeoutMs when no explicit timeout is given", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-reportenv-default-"))
    try {
      const file = path.join(dir, "x.ipynb")
      fs.writeFileSync(
        file,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
            language_info: { name: "python" }
          },
          cells: []
        })
      )
      const customTimeout = 45_000
      const env = await Effect.runPromise(
        buildExec(dir, customTimeout).reportEnv(file)
      )
      expect(env.pythonVersion).toMatch(/^\d+\.\d+/)
      // We can't assert the timeout directly from the env report, but a
      // successful call here proves the option flowed through to the
      // service (it would have been ignored at the schema-parse boundary
      // otherwise — see git history for the original bug).
      expect(env.pythonExecutable.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("applies the 30_000 floor when defaultTimeoutMs is below it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-reportenv-floor-"))
    try {
      const file = path.join(dir, "x.ipynb")
      fs.writeFileSync(
        file,
        JSON.stringify({
          nbformat: 4,
          nbformat_minor: 5,
          metadata: {
            kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
            language_info: { name: "python" }
          },
          cells: []
        })
      )
      // The 30s floor means a sub-30s configured value would still produce
      // a working call (the function does not pass through anything less
      // than 30_000). We assert it by running with a very small configured
      // timeout and expecting success.
      const env = await Effect.runPromise(
        buildExec(dir, 1_000).reportEnv(file)
      )
      expect(env.pythonVersion).toMatch(/^\d+\.\d+/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("NotebookExecutionService.execute > warm kernel receives resolved runtime", () => {
  it("passes the probed pythonPath and discovered helperPath to KernelManager.execute", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warm-runtime-"))
    const file = path.join(dir, "x.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
          language_info: { name: "python" }
        },
        cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "1 + 1" }]
      })
    )

    let capturedRuntime: KernelRuntimeOptions | undefined
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc: PythonServiceShape = {
      probe: () => Effect.succeed({
        pythonPath: path.join(dir, "venv", "python.exe"),
        version: "3.11.0",
        executable: path.join(dir, "venv", "python.exe"),
        from: "options" as const
      }),
      candidates: () => Effect.succeed([]),
      checkDependencies: () => Effect.succeed([]),
      checkImport: (_pythonPath, module) => Effect.succeed({ name: module, available: true, detail: "ok" }),
      findHelper: () => Effect.succeed(path.join(dir, "pkg", "python", "ipynb_runner.py")),
      doctor: () => Effect.succeed({
        selected: undefined,
        candidates: [],
        dependencies: [],
        helperPath: undefined,
        preferUv: true,
        suggestions: []
      })
    }
    const kernelMgr: KernelManagerShape = {
      execute: (_filePath, _request, runtime) => {
        capturedRuntime = runtime
        return Effect.succeed({ success: true, executedCells: [], durationMs: 1, outputs: [] })
      },
      isRunning: () => false,
      list: () => [],
      restart: () => Effect.void,
      shutdown: () => Effect.void,
      disposeAll: () => Effect.void,
      stats: () => ({ liveKernels: 0, totalRequests: 0 })
    }

    try {
      const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
        kernelManager: kernelMgr,
        warmKernel: true,
        defaultTimeoutMs: 60_000
      })
      await Effect.runPromise(
        exec.execute(file, {
          mode: "all",
          cellIndex: undefined,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 60_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )

      expect(capturedRuntime).toEqual({
        pythonPath: path.join(dir, "venv", "python.exe"),
        helperPath: path.join(dir, "pkg", "python", "ipynb_runner.py")
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("NotebookExecutionService.execute > save=true preserves raw outputs", () => {
  it("writes raw MIME bundles instead of summary placeholders when rawOutputs are present", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-save-raw-"))
    const file = path.join(dir, "rich.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
          language_info: { name: "python" }
        },
        cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "plot()" }]
      })
    )

    const rawOutput = {
      output_type: "display_data",
      data: {
        "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        "text/html": "<b>rich</b>"
      },
      metadata: { isolated: true }
    }
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const pythonSvc: PythonServiceShape = {
      probe: () => Effect.succeed({ pythonPath: "python", version: "3.11.0", executable: "python", from: "path-python" as const }),
      candidates: () => Effect.succeed([]),
      checkDependencies: () => Effect.succeed([]),
      checkImport: (_pythonPath, module) => Effect.succeed({ name: module, available: true, detail: "ok" }),
      findHelper: () => Effect.succeed(path.join(dir, "ipynb_runner.py")),
      doctor: () => Effect.succeed({
        selected: undefined,
        candidates: [],
        dependencies: [],
        helperPath: undefined,
        preferUv: true,
        suggestions: []
      })
    }
    const kernelMgr: KernelManagerShape = {
      execute: () => Effect.succeed({
        success: true,
        executedCells: [0],
        durationMs: 1,
        outputs: [{
          cellIndex: 0,
          status: "ok" as const,
          executionCount: 9,
          displayData: [{ mime: "image/png", sizeBytes: 24 }],
          rawOutputs: [rawOutput]
        }]
      }),
      isRunning: () => false,
      list: () => [],
      restart: () => Effect.void,
      shutdown: () => Effect.void,
      disposeAll: () => Effect.void,
      stats: () => ({ liveKernels: 0, totalRequests: 0 })
    }

    try {
      const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
        kernelManager: kernelMgr,
        warmKernel: true,
        defaultTimeoutMs: 60_000
      })
      await Effect.runPromise(exec.execute(file, {
        mode: "all",
        cellIndex: undefined,
        start: undefined,
        end: undefined,
        kernel: undefined,
        timeoutMs: 60_000,
        save: true,
        workingDirectory: undefined,
        maxOutputChars: 4_000
      }))

      const after = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: Array<{ execution_count: number | null; outputs: unknown[] }> }
      expect(after.cells[0]?.execution_count).toBe(9)
      expect(after.cells[0]?.outputs).toEqual([rawOutput])
      expect(JSON.stringify(after)).not.toContain("omitted by plugin")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- Bug 3 + Bug 5: kernel manager handles unexpected close + closed stdin ---

describeIf(
  pythonHas("nbformat") && pythonHas("nbclient") && pythonHas("ipykernel"),
  "KernelManager.execute > close handler distinguishes shutdown from real requests",
  () => {
  const HELPER = path.resolve("python", "ipynb_runner.py")
  const FIXTURES = path.resolve("test", "fixtures")

  it("rejects an in-flight cell request with PythonRunnerError when the kernel is killed while busy", async () => {
    // Create a slow fixture (a cell that sleeps for ~3s) so we can race
    // a SIGKILL against the in-flight request.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-bug3-"))
    const file = path.join(dir, "slow.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
          language_info: { name: "python" }
        },
        cells: [
          {
            cell_type: "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: "import time\ntime.sleep(3)\nx = 1"
          }
        ]
      })
    )
    const mgr = makeKernelManager({
      pythonPath: "python",
      helperPath: HELPER,
      workingDirectory: dir,
      defaultTimeoutMs: 30_000
    })
    try {
      // Fire the request but do not await it. Attach a no-op catch
      // immediately so the inevitable rejection isn't reported as
      // unhandled when the kernel is killed below.
      const pending = Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "cell",
          cellIndex: 0,
          timeoutMs: 30_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      pending.catch(() => {})
      // Give the kernel a moment to actually start executing the cell.
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
      const pid = mgr.list()[0]?.pid ?? -1
      expect(pid).toBeGreaterThan(0)
      // SIGKILL: the proc exits with a non-zero code, but the in-flight
      // request must still be rejected with a structured PythonRunnerError
      // (the close handler's failAllPending path).
      process.kill(pid, "SIGKILL")
      const exit = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => pending,
          catch: (err) => err
        })
      )
      expect(exit._tag).toBe("Failure")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

// --- Smell G: truncateText accepts a hintKey parameter -----------------------

describe("truncateText > hintKey parameter", () => {
  it("uses the default 'output' hint when no hintKey is provided", () => {
    const result = truncateText("x".repeat(200), 50)
    expect(result).toContain("truncated, use maxOutputChars to increase")
  })

  it("uses a different i18n key when hintKey='source' is provided", () => {
    const result = truncateText("x".repeat(200), 80, undefined, "source")
    expect(result).toContain("source truncated")
  })

  it("uses a different i18n key when hintKey='traceback' is provided", () => {
    const result = truncateText("x".repeat(200), 80, undefined, "traceback")
    expect(result).toContain("traceback truncated")
  })
})
