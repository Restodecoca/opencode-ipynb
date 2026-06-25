import { describe, expect, it } from "bun:test"
import * as path from "node:path"
import { Effect } from "effect"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePythonService } from "../../src/services/PythonService.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { makeInspectImpl } from "../../src/services/NotebookInspectService.js"
import { describeIf, pythonHas, realHelperEnabled } from "../helpers.js"

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

const NOTEBOOK_DIR = path.resolve(__dirname, "timeseries")

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

describeIf(realHelperEnabled(), "integration > timeseries", () => {
  it.skipIf(
    !pythonHas("numpy")
  )("executes the notebook end-to-end and returns executed cells", async () => {
    const { exec } = buildServices(NOTEBOOK_DIR)
    const result = await Effect.runPromise(
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
    expect(result.executedCells.length).toBeGreaterThan(0)
    expect(result.response.success).toBe(true)
    const codeOutputs = result.response.outputs
    expect(codeOutputs.length).toBeGreaterThan(0)
    for (const summary of codeOutputs) {
      expect(summary.status).toBe("ok")
    }
  }, 120_000)

  it("ipynb_inspect on the example reports the expected cell counts", async () => {
    const { inspect } = buildServices(NOTEBOOK_DIR)
    const summary = await Effect.runPromise(inspect.inspect("notebook.ipynb"))
    expect(summary.totalCells).toBe(5)
    const codeCells = summary.cells.filter((c) => c.cellType === "code")
    const markdownCells = summary.cells.filter((c) => c.cellType === "markdown")
    expect(codeCells.length).toBe(3)
    expect(markdownCells.length).toBe(2)
  })
})
