import { Effect } from "effect"
import { promises as fsp } from "node:fs"
import { spawn } from "node:child_process"
import { killWindowsTree } from "../utils/windows.js"
import { createHash } from "node:crypto"
import {
  CellIndexOutOfBoundsError,
  NotebookExecutionError,
  NotebookNotImplementedError,
  NotebookValidationError,
  PythonRunnerError,
  type NotebookError
} from "../domain/errors.js"
import type { NotebookFileServiceShape } from "./NotebookFileService.js"
import type { PathServiceShape } from "./PathService.js"
import {
  type PermissionServiceShape
} from "./PermissionService.js"
import {
  helperSpawnEnv,
  kernelEnvOverrides,
  pythonInterpreterResources,
  type PythonServiceShape
} from "./PythonService.js"
import type { KernelManagerShape } from "./KernelManager.js"
import type { CellRaw, CodeCellRaw } from "../domain/cell.js"
import type {
  RunRequest,
  RunResponse,
  CellExecutionSummary,
  EnvReport
} from "../domain/execution.js"
import { EnvReportSchema, RunRequestSchema, RunResponseSchema } from "../domain/execution.js"
import {
  MAX_HELPER_STDOUT_BYTES,
  MAX_RUN_RESPONSE_CHARS
} from "../utils/limits.js"
import { formatHint, type TruncationHintKey } from "../utils/i18n.js"
import { splitSourceLines, type NotebookRaw } from "../domain/notebook.js"
import {
  type Warning,
  type WarningSink,
  makeWarningSink,
  warningFrom
} from "../utils/warnings.js"

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
  readonly kernelPath: string
  readonly executedCells: ReadonlyArray<number>
  readonly durationMs: number
  readonly saved: boolean
  readonly response: RunResponse
  readonly warnings?: ReadonlyArray<Warning>
}

export interface NotebookExecutionServiceShape {
  readonly execute: (
    filePath: string,
    request: ExecutionRequest,
    options?: {
      readonly signal?: AbortSignal
      readonly warningSink?: WarningSink
    }
  ) => Effect.Effect<ExecutionResult, NotebookError>
  readonly reportEnv: (
    filePath: string,
    options?: ReportEnvOptions
  ) => Effect.Effect<EnvReport, NotebookError>
}

export interface ReportEnvOptions {
  readonly timeoutMs?: number | undefined
  readonly signal?: AbortSignal | undefined
  readonly skipShellPermission?: boolean | undefined
  readonly warningSink?: WarningSink | undefined
}

export interface ExecutionOptions {
  readonly kernelManager?: KernelManagerShape | undefined
  readonly warmKernel: boolean
  readonly defaultTimeoutMs: number
  readonly pythonPath?: string | undefined
  readonly warningSink?: WarningSink | undefined
}

