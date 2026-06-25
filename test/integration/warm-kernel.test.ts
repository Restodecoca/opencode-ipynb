import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { Effect } from "effect"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePythonService, makeKernelManager } from "../../src/services/PythonService.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { describeIf, pythonHas, realHelperEnabled } from "../helpers.js"

const NOTEBOOK_DIR = path.resolve(__dirname, "timeseries")

const makeContext = (dir: string) =>
  (({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown) as Parameters<typeof makePermissionService>[0]

const buildExecution = (dir: string) => {
  const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
  const permSvc = makePermissionService(makeContext(dir))
  const fileSvc = makeNotebookFileService()
  const pythonSvc = makePythonService({
    pythonPath: "python",
    preferUv: true,
    helperRelativePath: "python/ipynb_runner.py"
  })
  const kernelMgr = makeKernelManager({
    pythonPath: "python",
    helperPath: path.resolve("python", "ipynb_runner.py"),
    workingDirectory: dir,
    defaultTimeoutMs: 60_000
  })
  return {
    kernel: kernelMgr,
    exec: makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
      kernelManager: kernelMgr,
      warmKernel: true,
      defaultTimeoutMs: 60_000
    })
  }
}

describeIf(
  realHelperEnabled() && pythonHas("numpy"),
  "integration > warm kernel > timeseries",
  () => {
    it(
      "two successive ipynb_run calls share a warm kernel (PIDs equal, second call is at least as fast)",
      async () => {
        const { exec, kernel } = buildExecution(NOTEBOOK_DIR)
        try {
          const t1Start = Date.now()
          const r1 = await Effect.runPromise(
            exec.execute("notebook.ipynb", {
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
          const t1End = Date.now()
          expect(r1.response.success).toBe(true)

          const list1 = kernel.list()
          expect(list1.length).toBe(1)
          const pid1 = list1[0]?.pid ?? -1
          expect(pid1).toBeGreaterThan(0)
          const requestsAfter1 = list1[0]?.requestsHandled ?? 0

          // Second call should reuse the same kernel.
          const t2Start = Date.now()
          const r2 = await Effect.runPromise(
            exec.execute("notebook.ipynb", {
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
          const t2End = Date.now()
          expect(r2.response.success).toBe(true)

          const list2 = kernel.list()
          expect(list2.length).toBe(1)
          const pid2 = list2[0]?.pid ?? -1
          expect(pid2).toBe(pid1)
          const requestsAfter2 = list2[0]?.requestsHandled ?? 0
          expect(requestsAfter2).toBeGreaterThan(requestsAfter1)

          const warm1 = r1.durationMs
          const warm2 = r2.durationMs
          const total1 = t1End - t1Start
          const total2 = t2End - t2Start
          console.log(
            `[warm-kernel] first  total=${total1}ms helperDuration=${warm1}ms  pid=${pid1}`
          )
          console.log(
            `[warm-kernel] second total=${total2}ms helperDuration=${warm2}ms  pid=${pid2}`
          )
          // We expect the second call to be at least as fast as the first
          // because the kernel is already warm. A loose bound: second call
          // total <= 1.5x first call total. (A more aggressive bound would
          // be flaky on slow CI.)
          expect(total2).toBeLessThanOrEqual(Math.max(1500, total1 * 1.5))
        } finally {
          await Effect.runPromise(kernel.disposeAll())
        }
      },
      180_000
    )

    it(
      "warm kernel preserves Python state across calls (cell 1 then cell 2 sees variable from cell 1)",
      async () => {
        const { exec, kernel } = buildExecution(NOTEBOOK_DIR)
        try {
          await Effect.runPromise(
            exec.execute("notebook.ipynb", {
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
          // After running all cells, `y_smooth` is defined in the kernel.
          // Now run a synthetic command that depends on it via env mode
          // would not work (env mode doesn't run user code). Instead, run
          // the last cell again — it depends on `y_smooth`.
          const r2 = await Effect.runPromise(
            exec.execute("notebook.ipynb", {
              mode: "cell",
              cellIndex: 3,
              start: undefined,
              end: undefined,
              kernel: undefined,
              timeoutMs: 60_000,
              save: false,
              workingDirectory: undefined,
              maxOutputChars: 4_000
            })
          )
          expect(r2.response.success).toBe(true)
          const out = r2.response.outputs[0]
          expect(out?.stdout).toMatch(/min=-?\d+\.\d+/)
        } finally {
          await Effect.runPromise(kernel.disposeAll())
        }
      },
      120_000
    )
  }
)
