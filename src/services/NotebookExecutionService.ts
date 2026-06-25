import { Context, Effect } from "effect"
import { spawn } from "node:child_process"
import {
  CellIndexOutOfBoundsError,
  NotebookExecutionError,
  NotebookNotFoundError,
  NotebookNotImplementedError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError,
  PythonRunnerError,
  type NotebookError
} from "../domain/errors.js"
import { NotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { PathService, type PathServiceShape } from "./PathService.js"
import { PermissionService, type PermissionServiceShape } from "./PermissionService.js"
import { PythonService, type KernelManagerShape, type PythonServiceShape } from "./PythonService.js"
import { cellSource } from "../domain/notebook.js"
import type { CellRaw, CodeCellRaw } from "../domain/cell.js"
import type {
  RunRequest,
  RunResponse,
  CellExecutionSummary,
  EnvReport
} from "../domain/execution.js"
import { EnvReportSchema, RunRequestSchema, RunResponseSchema } from "../domain/execution.js"
import { formatHint, type TruncationHintKey } from "../utils/i18n.js"
import type { NotebookRaw } from "../domain/notebook.js"

export type ExecutionMode = "cell" | "range" | "all" | "from"

export interface ExecutionRequest {
  readonly mode: ExecutionMode
  readonly cellIndex: number | undefined
  readonly start: number | undefined
  readonly end: number | undefined
  readonly kernel: string | undefined
  readonly timeoutMs: number
  readonly save: boolean
  readonly workingDirectory: string | undefined
  readonly maxOutputChars: number
}

export interface ExecutionResult {
  readonly displayPath: string
  readonly absPath: string
  readonly executedCells: ReadonlyArray<number>
  readonly durationMs: number
  readonly saved: boolean
  readonly response: RunResponse
}

export interface NotebookExecutionServiceShape {
  readonly execute: (
    filePath: string,
    request: ExecutionRequest
  ) => Effect.Effect<ExecutionResult, NotebookError>
  readonly reportEnv: (
    filePath: string,
    options?: ReportEnvOptions
  ) => Effect.Effect<EnvReport, NotebookError>
}

export interface ReportEnvOptions {
  readonly timeoutMs?: number | undefined
}

export interface ExecutionOptions {
  readonly kernelManager?: KernelManagerShape | undefined
  readonly warmKernel: boolean
  readonly defaultTimeoutMs: number
}

export class NotebookExecutionService extends Context.Tag("@ipynb/NotebookExecutionService")<
  NotebookExecutionService,
  NotebookExecutionServiceShape
>() {}

const runPython = (
  pythonPath: string,
  helperPath: string,
  payload: RunRequest,
  workingDirectory: string | undefined,
  timeoutMs: number
): Effect.Effect<RunResponse, NotebookExecutionError | PythonRunnerError, never> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise<unknown>((signal) => {
      return new Promise<unknown>((resolve, reject) => {
        const child = spawn(
          pythonPath,
          [helperPath],
          {
            cwd: workingDirectory ?? process.cwd(),
            stdio: ["pipe", "pipe", "pipe"],
            signal
          }
        )
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          reject(new Error(`python runner timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
        child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
        child.on("error", (err) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          const stdout = Buffer.concat(stdoutChunks).toString("utf8")
          const stderr = Buffer.concat(stderrChunks).toString("utf8")
          if (code !== 0) {
            reject(new Error(`python runner exited with code ${code}: ${stderr.slice(0, 500)}`))
            return
          }
          try {
            const parsed = JSON.parse(stdout) as unknown
            resolve(parsed)
          } catch (err) {
            reject(new Error(`python runner produced invalid JSON: ${err instanceof Error ? err.message : String(err)}`))
          }
        })
        try {
          if (!child.stdin.writable) {
            clearTimeout(timer)
            child.kill("SIGKILL")
            reject(new Error("python helper stdin is closed before write"))
            return
          }
          child.stdin.write(JSON.stringify(payload))
          child.stdin.end()
        } catch (err) {
          clearTimeout(timer)
          child.kill("SIGKILL")
          reject(new Error(`failed to write request to python helper: ${err instanceof Error ? err.message : String(err)}`))
        }
      })
    }).pipe(
      Effect.mapError(
        (err): NotebookExecutionError | PythonRunnerError =>
          new PythonRunnerError({
            message: err instanceof Error ? err.message : String(err),
            detail: "see logs for full output"
          })
      )
    )
    const parsed = RunResponseSchema.safeParse(result)
    if (!parsed.success) {
      return yield* new PythonRunnerError({
        message: "python runner returned an invalid response",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
      })
    }
    if (!parsed.data.success && parsed.data.error) {
      return yield* new NotebookExecutionError({
        message: `${parsed.data.error.ename}: ${parsed.data.error.evalue}`,
        filePath: payload.filePath,
        cellIndex: parsed.data.error.cellIndex
      })
    }
    return parsed.data
  })

const truncateText = (
  text: string | undefined,
  maxChars: number,
  locale?: string,
  hintKey: TruncationHintKey = "output"
): string | undefined => {
  if (text === undefined) return undefined
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const suffix = "\n" + formatHint(
    hintKey,
    { paramName: "maxOutputChars", maxChars },
    locale
  )
  const budget = Math.max(0, maxChars - suffix.length)
  return text.slice(0, budget) + suffix
}

const truncateTraceback = (tb: ReadonlyArray<string>, maxChars: number): ReadonlyArray<string> => {
  const joined = tb.join("\n")
  if (joined.length <= maxChars) return tb
  const truncated = truncateText(joined, maxChars) ?? ""
  return [truncated]
}

const truncateCellSummary = (
  summary: CellExecutionSummary,
  maxOutputChars: number
): CellExecutionSummary => {
  const stdout = truncateText(summary.stdout, maxOutputChars, undefined, "output")
  const stderr = truncateText(summary.stderr, maxOutputChars, undefined, "output")
  const resultPreview = truncateText(summary.resultPreview, maxOutputChars, undefined, "output")
  const errors = summary.errors?.map((err: { ename: string; evalue: string; traceback: ReadonlyArray<string> }) => ({
    ename: err.ename,
    evalue: err.evalue,
    traceback: [...truncateTraceback(err.traceback, maxOutputChars)]
  }))
  return {
    cellIndex: summary.cellIndex,
    status: summary.status,
    ...(summary.executionCount !== undefined ? { executionCount: summary.executionCount } : {}),
    ...(summary.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(stderr !== undefined ? { stderr } : {}),
    ...(resultPreview !== undefined ? { resultPreview } : {}),
    ...(summary.displayData !== undefined ? { displayData: summary.displayData } : {}),
    ...(errors !== undefined ? { errors } : {})
  }
}

const truncateRunResponse = (
  response: RunResponse,
  maxOutputChars: number
): RunResponse => ({
  success: response.success,
  executedCells: response.executedCells,
  durationMs: response.durationMs,
  ...(response.saved !== undefined ? { saved: response.saved } : {}),
  outputs: response.outputs.map((o) => truncateCellSummary(o, maxOutputChars)),
  ...(response.error !== undefined
    ? {
        error: {
          kind: response.error.kind,
          cellIndex: response.error.cellIndex,
          ename: response.error.ename,
          evalue: response.error.evalue,
          traceback: [...truncateTraceback(response.error.traceback, maxOutputChars)]
        }
      }
    : {})
})

export const buildPersistedOutputs = (
  summary: CellExecutionSummary
): Array<Record<string, unknown>> => {
  // Output order is intentional: stdout, stderr (stream), then the textual
  // result, then any rich displays, then errors. Jupyter Lab renders them in
  // this order, so we keep it stable across re-executions.
  const outputs: Array<Record<string, unknown>> = []
  if (summary.stdout !== undefined) {
    outputs.push({
      output_type: "stream",
      name: "stdout",
      text: summary.stdout
    })
  }
  if (summary.stderr !== undefined) {
    outputs.push({
      output_type: "stream",
      name: "stderr",
      text: summary.stderr
    })
  }
  if (summary.resultPreview !== undefined) {
    outputs.push({
      output_type: "execute_result",
      execution_count: summary.executionCount ?? null,
      data: { "text/plain": summary.resultPreview },
      metadata: {}
    })
  }
  if (summary.displayData !== undefined && summary.displayData.length > 0) {
    for (const item of summary.displayData) {
      outputs.push({
        output_type: "display_data",
        data: { [item.mime]: `(${item.sizeBytes} bytes, omitted by plugin)` },
        metadata: {}
      })
    }
  }
  if (summary.errors !== undefined && summary.errors.length > 0) {
    for (const err of summary.errors) {
      outputs.push({
        output_type: "error",
        ename: err.ename,
        evalue: err.evalue,
        traceback: [...err.traceback]
      })
    }
  }
  return outputs
}

const makeExecutionImpl = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape,
  permSvc: PermissionServiceShape,
  pythonSvc: PythonServiceShape,
  execOpts?: ExecutionOptions
): NotebookExecutionServiceShape => {
  const kernelManager = execOpts?.kernelManager
  const warmKernel = execOpts?.warmKernel ?? false
  const defaultTimeoutMs = execOpts?.defaultTimeoutMs ?? 120_000

  // Only `all` and `cell` use the warm kernel; the one-shot helper handles
  // `range` and `from` because those modes don't share state across cells in
  // a way the warm kernel can reuse, and `env` is a one-shot probe.
  const useWarmKernel = (mode: ExecutionMode): boolean =>
    warmKernel && kernelManager !== undefined && (mode === "all" || mode === "cell")

  return {
    execute: (filePath, request) =>
      Effect.gen(function* () {
        const abs = yield* pathSvc.resolve(filePath)
        yield* pathSvc.ensureInsideWorktree(abs)
        yield* pathSvc.ensureExists(abs)
        const displayPath = pathSvc.toDisplay(abs)

        const helperPath = yield* pythonSvc.findHelper()
        if (!helperPath) {
          return yield* new NotebookNotImplementedError({
            message:
              "python/ipynb_runner.py was not found. The plugin ships the helper, but it could not be located at runtime. Run from the plugin checkout, reinstall via npm, or set ipynb.helperRelativePath.",
            feature: "notebook execution"
          })
        }

        const probe = yield* pythonSvc.probe()
        if (probe.from === "none") {
          return yield* new NotebookNotImplementedError({
            message:
              "No Python interpreter found. Set ipynb.pythonPath or OPENCODE_IPYNB_PYTHON, or install `python` on PATH. See ipynb_doctor for details.",
            feature: "notebook execution"
          })
        }
        const deps = yield* pythonSvc.checkDependencies(probe.pythonPath)
        const missing = deps.filter((d) => !d.available).map((d) => d.name)
        if (missing.length > 0) {
          return yield* new NotebookNotImplementedError({
            message: `Python at ${probe.pythonPath} is missing: ${missing.join(", ")}. Use ipynb_doctor for installation instructions. The plugin does NOT install Python dependencies automatically.`,
            feature: "notebook execution"
          })
        }

        yield* permSvc.ask({
          kind: "bash",
          action: "ipynb_run",
          patterns: [probe.pythonPath, helperPath, abs],
          always: [abs],
          metadata: {
            filePath: abs,
            pythonPath: probe.pythonPath,
            mode: request.mode,
            cellIndex: request.cellIndex,
            start: request.start,
            end: request.end,
            save: request.save,
            workingDirectory: request.workingDirectory,
            timeoutMs: request.timeoutMs
          }
        })

        const startTs = Date.now()
        const parsed = RunRequestSchema.safeParse({
          filePath: abs,
          mode: request.mode,
          cellIndex: request.cellIndex,
          start: request.start,
          end: request.end,
          kernel: request.kernel,
          timeoutMs: request.timeoutMs,
          save: request.save,
          workingDirectory: request.workingDirectory,
          maxOutputChars: request.maxOutputChars
        })
        if (!parsed.success) {
          return yield* new NotebookValidationError({
            message: "RunRequest failed schema validation",
            filePath: abs,
            issues: parsed.error.issues.map(
              (i) => `${i.path.join(".") || "<root>"}: ${i.message}`
            )
          })
        }
        const payload: RunRequest = parsed.data
        const useWarm = useWarmKernel(request.mode)
        const response = useWarm && kernelManager
          ? yield* kernelManager.execute(abs, payload, { pythonPath: probe.pythonPath, helperPath })
          : yield* runPython(
              probe.pythonPath,
              helperPath,
              payload,
              request.workingDirectory,
              request.timeoutMs
            )
        const durationMs = Date.now() - startTs
        const truncated = truncateRunResponse(response, request.maxOutputChars)

        if (request.save) {
          yield* fileSvc.withFileLock(
            abs,
            Effect.gen(function* () {
              const notebook = yield* fileSvc.read(abs)
              if (notebook.cells.length > 0) {
                const cellsByIndex = new Map<number, CodeCellRaw>()
                for (const idx of response.executedCells) {
                  if (idx < 0 || idx >= notebook.cells.length) {
                    return yield* new CellIndexOutOfBoundsError({
                      message: `runner reported executed cell ${idx} but notebook has ${notebook.cells.length} cells`,
                      filePath: abs,
                      cellIndex: idx,
                      total: notebook.cells.length
                    })
                  }
                  const cell = notebook.cells[idx] as CellRaw
                  if (cell.cell_type !== "code") continue
                  const summary = response.outputs.find((o) => o.cellIndex === idx)
                  if (!summary) continue
                  const next: CodeCellRaw = {
                    ...cell,
                    outputs: (summary.rawOutputs ?? buildPersistedOutputs(summary)) as CodeCellRaw["outputs"],
                    execution_count:
                      summary.executionCount !== undefined && summary.executionCount !== null
                        ? summary.executionCount
                        : null
                  }
                  cellsByIndex.set(idx, next)
                }
                if (cellsByIndex.size > 0) {
                  const newCells = notebook.cells.map((c, i) => cellsByIndex.get(i) ?? c)
                  const newNotebook: NotebookRaw = { ...notebook, cells: newCells }
                  yield* fileSvc.writeAtomic(abs, newNotebook)
                }
              }
            })
          )
        }

        return {
          displayPath,
          absPath: abs,
          executedCells: response.executedCells,
          durationMs,
          saved: request.save,
          response: truncated
        }
      }),
    reportEnv: (filePath, options) =>
      Effect.gen(function* () {
        const abs = yield* pathSvc.resolve(filePath)
        yield* pathSvc.ensureInsideWorktree(abs)
        yield* pathSvc.ensureExists(abs)
        yield* fileSvc.read(abs)

        const helperPath = yield* pythonSvc.findHelper()
        if (!helperPath) {
          return yield* new NotebookNotImplementedError({
            message:
              "python/ipynb_runner.py was not found. The plugin ships the helper, but it could not be located at runtime. Run from the plugin checkout, reinstall via npm, or set ipynb.helperRelativePath.",
            feature: "notebook env report"
          })
        }

        const probe = yield* pythonSvc.probe()
        if (probe.from === "none") {
          return yield* new NotebookNotImplementedError({
            message:
              "No Python interpreter found. Set ipynb.pythonPath or OPENCODE_IPYNB_PYTHON, or install `python` on PATH. See ipynb_doctor for details.",
            feature: "notebook env report"
          })
        }

        // The 30s floor is a minimum for env-mode (pip freeze + import probes);
        // the configured defaultTimeoutMs is the upper bound when the caller
        // does not pass an explicit value.
        const envTimeout = options?.timeoutMs ?? Math.max(30_000, defaultTimeoutMs)
        const envParsed = RunRequestSchema.safeParse({
          filePath: abs,
          mode: "env",
          timeoutMs: envTimeout
        })
        if (!envParsed.success) {
          return yield* new NotebookValidationError({
            message: "RunRequest failed schema validation (env report)",
            filePath: abs,
            issues: envParsed.error.issues.map(
              (i) => `${i.path.join(".") || "<root>"}: ${i.message}`
            )
          })
        }
        const payload: RunRequest = envParsed.data
        const response = yield* runPython(
          probe.pythonPath,
          helperPath,
          payload,
          undefined,
          envTimeout
        )
        if (!response.env) {
          return yield* new PythonRunnerError({
            message: "python runner returned a response without an env report",
            detail: `success=${response.success}, executedCells=${response.executedCells.length}`
          })
        }
        const parsed = EnvReportSchema.safeParse(response.env)
        if (!parsed.success) {
          return yield* new PythonRunnerError({
            message: "env report failed schema validation",
            detail: parsed.error.issues
              .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
              .join("; ")
          })
        }
        return parsed.data
      })
  }
}

export { makeExecutionImpl }
export { cellSource }
export { truncateText, truncateTraceback, truncateCellSummary, truncateRunResponse }