const runPython = (
  pythonPath: string,
  helperPath: string,
  payload: RunRequest,
  workingDirectory: string | undefined,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Effect.Effect<RunResponse, NotebookExecutionError | PythonRunnerError, never> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: (signal) => {
      return new Promise<unknown>((resolve, reject) => {
        const child = spawn(
          pythonPath,
          [helperPath],
          {
            cwd: workingDirectory ?? process.cwd(),
            env: helperSpawnEnv(),
            stdio: ["pipe", "pipe", "pipe"],
            detached: process.platform !== "win32"
          }
        )
        child.stdin.on("error", () => {})
        const stdoutChunks: Buffer[] = []
        const stderrChunks: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let forceTimer: NodeJS.Timeout | undefined
        const signalTree = (signal: NodeJS.Signals) => {
          if (child.pid === undefined) return
          if (process.platform === "win32") {
            killWindowsTree(child.pid)
          } else {
            try {
              process.kill(-child.pid, signal)
            } catch {
              try {
                child.kill(signal)
              } catch {
              }
            }
          }
        }
        const killTree = () => {
          signalTree("SIGTERM")
          forceTimer = setTimeout(() => signalTree("SIGKILL"), 750)
          forceTimer.unref?.()
        }
        let timer: NodeJS.Timeout | undefined
        let cleanup = (): void => {}
        const onAbort = () => {
          cleanup()
          killTree()
          reject(new Error("python runner aborted"))
        }
        if (externalSignal?.aborted) {
          onAbort()
          return
        }
        externalSignal?.addEventListener("abort", onAbort, { once: true })
        signal.addEventListener("abort", onAbort, { once: true })
        cleanup = () => {
          if (timer !== undefined) clearTimeout(timer)
          if (forceTimer !== undefined) clearTimeout(forceTimer)
          externalSignal?.removeEventListener("abort", onAbort)
          signal.removeEventListener("abort", onAbort)
        }
        timer = setTimeout(() => {
          cleanup()
          killTree()
          reject(new Error(`python runner timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length
          if (stdoutBytes > MAX_HELPER_STDOUT_BYTES) {
            cleanup()
            killTree()
            reject(
              new Error(
                `python runner produced more than ${MAX_HELPER_STDOUT_BYTES} bytes of stdout`
              )
            )
            return
          }
          stdoutChunks.push(chunk)
        })
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderrBytes >= 1024 * 1024) return
          stderrBytes += chunk.length
          stderrChunks.push(chunk)
        })
        child.on("error", (err) => {
          clearTimeout(timer)
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        })
        child.on("close", (code) => {
          clearTimeout(timer)
          cleanup()
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
            cleanup()
            killTree()
            reject(new Error("python helper stdin is closed before write"))
            return
          }
          child.stdin.write(JSON.stringify(payload))
          child.stdin.end()
        } catch (err) {
          clearTimeout(timer)
          cleanup()
          killTree()
          reject(new Error(`failed to write request to python helper: ${err instanceof Error ? err.message : String(err)}`))
        }
      })
      },
      catch: (err) => err
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
      const cap = Math.max(0, payload.maxOutputChars ?? 6_000)
      const ename = parsed.data.error.ename.slice(0, cap)
      const evalue = parsed.data.error.evalue.slice(
        0,
        Math.max(0, cap - ename.length - 2)
      )
      return yield* new NotebookExecutionError({
        message: `${ename}: ${evalue}`,
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
  if (suffix.length >= maxChars) return text.slice(0, maxChars)
  const budget = Math.max(0, maxChars - suffix.length)
  return text.slice(0, budget) + suffix
}

const truncateTraceback = (tb: ReadonlyArray<string>, maxChars: number): ReadonlyArray<string> => {
  const joined = tb.join("\n")
  if (joined.length <= maxChars) return tb
  const truncated = truncateText(joined, maxChars) ?? ""
  return [truncated]
}

export const cellSummaryChars = (summary: CellExecutionSummary): number =>
  (summary.stdout?.length ?? 0) +
  (summary.stderr?.length ?? 0) +
  (summary.resultPreview?.length ?? 0) +
  (summary.errors?.reduce(
    (total, err) =>
      total +
      err.ename.length +
      err.evalue.length +
      err.traceback.reduce((sum, line) => sum + line.length, 0),
    0
  ) ?? 0) +
  (summary.displayData?.reduce(
    (total, item) => total + item.mime.length + 24,
    0
  ) ?? 0)

const truncateCellSummary = (
  summary: CellExecutionSummary,
  maxOutputChars: number
): CellExecutionSummary => {
  let remaining = Math.max(0, maxOutputChars)
  const take = (text: string | undefined): string | undefined => {
    const value = truncateText(text, remaining, undefined, "output")
    remaining = Math.max(0, remaining - (value?.length ?? 0))
    return value
  }
  const stdout = take(summary.stdout)
  const stderr = take(summary.stderr)
  const resultPreview = take(summary.resultPreview)
  const errors = summary.errors?.map((err: { ename: string; evalue: string; traceback: ReadonlyArray<string> }) => {
    const ename = take(err.ename) ?? "Error"
    const evalue = take(err.evalue) ?? ""
    const traceback = [...truncateTraceback(err.traceback, remaining)]
    remaining = Math.max(
      0,
      remaining - traceback.reduce((sum, line) => sum + line.length, 0)
    )
    return { ename, evalue, traceback }
  })
  const maxDisplayItems = Math.min(50, Math.floor(remaining / 24))
  const displayData =
    summary.displayData === undefined || maxDisplayItems <= 0
      ? undefined
      : summary.displayData.slice(0, maxDisplayItems).map((item) => {
          const mime =
            take(
              item.mime.length > 200
                ? `${item.mime.slice(0, 200)}... (truncated)`
                : item.mime
            ) ?? ""
          remaining = Math.max(0, remaining - 24)
          return { ...item, mime }
        })
  return {
    cellIndex: summary.cellIndex,
    status: summary.status,
    ...(summary.executionCount !== undefined ? { executionCount: summary.executionCount } : {}),
    ...(summary.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(stderr !== undefined ? { stderr } : {}),
    ...(resultPreview !== undefined ? { resultPreview } : {}),
    ...(displayData !== undefined ? { displayData } : {}),
    ...(errors !== undefined ? { errors } : {})
  }
}

const truncateRunResponse = (
  response: RunResponse,
  maxOutputChars: number
): RunResponse => {
  let remaining = Math.min(
    MAX_RUN_RESPONSE_CHARS,
    Math.max(0, maxOutputChars) * Math.max(1, response.outputs.length)
  )
  const outputs = response.outputs.slice(0, 1_000).map((o) => {
    const budget = Math.min(maxOutputChars, remaining)
    const truncated = truncateCellSummary(o, budget)
    remaining = Math.max(
      0,
      remaining - cellSummaryChars(truncated) - 200
    )
    return truncated
  })
  let errorBudget = Math.min(maxOutputChars, remaining)
  let error: RunResponse["error"] | undefined
  if (response.error !== undefined) {
    const ename = truncateText(response.error.ename, errorBudget) ?? "Error"
    errorBudget = Math.max(0, errorBudget - ename.length)
    const evalue = truncateText(response.error.evalue, errorBudget) ?? ""
    errorBudget = Math.max(0, errorBudget - evalue.length)
    const traceback = [...truncateTraceback(response.error.traceback, errorBudget)]
    error = {
      kind: response.error.kind,
      cellIndex: response.error.cellIndex,
      ename,
      evalue,
      traceback
    }
  }
  return {
    success: response.success,
    executedCells: response.executedCells.slice(0, 10_000),
    durationMs: response.durationMs,
    ...(response.saved !== undefined ? { saved: response.saved } : {}),
    outputs,
    ...(error !== undefined ? { error } : {})
  }
}

const SPLIT_TEXT_MIMES = new Set([
  "application/javascript",
  "image/svg+xml"
])

const isSplittableMime = (key: string): boolean =>
  key.startsWith("text/") || SPLIT_TEXT_MIMES.has(key)

export type TextShape = "arrays" | "strings"

const shapeOfValue = (value: unknown): TextShape | undefined => {
  if (typeof value === "string") return "strings"
  if (Array.isArray(value)) return "arrays"
  return undefined
}

export const textShapeOfCell = (cell: CellRaw, fallback: TextShape): TextShape => {
  const evidences: TextShape[] = []
  if (cell.cell_type === "code") {
    for (const output of (cell as CodeCellRaw).outputs) {
      const text = shapeOfValue(output["text"])
      if (text !== undefined) evidences.push(text)
      const data = output["data"]
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
          if (!isSplittableMime(key)) continue
          const shape = shapeOfValue(value)
          if (shape !== undefined) evidences.push(shape)
        }
      }
    }
  }
  if (evidences.length > 0) {
    const arrays = evidences.filter((shape) => shape === "arrays").length
    return arrays * 2 >= evidences.length ? "arrays" : "strings"
  }
  if (Array.isArray(cell.source)) return "arrays"
  if (typeof cell.source === "string") return "strings"
  return fallback
}

export interface OutputTextShapes {
  readonly text: TextShape | undefined
  readonly data: ReadonlyMap<string, TextShape>
}

export type CellValueShapes = ReadonlyArray<OutputTextShapes>

export const captureValueShapes = (cell: CellRaw): CellValueShapes => {
  if (cell.cell_type !== "code") return []
  return (cell as CodeCellRaw).outputs.map((output) => {
    const data = new Map<string, TextShape>()
    const bundle = output["data"]
    if (bundle !== null && typeof bundle === "object" && !Array.isArray(bundle)) {
      for (const [key, value] of Object.entries(bundle as Record<string, unknown>)) {
        if (!isSplittableMime(key)) continue
        const shape = shapeOfValue(value)
        if (shape !== undefined) data.set(key, shape)
      }
    }
    return { text: shapeOfValue(output["text"]), data }
  })
}

const restoreDataShapes = (
  output: Record<string, unknown>,
  previous: OutputTextShapes | undefined,
  cellShape: TextShape
): Record<string, unknown> => {
  const outputType = output["output_type"]
  if (outputType !== "execute_result" && outputType !== "display_data") return output
  const data = output["data"]
  if (data === null || typeof data !== "object" || Array.isArray(data)) return output
  let next: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!isSplittableMime(key) || typeof value !== "string") continue
    if ((previous?.data.get(key) ?? cellShape) !== "arrays") continue
    if (next === undefined) next = { ...(data as Record<string, unknown>) }
    next[key] = splitSourceLines(value)
  }
  if (next === undefined) return output
  return { ...output, data: next }
}

export const restoreValueShapes = (
  outputs: ReadonlyArray<Record<string, unknown>>,
  previous: CellValueShapes | undefined,
  cellShape: TextShape
): Array<Record<string, unknown>> =>
  outputs.map((output, index) => {
    const prior = previous?.[index]
    if (typeof output["text"] === "string" && (prior?.text ?? cellShape) === "arrays") {
      return restoreDataShapes(
        { ...output, text: splitSourceLines(output["text"] as string) },
        prior,
        cellShape
      )
    }
    return restoreDataShapes(output, prior, cellShape)
  })

export const notebookTextShape = (notebook: NotebookRaw): TextShape => {
  const shapes = notebook.cells.map((cell) => textShapeOfCell(cell as CellRaw, "strings"))
  const arrays = shapes.filter((shape) => shape === "arrays").length
  return arrays * 2 >= shapes.length ? "arrays" : "strings"
}

export const notebookUsesLineArrays = (notebook: NotebookRaw): boolean =>
  notebookTextShape(notebook) === "arrays"

export const buildPersistedOutputs = (
  summary: CellExecutionSummary
): Array<Record<string, unknown>> => {
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
  const defaultSink = execOpts?.warningSink

  const useWarmKernel = (mode: ExecutionMode): boolean =>
    warmKernel && kernelManager !== undefined && (mode === "all" || mode === "cell")

  return {
    execute: (filePath, request, options) =>
      Effect.gen(function* () {
        const sink = makeWarningSink()
        const requestedSink = options?.warningSink ?? defaultSink
        const record = (warning: Warning): void => {
          sink.add(warning)
          requestedSink?.add(warning)
        }
        const finish = (result: ExecutionResult): ExecutionResult => {
          const warnings = sink.drain()
          return warnings.length === 0 ? result : { ...result, warnings }
        }
        const abs = yield* pathSvc.resolve(filePath)
        yield* pathSvc.ensureInsideWorktree(abs)
        yield* pathSvc.ensureExists(abs)
        const stat = yield* Effect.tryPromise({
          try: () => fsp.stat(abs),
          catch: (err) =>
            new NotebookValidationError({
              message: "failed to stat notebook",
              filePath: abs,
              issues: [err instanceof Error ? err.message : String(err)]
            })
        })
        if (!stat.isFile()) {
          return yield* new NotebookValidationError({
            message: "notebook path is not a regular file",
            filePath: abs,
            issues: ["refusing to read a FIFO, socket, or device"]
          })
        }
        yield* fileSvc.read(abs)
        const displayPath = pathSvc.toDisplay(abs)
        const kernelPath = yield* Effect.promise(async () => {
          try {
            return await fsp.realpath(abs)
          } catch (error) {
            record(warningFrom("path-resolution", error, `kernel path for ${abs}`))
            return abs
          }
        })
        yield* pathSvc.ensureInsideWorktree(kernelPath)

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
        const kernelEnv = kernelEnvOverrides()
        const payload: RunRequest = {
          ...parsed.data,
          filePath: kernelPath,
          save: false,
          includeRawOutputs: request.save,
          ...(kernelEnv === undefined ? {} : { kernelEnv })
        }

        const useWarm = useWarmKernel(request.mode)
        if (useWarm && request.workingDirectory !== undefined) {
          return yield* new NotebookValidationError({
            message:
              "workingDirectory is not supported with the warm kernel; use mode=range/from or disable warmKernel",
            filePath: abs,
            issues: ["workingDirectory cannot be changed for a warm kernel"]
          })
        }
        let workingDirectory: string | undefined
        if (request.workingDirectory !== undefined) {
          workingDirectory = yield* pathSvc.resolve(request.workingDirectory)
          yield* pathSvc.ensureInsideWorktree(workingDirectory)
        }

        const helperPath = yield* pythonSvc.findHelper()
        if (!helperPath) {
          return yield* new NotebookNotImplementedError({
            message:
              "python/ipynb_runner.py was not found. The plugin ships the helper, but it could not be located at runtime. Run from the plugin checkout, reinstall via npm, or set the plugin `helperRelativePath` option.",
            feature: "notebook execution"
          })
        }

        const lexicalAliases = yield* permSvc.aliases(abs)
        const kernelAliases = yield* permSvc.aliases(kernelPath)
        const absAliases = [...new Set([...lexicalAliases, ...kernelAliases])]
        const cwdAliases =
          workingDirectory === undefined
            ? []
            : yield* permSvc.aliases(workingDirectory)
        const configuredPython = execOpts?.pythonPath
        const shellPatterns = [
          ...(configuredPython === undefined ? [] : [configuredPython]),
          ...pythonInterpreterResources(configuredPython),
          helperPath,
          ...absAliases,
          ...cwdAliases
        ]
        if (request.save) {
          yield* permSvc.ask({
            kind: "edit",
            action: "ipynb_run_save",
            patterns: absAliases,
            always: absAliases,
            metadata: {
              filePath: abs,
              mode: request.mode,
              cellIndex: request.cellIndex,
              start: request.start,
              end: request.end
            }
          })
        }
        yield* permSvc.ask({
          kind: "shell",
          action: "ipynb_run",
          patterns: shellPatterns,
          always: absAliases,
          metadata: {
            filePath: abs,
            pythonPath: configuredPython,
            mode: request.mode,
            cellIndex: request.cellIndex,
            start: request.start,
            end: request.end,
            save: request.save,
            workingDirectory: request.workingDirectory,
            timeoutMs: request.timeoutMs
          }
        })

        const probe = yield* pythonSvc.probe({
          warningSink: requestedSink
        })
        if (probe.from === "none") {
          return yield* new NotebookNotImplementedError({
            message:
              "No Python interpreter found. Set the plugin `pythonPath` option or OPENCODE_IPYNB_PYTHON, or install `python` on PATH. See ipynb_doctor for details.",
            feature: "notebook execution"
          })
        }
        if (
          !pythonInterpreterResources(configuredPython).includes(
            probe.pythonPath
          )
        ) {
          yield* permSvc.ask({
            kind: "shell",
            action: "ipynb_run_python",
            patterns: [probe.pythonPath, ...absAliases],
            always: absAliases,
            metadata: {
              filePath: abs,
              pythonPath: probe.pythonPath,
              mode: request.mode
            }
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

        let beforeHash: string | undefined
        let beforeShapes: Map<number, TextShape> | undefined
        let beforeValueShapes: Map<number, CellValueShapes> | undefined
        if (request.save) {
          const before = yield* fileSvc.readWithText(kernelPath)
          beforeHash = createHash("sha256").update(before.text).digest("hex")
          const fallback = notebookTextShape(before.notebook)
          beforeShapes = new Map(
            before.notebook.cells.map((cell, index) => [
              index,
              textShapeOfCell(cell as CellRaw, fallback)
            ])
          )
          beforeValueShapes = new Map(
            before.notebook.cells.map((cell, index) => [
              index,
              captureValueShapes(cell as CellRaw)
            ])
          )
        }

        const startTs = Date.now()
        const response = useWarm && kernelManager
          ? yield* kernelManager.execute(
              kernelPath,
              payload,
              { pythonPath: probe.pythonPath, helperPath },
              {
                ...options,
                warningSink: {
                  add: record,
                  drain: () => []
                }
              }
            )
          : yield* runPython(
              probe.pythonPath,
              helperPath,
              payload,
              workingDirectory,
              request.timeoutMs,
              options?.signal
            )
        const durationMs = Date.now() - startTs
        const truncated = truncateRunResponse(response, request.maxOutputChars)

        let wrote = false
        if (request.save) {
          if (response.outputs.some((output) => output.rawOutputsOmitted === true)) {
            return yield* new NotebookValidationError({
              message:
                "cell outputs exceed the raw-output save limit; outputs were not saved",
              filePath: abs,
              issues: [
                "reduce the output size or run with save=false to keep raw outputs bounded"
              ]
            })
          }
          yield* fileSvc.withFileLock(
            kernelPath,
            Effect.gen(function* () {
              const snapshot = yield* fileSvc.readWithText(kernelPath)
              const notebook = snapshot.notebook
              if (notebook.cells.length > 0) {
                const cellsByIndex = new Map<number, CodeCellRaw>()
                const notebookShape = notebookTextShape(notebook)
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
                    outputs: restoreValueShapes(
                      summary.rawOutputs ?? buildPersistedOutputs(summary),
                      beforeValueShapes?.get(idx),
                      beforeShapes?.get(idx) ?? notebookShape
                    ) as CodeCellRaw["outputs"],
                    execution_count:
                      summary.executionCount !== undefined && summary.executionCount !== null
                        ? summary.executionCount
                        : null
                  }
                  cellsByIndex.set(idx, next)
                }
                if (cellsByIndex.size > 0) {
                  if (
                    beforeHash !== undefined &&
                    createHash("sha256").update(snapshot.text).digest("hex") !==
                      beforeHash
                  ) {
                      return yield* new NotebookValidationError({
                        message:
                          "notebook changed while executing; outputs were not saved",
                        filePath: abs,
                        issues: [
                          "re-run ipynb_run on the current notebook revision"
                        ]
                      })
                  }
                  const newCells = notebook.cells.map((c, i) => cellsByIndex.get(i) ?? c)
                  const newNotebook: NotebookRaw = { ...notebook, cells: newCells }
                  yield* fileSvc.writeAtomic(kernelPath, newNotebook, {
                    noFollowFinal: true,
                    format: snapshot.format,
                    previousText: snapshot.text
                  })
                  wrote = true
                }
              }
            })
          )
        }

        return finish({
          displayPath,
          absPath: abs,
          kernelPath,
          executedCells: response.executedCells.slice(0, 10_000),
          durationMs,
          saved: request.save && wrote,
          response: truncated
        })
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
              "python/ipynb_runner.py was not found. The plugin ships the helper, but it could not be located at runtime. Run from the plugin checkout, reinstall via npm, or set the plugin `helperRelativePath` option.",
            feature: "notebook env report"
          })
        }

        const absAliases = yield* permSvc.aliases(abs)
        const configuredPython = execOpts?.pythonPath
        const shellPatterns = [
          ...(configuredPython === undefined ? [] : [configuredPython]),
          ...pythonInterpreterResources(configuredPython),
          helperPath,
          ...absAliases
        ]
        if (options?.skipShellPermission !== true) {
          yield* permSvc.ask({
            kind: "shell",
            action: "ipynb_repro_env",
            patterns: shellPatterns,
            always: absAliases,
            metadata: {
              filePath: abs,
              pythonPath: configuredPython
            }
          })
        }

        const reportEnvSink = options?.warningSink ?? defaultSink
        const probe = yield* pythonSvc.probe({ warningSink: reportEnvSink })
        if (probe.from === "none") {
          return yield* new NotebookNotImplementedError({
            message:
              "No Python interpreter found. Set the plugin `pythonPath` option or OPENCODE_IPYNB_PYTHON, or install `python` on PATH. See ipynb_doctor for details.",
            feature: "notebook env report"
          })
        }

        if (
          !pythonInterpreterResources(configuredPython).includes(
            probe.pythonPath
          )
        ) {
          yield* permSvc.ask({
            kind: "shell",
            action: "ipynb_repro_python",
            patterns: [probe.pythonPath, ...absAliases],
            always: absAliases,
            metadata: { filePath: abs, pythonPath: probe.pythonPath }
          })
        }
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
        const envRealPath = yield* Effect.promise(async () => {
          try {
            return await fsp.realpath(abs)
          } catch (error) {
            reportEnvSink?.add(
              warningFrom("path-resolution", error, `env report path for ${abs}`)
            )
            return abs
          }
        })
        yield* pathSvc.ensureInsideWorktree(envRealPath)
        const payload: RunRequest = {
          ...envParsed.data,
          filePath: envRealPath
        }
        const response = yield* runPython(
          probe.pythonPath,
          helperPath,
          payload,
          undefined,
          envTimeout,
          options?.signal
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
export { truncateText, truncateTraceback, truncateCellSummary, truncateRunResponse }
