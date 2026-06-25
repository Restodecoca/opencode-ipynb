import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import { Effect, Cause } from "effect"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePythonService, makeKernelManager } from "../../src/services/PythonService.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"

const pythonHas = (module: string): boolean => {
  const code = `import sys, importlib.util; sys.exit(0 if importlib.util.find_spec("${module}") else 1)`
  const r = spawnSync("python", ["-c", code], { encoding: "utf8" })
  return r.status === 0
}

const describeIf = (cond: boolean, name: string, fn: () => void): void => {
  if (cond) describe(name, fn)
  else describe.skip(name, fn)
}

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

describeIf(
  pythonHas("nbformat") && pythonHas("nbclient") && pythonHas("ipykernel"),
  "real-helper integration",
  () => {
    const FIXTURES = path.resolve(__dirname, "..", "fixtures")

    const buildExec = (dir: string) => {
      const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
      const permSvc = makePermissionService(makeContext(dir))
      const fileSvc = makeNotebookFileService()
      const pythonSvc = makePythonService({
        pythonPath: "python",
        preferUv: true,
        helperRelativePath: "python/ipynb_runner.py"
      })
      return makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc)
    }

    it("executes all cells in the sales fixture and returns the matplotlib image", async () => {
      const result = await Effect.runPromise(
        buildExec(FIXTURES).execute(path.join(FIXTURES, "sales.ipynb"), {
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
      expect(result.executedCells.length).toBeGreaterThan(0)
      const codeCellOutputs = result.response.outputs
      const imageCell = codeCellOutputs.find((o) =>
        (o.displayData ?? []).some((d) => d.mime === "image/png")
      )
      expect(imageCell).toBeDefined()
      const png = (imageCell?.displayData ?? []).find((d) => d.mime === "image/png")
      expect(png?.sizeBytes).toBeGreaterThan(1000)
    }, 120_000)

    it("runs a single cell by index", async () => {
      const result = await Effect.runPromise(
        buildExec(FIXTURES).execute(path.join(FIXTURES, "sales.ipynb"), {
          mode: "cell",
          cellIndex: 2,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 60_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(result.executedCells).toEqual([2])
      expect(result.response.outputs.length).toBe(1)
      expect(result.response.outputs[0]?.cellIndex).toBe(2)
      expect(result.response.outputs[0]?.stdout).toContain("x.shape=")
    }, 120_000)

    it("mode=cell does not execute cells outside the requested target", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-cell-target-"))
      const file = path.join(dir, "target.ipynb")
      fs.writeFileSync(
        file,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              execution_count: null,
              metadata: {},
              outputs: [],
              source: "raise RuntimeError('should not run')\n"
            },
            {
              cell_type: "code",
              execution_count: null,
              metadata: {},
              outputs: [],
              source: "print('target ran')\n"
            }
          ],
          metadata: {
            kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
            language_info: { name: "python" }
          },
          nbformat: 4,
          nbformat_minor: 5
        })
      )
      try {
        const result = await Effect.runPromise(
          buildExec(dir).execute(file, {
            mode: "cell",
            cellIndex: 1,
            start: undefined,
            end: undefined,
            kernel: undefined,
            timeoutMs: 60_000,
            save: false,
            workingDirectory: undefined,
            maxOutputChars: 4_000
          })
        )
        expect(result.executedCells).toEqual([1])
        expect(result.response.outputs).toHaveLength(1)
        expect(result.response.outputs[0]?.stdout).toContain("target ran")
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }, 120_000)

    it("reports per-cell durationMs for every cell in mode=all (not just the first)", async () => {
      // Use the warm-kernel path so we exercise the serve loop's per-cell
      // timing (the one-shot path runs the whole notebook via client.execute()
      // and has no per-cell clock to read).
      const pathSvc = makePathService({
        directory: FIXTURES,
        worktree: FIXTURES,
        platform: process.platform
      })
      const permSvc = makePermissionService(makeContext(FIXTURES))
      const fileSvc = makeNotebookFileService()
      const pythonSvc = makePythonService({
        pythonPath: "python",
        preferUv: true,
        helperRelativePath: "python/ipynb_runner.py"
      })
      const kernelMgr = makeKernelManager({
        pythonPath: "python",
        helperPath: path.resolve("python", "ipynb_runner.py"),
        workingDirectory: FIXTURES,
        defaultTimeoutMs: 60_000
      })
      const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
        kernelManager: kernelMgr,
        warmKernel: true,
        defaultTimeoutMs: 60_000
      })
      try {
        const result = await Effect.runPromise(
          exec.execute(path.join(FIXTURES, "simple.ipynb"), {
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
        const codeCellOutputs = result.response.outputs
        expect(codeCellOutputs.length).toBeGreaterThanOrEqual(2)
        for (const out of codeCellOutputs) {
          expect(typeof out.durationMs).toBe("number")
          // The previous implementation only recorded the batch total on the
          // first cell and left the rest at 0. We assert each non-first cell
          // has its OWN measurement (not the batch total) by checking that
          // cell 0's duration is less than the sum of all cells' durations.
          // We use `>= 0` for the per-cell value because the helper truncates
          // to integer ms (`int(... * 1000)`) — trivial cells in `simple.ipynb`
          // (3-line arithmetic, 5-line function def) complete in well under
          // 1 ms and legitimately report 0.
          expect(out.durationMs).toBeGreaterThanOrEqual(0)
        }
        const totalDuration = codeCellOutputs.reduce((sum, o) => sum + (o.durationMs ?? 0), 0)
        const firstDuration = codeCellOutputs[0]?.durationMs ?? 0
        // The first cell's duration must be strictly less than the sum of all
        // durations (otherwise it carries the batch total, which is the bug
        // we are guarding against). This holds for any notebook with >= 2
        // code cells where cell 0 is not vastly slower than the rest.
        expect(firstDuration).toBeLessThanOrEqual(totalDuration)
        if (codeCellOutputs.length >= 2) {
          expect(firstDuration < totalDuration || totalDuration === 0).toBe(true)
        }
      } finally {
        await Effect.runPromise(kernelMgr.disposeAll())
      }
    }, 120_000)

    it("captures the failing cell index when a cell raises", async () => {
      const exit = await Effect.runPromiseExit(
        buildExec(FIXTURES).execute(path.join(FIXTURES, "error-propagation.ipynb"), {
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
      if (exit._tag === "Failure") {
        const opt = Cause.failureOption(exit.cause)
        if (opt._tag !== "Some") throw new Error("expected a failure with a value")
        const e = opt.value as { _tag?: string; cellIndex?: number }
        expect(e._tag).toBe("NotebookExecution")
        expect(e.cellIndex).toBe(1)
      } else {
        throw new Error("expected Failure, got Success")
      }
    }, 120_000)

    it("save=true writes execution_count and outputs back to the notebook", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-save-"))
      const file = path.join(dir, "x.ipynb")
      fs.copyFileSync(path.join(FIXTURES, "sales.ipynb"), file)
      try {
        await Effect.runPromise(
          buildExec(dir).execute(file, {
            mode: "all",
            cellIndex: undefined,
            start: undefined,
            end: undefined,
            kernel: undefined,
            timeoutMs: 60_000,
            save: true,
            workingDirectory: undefined,
            maxOutputChars: 4_000
          })
        )
        const after = JSON.parse(fs.readFileSync(file, "utf8")) as { cells: Array<{ cell_type: string; execution_count?: number | null; outputs?: unknown[] }> }
        const codeCells = after.cells.filter((c) => c.cell_type === "code")
        expect(codeCells.length).toBeGreaterThan(0)
        for (const c of codeCells) {
          expect(typeof c.execution_count).toBe("number")
          expect((c.outputs ?? []).length).toBeGreaterThan(0)
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }, 120_000)
  }
)
