import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { Cause, Effect } from "effect"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePythonService } from "../../src/services/PythonService.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { makeInspectImpl } from "../../src/services/NotebookInspectService.js"
import { describeIf, realHelperEnabled } from "../helpers.js"

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

const NOTEBOOK_DIR = path.resolve(__dirname, "scraping")

const buildServices = (dir: string) => {
  const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
  const permSvc = makePermissionService(makeContext(dir))
  const fileSvc = makeNotebookFileService()
  const pythonSvc = makePythonService({
    pythonPath: "python",
    preferUv: true,
    helperRelativePath: "python/ipynb_runner.py"
  })
  return {
    exec: makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc),
    inspect: makeInspectImpl(pathSvc, fileSvc)
  }
}

describeIf(realHelperEnabled(), "integration > scraping", () => {
  it("executes the notebook end-to-end and the try/except keeps success: true", async () => {
    const { exec } = buildServices(NOTEBOOK_DIR)
    const exit = await Effect.runPromiseExit(
      exec.execute("notebook.ipynb", {
        mode: "all",
        cellIndex: undefined,
        start: undefined,
        end: undefined,
        kernel: undefined,
        timeoutMs: 60_000,
        save: false,
        workingDirectory: undefined,
        maxOutputChars: 6_000
      })
    )
    if (exit._tag === "Failure") {
      const opt = Cause.failureOption(exit.cause)
      const e = opt._tag === "Some" ? (opt.value as { _tag?: string }) : undefined
      if (e?._tag === "NotebookExecution") {
        throw new Error("network required for scraping test")
      }
      if (e?._tag === "NotebookNotImplemented") {
        throw new Error("python deps not available; this test requires nbformat/nbclient/ipykernel")
      }
      throw new Error(`unexpected failure: ${JSON.stringify(e)}`)
    }
    const result = exit.value
    expect(result.executedCells.length).toBeGreaterThan(0)
    expect(result.response.success).toBe(true)
    const fetchSummary = result.response.outputs.find((o) => o.cellIndex === 2)
    expect(fetchSummary).toBeDefined()
    const stdout = fetchSummary?.stdout ?? ""
    expect(stdout.length).toBeGreaterThan(0)
  }, 120_000)

  it("ipynb_inspect on the example reports the expected cell counts", async () => {
    const { inspect } = buildServices(NOTEBOOK_DIR)
    const summary = await Effect.runPromise(inspect.inspect("notebook.ipynb"))
    expect(summary.totalCells).toBe(4)
    const codeCells = summary.cells.filter((c) => c.cellType === "code")
    const markdownCells = summary.cells.filter((c) => c.cellType === "markdown")
    expect(codeCells.length).toBe(2)
    expect(markdownCells.length).toBe(2)
  })
})
