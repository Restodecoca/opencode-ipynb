import { spawn, type ChildProcess } from "node:child_process"
import { killWindowsTree } from "../utils/windows.js"
import { promises as fsp, realpathSync } from "node:fs"
import { Effect } from "effect"
import { StringDecoder } from "node:string_decoder"
import { randomUUID } from "node:crypto"
import { PythonRunnerError, type NotebookError } from "../domain/errors.js"
import {
  RunResponseSchema,
  type RunRequest,
  type RunResponse
} from "../domain/execution.js"
import { helperSpawnEnv } from "./PythonService.js"
import { MAX_HELPER_STDOUT_BYTES } from "../utils/limits.js"
import {
  type Warning,
  type WarningSink,
  warningFrom
} from "../utils/warnings.js"


export interface KernelManagerOptions {
  readonly pythonPath: string
  readonly helperPath: string
  readonly workingDirectory: string | undefined
  readonly defaultTimeoutMs: number
  readonly warningSink?: WarningSink
  readonly sinkTarget?: { sink?: WarningSink | undefined }
}

export interface KernelRuntimeOptions {
  readonly pythonPath: string
  readonly helperPath: string
}

export interface KernelInfo {
  readonly filePath: string
  readonly pid: number
  readonly lastUsedAt: number
  readonly requestsHandled: number
  readonly stderrTail: string
  readonly warnings?: ReadonlyArray<Warning>
}

export interface KernelManagerStats {
  readonly liveKernels: number
  readonly totalRequests: number
}

interface PendingRequest {
  resolve: (response: RunResponse) => void
  reject: (err: PythonRunnerError) => void
  timer: NodeJS.Timeout | undefined
  cleanup?: () => void
  sink?: WarningSink | undefined
  nonce: string
}

interface KernelState {
  proc: ChildProcess
  filePath: string
  reportedPath: string
  pythonPath: string
  helperPath: string
  requestedKernel: string | undefined
  pid: number
  kernelPid: number | undefined
  nextId: number
  inflight: number
  nonceRequired: boolean
  pending: Map<number, PendingRequest>
  readyPromise: Promise<void>
  resolveReady: () => void
  rejectReady: (err: PythonRunnerError) => void
  readyResolved: boolean
  lastUsed: number
  requestsHandled: number
  stderrTail: string[]
  warnings: Warning[]
  alive: boolean
  startedAt: number
  shutdownRequestId: number | undefined
}

const STDERR_TAIL_MAX = 20
const KERNEL_WARNINGS_MAX = 20

interface Deferred<A, E> {
  readonly promise: Promise<A>
  readonly resolve: (a: A) => void
  readonly reject: (e: E) => void
}

const createDeferred = <A, E>(): Deferred<A, E> => {
  let resolve!: (a: A) => void
  let reject!: (e: E) => void
  const promise = new Promise<A>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const EMPTY_SHUTDOWN_RESPONSE = {
  success: true,
  executedCells: [] as ReadonlyArray<number>,
  durationMs: 0,
  outputs: [] as ReadonlyArray<unknown>
} as unknown as RunResponse

export const killPidTree = (
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGTERM",
  notify?: (error: unknown) => void
): void => {
  if (pid === undefined || pid <= 1) return
  if (process.platform === "win32") {
    killWindowsTree(pid)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch (directError) {
      if ((directError as NodeJS.ErrnoException).code !== "ESRCH") {
        notify?.(directError)
      }
    }
  }
}

const killProcessTree = (
  proc: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  kernelPid?: number,
  notify?: (error: unknown) => void
): void => {
  killPidTree(kernelPid, signal, notify)
  if (proc.pid === undefined) return
  if (process.platform === "win32") {
    killWindowsTree(proc.pid)
    return
  }
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch (directError) {
      if ((directError as NodeJS.ErrnoException).code !== "ESRCH") {
        notify?.(directError)
      }
    }
  }
}

const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
  onAbort?: () => void
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      fn()
    }
    const abort = () =>
      finish(() => {
        onAbort?.()
        reject(
          new PythonRunnerError({
            message: "warm kernel request aborted",
            detail: `timeoutMs=${timeoutMs}`
          })
        )
      })
    const timer = setTimeout(
      () =>
        finish(() => {
          onAbort?.()
          reject(
            new PythonRunnerError({
              message,
              detail: `timeoutMs=${timeoutMs}`
            })
          )
        }),
      timeoutMs
    )
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })

export const makeKernelManager = (opts: KernelManagerOptions): KernelManagerShape => {
  const states = new Map<string, KernelState>()
  const canonicalAliases = new Map<string, string>()

  const forgetState = (filePath: string): void => {
    states.delete(filePath)
    for (const [alias, target] of canonicalAliases) {
      if (target === filePath) canonicalAliases.delete(alias)
    }
  }
  const kernelLocks = new Map<string, Promise<void>>()
  const sinkTarget = opts.sinkTarget ?? { sink: opts.warningSink }
  const currentSink = (): WarningSink | undefined => sinkTarget.sink
  const reported = new Set<string>()
  let totalRequests = 0

  const record = (state: KernelState, warning: Warning): void => {
    const key = `${state.filePath}|${warning.source}|${warning.detail ?? warning.message}`
    if (reported.has(key)) return
    if (reported.size >= KERNEL_WARNINGS_MAX * 5) reported.clear()
    reported.add(key)
    if (state.warnings.length >= KERNEL_WARNINGS_MAX) state.warnings.shift()
    state.warnings.push(warning)
    const sink = currentSink()
    if (sink !== undefined) sink.add(warning)
    for (const pending of state.pending.values()) {
      if (pending.sink !== undefined && pending.sink !== sink) pending.sink.add(warning)
    }
  }

  const stopKernelIfIdle = (filePath: string, state: KernelState): void => {
    if (state.pending.size > 0 || state.inflight > 0) return
    stopKernelInBackground(filePath)
  }

  const stopKernelInBackground = (filePath: string): void => {
    void killKernel(filePath).catch((error: unknown) => {
      currentSink()?.add(warningFrom("cleanup", error, `stopping the warm kernel for ${filePath}`))
    })
  }

  const killFailure =
    (state: KernelState): ((error: unknown) => void) =>
    (error) =>
      record(state, warningFrom("cleanup", error, "killing the kernel process tree"))

  const withKernelLock = async <T>(
    key: string,
    task: () => Promise<T>
  ): Promise<T> => {
    const previous = kernelLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(
      () => gate,
      () => gate
    )
    kernelLocks.set(key, tail)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (kernelLocks.get(key) === tail) kernelLocks.delete(key)
    }
  }

  const appendStderr = (state: KernelState, chunk: string): void => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue
      state.stderrTail.push(line.length > 2_000 ? `${line.slice(0, 2_000)}... (truncated)` : line)
      if (state.stderrTail.length > STDERR_TAIL_MAX) {
        state.stderrTail.shift()
      }
    }
  }

  const failAllPending = (state: KernelState, message: string, detail: string): void => {
    for (const [id, handler] of state.pending) {
      clearTimeout(handler.timer)
      handler.cleanup?.()
      handler.reject(new PythonRunnerError({ message, detail: `${detail} (id=${id})` }))
    }
    state.pending.clear()
    if (!state.readyResolved && state.rejectReady) {
      state.rejectReady(new PythonRunnerError({ message, detail }))
    }
  }

  const spawnKernel = (
    filePath: string,
    runtime: KernelRuntimeOptions,
    requestedKernel: string | undefined
  ): KernelState => {
    const proc = spawn(
      runtime.pythonPath,
      [runtime.helperPath],
      {
        cwd: opts.workingDirectory ?? process.cwd(),
        env: helperSpawnEnv(),
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      }
    )
    proc.stdin?.on("error", () => {})
    const startedAt = Date.now()
    const readyDeferred = createDeferred<void, PythonRunnerError>()
    const state: KernelState = {
      proc,
      filePath,
      reportedPath: filePath,
      pythonPath: runtime.pythonPath,
      helperPath: runtime.helperPath,
      requestedKernel,
      pid: proc.pid ?? -1,
      kernelPid: undefined,
      nextId: 1,
      inflight: 0,
      nonceRequired: false,
      pending: new Map(),
      readyPromise: readyDeferred.promise,
      resolveReady: readyDeferred.resolve,
      rejectReady: readyDeferred.reject,
      readyResolved: false,
      lastUsed: startedAt,
      requestsHandled: 0,
      stderrTail: [],
      warnings: [],
      alive: true,
      startedAt,
      shutdownRequestId: undefined
    }

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      if (Buffer.byteLength(line, "utf8") > MAX_HELPER_STDOUT_BYTES) {
        for (const handler of state.pending.values()) {
          clearTimeout(handler.timer)
          handler.cleanup?.()
          handler.reject(
            new PythonRunnerError({
              message: `kernel response exceeded ${MAX_HELPER_STDOUT_BYTES} bytes`,
              detail: "use ipynb_run maxOutputChars or run the cell in smaller pieces"
            })
          )
        }
        state.pending.clear()
        return
      }
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch (error) {
        record(
          state,
          warningFrom("python-probe", error, `ignored non-JSON kernel output: ${line.slice(0, 200)}`)
        )
        return
      }
      if (!msg || typeof msg !== "object") {
        record(
          state,
          warningFrom(
            "python-probe",
            new Error("kernel emitted a non-object JSON line"),
            `ignored: ${line.slice(0, 200)}`
          )
        )
        return
      }
      const m = msg as Record<string, unknown>
      if (!state.readyResolved && m.ready === true) {
        if (typeof m.kernelPid === "number" && m.kernelPid > 0) {
          state.kernelPid = m.kernelPid
        }
        state.nonceRequired = m.nonceVersion === 1
        state.readyResolved = true
        state.resolveReady()
        return
      }
      if (!state.readyResolved && m.ready === undefined && m.error) {
        state.readyResolved = true
        state.rejectReady(
          new PythonRunnerError({
            message: typeof m.error === "object" && m.error !== null && "message" in m.error
              ? String((m.error as { message: unknown }).message ?? "kernel init failed")
              : "kernel init failed",
            detail: typeof m.error === "object" && m.error !== null && "detail" in m.error
              ? String((m.error as { detail: unknown }).detail ?? "")
              : ""
          })
        )
        return
      }
      const id = typeof m.id === "number" ? m.id : undefined
      if (id === undefined) return
      const handler = state.pending.get(id)
      if (!handler) return
      if (
        state.nonceRequired &&
        (typeof m.nonce !== "string" || m.nonce !== handler.nonce)
      ) {
        record(
          state,
          warningFrom(
            "python-probe",
            new Error("ignored a kernel line whose nonce does not match the request"),
            `id=${id}`
          )
        )
        return
      }
      state.pending.delete(id)
      clearTimeout(handler.timer)
      handler.cleanup?.()
      if (m.error) {
        if (typeof m.error !== "object" || m.error === null) {
          handler.reject(
            new PythonRunnerError({
              message: "kernel returned a non-object error payload",
              detail: typeof m.error === "string" ? m.error : String(m.error)
            })
          )
          return
        }
        const e = m.error as { ename?: unknown; evalue?: unknown; traceback?: unknown }
        const ename = typeof e.ename === "string" ? e.ename : "Error"
        const evalue = typeof e.evalue === "string" ? e.evalue : ""
        handler.reject(
          new PythonRunnerError({
            message: `${ename}: ${evalue}`,
            detail: ""
          })
        )
        if (
          ename === "KernelRestartRequired" ||
          ename === "DeadKernelError" ||
          (ename === "PythonRunnerError" && evalue.includes("kernel"))
        ) {
          state.alive = false
          if (states.get(state.filePath) === state) forgetState(state.filePath)
        }
        return
      }
      handler.resolve(m as unknown as RunResponse)
    }

    let pending: Buffer[] = []
    let pendingBytes = 0
    const decoder = new StringDecoder("utf8")
    proc.stdout.on("data", (chunk: Buffer) => {
      pending.push(chunk)
      pendingBytes += chunk.length
      if (pendingBytes > MAX_HELPER_STDOUT_BYTES) {
        pending = []
        pendingBytes = 0
        for (const handler of state.pending.values()) {
          clearTimeout(handler.timer)
          handler.cleanup?.()
          handler.reject(
            new PythonRunnerError({
              message: `kernel response exceeded ${MAX_HELPER_STDOUT_BYTES} bytes`,
              detail: "use ipynb_run maxOutputChars or run the cell in smaller pieces"
            })
          )
        }
        state.pending.clear()
        try {
          proc.kill("SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            record(
              state,
              warningFrom("cleanup", error, "killing the kernel after its stdout overflowed")
            )
          }
        }
        return
      }
      if (chunk.indexOf(0x0a) === -1) return
      const combined = Buffer.concat(pending)
      pending = []
      pendingBytes = 0
      let offset = 0
      let newline = combined.indexOf(0x0a, offset)
      while (newline >= 0) {
        const rawLine = combined.subarray(offset, newline)
        offset = newline + 1
        const line = decoder.write(rawLine).replace(/\r$/, "")
        if (line.trim()) handleLine(line)
        newline = combined.indexOf(0x0a, offset)
      }
      if (offset < combined.length) {
        const rest = combined.subarray(offset)
        pending.push(rest)
        pendingBytes = rest.length
      }
    })

    proc.stderr.on("data", (chunk: Buffer) => {
      appendStderr(state, chunk.toString("utf8"))
    })

    proc.on("close", (code, signal) => {
      state.alive = false
      if (code === 0) {
        if (!state.readyResolved) {
          state.readyResolved = true
          state.rejectReady(
            new PythonRunnerError({
              message: "kernel helper exited before it became ready",
              detail: `code=${code} signal=${signal ?? "none"}`
            })
          )
        }
        for (const [id, handler] of state.pending) {
          clearTimeout(handler.timer)
          handler.cleanup?.()
          if (id === state.shutdownRequestId) {
            handler.resolve(EMPTY_SHUTDOWN_RESPONSE)
            continue
          }
          handler.reject(
            new PythonRunnerError({
              message: "kernel exited unexpectedly",
              detail: `code=${code ?? "?"} signal=${signal ?? "none"} id=${id}`
            })
          )
        }
        state.pending.clear()
        killProcessTree(proc, "SIGKILL", state.kernelPid, killFailure(state))
        if (states.get(state.filePath) === state) forgetState(state.filePath)
        return
      }
      killProcessTree(proc, "SIGKILL", state.kernelPid, killFailure(state))
      failAllPending(
        state,
        "kernel subprocess exited",
        `code=${code ?? "?"} signal=${signal ?? "none"}`
      )
      if (states.get(state.filePath) === state) forgetState(state.filePath)
    })

    proc.on("error", (err) => {
      state.alive = false
      killProcessTree(proc, "SIGKILL", state.kernelPid, killFailure(state))
      failAllPending(state, "kernel subprocess error", err.message)
      if (states.get(state.filePath) === state) forgetState(state.filePath)
    })

    return state
  }

  const writeInit = (state: KernelState, request: RunRequest): void => {
    const init = { ...request, id: 0, mode: "serve" as const }
    const stdin = state.proc.stdin
    if (!stdin || !stdin.writable) {
      state.readyResolved = true
      state.rejectReady(
        new PythonRunnerError({
          message: "kernel stdin is closed",
          detail: `filePath=${state.filePath} id=0 during init`
        })
      )
      return
    }
    try {
      stdin.write(JSON.stringify(init) + "\n")
    } catch (err) {
      state.readyResolved = true
      state.rejectReady(
        new PythonRunnerError({
          message: "failed to write warm kernel init",
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    }
  }

  const runtimeFromRequest = (runtime?: KernelRuntimeOptions): KernelRuntimeOptions =>
    runtime ?? { pythonPath: opts.pythonPath, helperPath: opts.helperPath }

  const getOrStart = async (
    filePath: string,
    request: RunRequest,
    runtimeInput?: KernelRuntimeOptions
  ): Promise<KernelState> => {
    const key = await canonicalPathForKernel(filePath)
    return withKernelLock(key, async () => {
      const state = await getOrStartUnlocked(key, request, runtimeFromRequest(runtimeInput))
      // The state is keyed by the canonical path, but the kernel list must
      // report the spelling the caller actually used: on macOS the session
      // dir is a symlink (/tmp -> /private/tmp) and on Windows an 8.3 short
      // name (RUNNER~1), and a canonical listing would show paths the user
      // never typed.
      state.reportedPath = filePath
      return state
    })
  }

  const getOrStartUnlocked = async (
    filePath: string,
    request: RunRequest,
    runtime: KernelRuntimeOptions
  ): Promise<KernelState> => {
    const existing = states.get(filePath)
    if (
      existing &&
      existing.alive &&
      existing.pythonPath === runtime.pythonPath &&
      existing.helperPath === runtime.helperPath &&
      existing.requestedKernel === request.kernel
    ) {
      return existing
    }
    if (existing && existing.alive) {
      await killKernelUnlocked(filePath)
    }
    if (existing && !existing.alive) {
      forgetState(filePath)
    }
    const state = spawnKernel(filePath, runtime, request.kernel)
    states.set(filePath, state)
    writeInit(state, request)
    return state
  }

  const sendShutdown = (state: KernelState): Promise<void> =>
    new Promise((resolve) => {
      const id = state.nextId++
      state.shutdownRequestId = id
      const shutdownNonce = randomUUID()
      const timer = setTimeout(() => {
        state.pending.delete(id)
        handlerCleanup?.()
        if (state.shutdownRequestId === id) {
          state.shutdownRequestId = undefined
        }
        resolve()
      }, 2_000)
      let handlerCleanup: (() => void) | undefined
      state.pending.set(id, {
        nonce: shutdownNonce,
        resolve: () => {
          clearTimeout(timer)
          handlerCleanup?.()
          if (state.shutdownRequestId === id) {
            state.shutdownRequestId = undefined
          }
          resolve()
        },
        reject: () => {
          clearTimeout(timer)
          handlerCleanup?.()
          if (state.shutdownRequestId === id) {
            state.shutdownRequestId = undefined
          }
          resolve()
        },
        timer,
        cleanup: () => handlerCleanup?.()
      })
      const stdin = state.proc.stdin
      if (!stdin || !stdin.writable) {
        clearTimeout(timer)
        state.pending.delete(id)
        if (state.shutdownRequestId === id) {
          state.shutdownRequestId = undefined
        }
        resolve()
        return
      }
      const onStdinError = (): void => {
        clearTimeout(timer)
        handlerCleanup?.()
        state.pending.delete(id)
        if (state.shutdownRequestId === id) {
          state.shutdownRequestId = undefined
        }
        resolve()
      }
      stdin.once("error", onStdinError)
      handlerCleanup = () => stdin.off("error", onStdinError)
      try {
        stdin.write(JSON.stringify({ id, mode: "shutdown" }) + "\n")
      } catch {
        handlerCleanup()
        clearTimeout(timer)
        state.pending.delete(id)
        if (state.shutdownRequestId === id) {
          state.shutdownRequestId = undefined
        }
        resolve()
      }
    })

  const canonicalPathForKernel = async (
    filePath: string
  ): Promise<string> => {
    let canonical: string
    let resolved = false
    try {
      canonical = await fsp.realpath(filePath)
      resolved = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const key = `path|${filePath}|${code ?? "EIO"}`
      if (code !== "ENOENT" && !reported.has(key)) {
        reported.add(key)
        currentSink()?.add(warningFrom("path-resolution", error, `kernel key for ${filePath}`))
      }
      canonical = filePath
    }
    if (resolved) {
      canonicalAliases.set(filePath, canonical)
      canonicalAliases.set(canonical, canonical)
    }
    return canonical
  }

  const killKernel = async (inputPath: string): Promise<void> => {
    const recorded = canonicalAliases.get(inputPath)
    const canonical = await canonicalPathForKernel(inputPath)
    const filePath =
      !states.has(canonical) && recorded !== undefined && states.has(recorded)
        ? recorded
        : canonical
    return withKernelLock(filePath, () => killKernelUnlocked(filePath))
  }

  const killKernelUnlocked = async (filePath: string): Promise<void> => {
    const state = states.get(filePath)
    if (!state) {
      forgetState(filePath)
      return
    }
    forgetState(filePath)
    if (!state.alive) return
    await sendShutdown(state)
    if (state.alive) {
      killProcessTree(state.proc, "SIGTERM", state.kernelPid, killFailure(state))
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (state.alive)
            killProcessTree(state.proc, "SIGKILL", state.kernelPid, killFailure(state))
          resolve()
        }, 3_000)
        state.proc.once("close", () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  const execute = Effect.fnUntraced(function* (
    filePath: string,
    request: RunRequest,
    runtime?: KernelRuntimeOptions,
    options?: {
      readonly signal?: AbortSignal
      readonly warningSink?: WarningSink
    }
  ) {
      if (options?.signal?.aborted) {
        return yield* new PythonRunnerError({
          message: "warm kernel request aborted",
          detail: `filePath=${filePath}`
        })
      }
      const kernelPath = yield* Effect.promise(() => canonicalPathForKernel(filePath))
      const state = yield* Effect.tryPromise({
        try: () => getOrStart(kernelPath, request, runtime),
        catch: (err) =>
          new PythonRunnerError({
            message: "failed to start warm kernel",
            detail: err instanceof Error ? err.message : String(err)
          })
      })
      // execute canonicalizes before getOrStart, so getOrStart records the
      // canonical spelling; the kernel list must report the one the caller
      // used, which differs from the canonical form on macOS (symlinked temp
      // dirs) and Windows (8.3 short names).
      state.reportedPath = filePath
      const requestSink = options?.warningSink
      const timeoutMs = request.timeoutMs ?? opts.defaultTimeoutMs
      state.inflight += 1
      let readyInflight = true
      const releaseReady = (): void => {
        if (!readyInflight) return
        readyInflight = false
        state.inflight = Math.max(0, state.inflight - 1)
      }
      yield* Effect.tryPromise({
        try: () =>
          withTimeout(
            state.readyPromise,
            timeoutMs,
            "warm kernel did not become ready before the timeout",
            options?.signal,
            () => stopKernelIfIdle(kernelPath, state)
          ),
        catch: (err) =>
          err instanceof PythonRunnerError
            ? err
            : new PythonRunnerError({
                message: "warm kernel failed to become ready",
                detail: err instanceof Error ? err.message : String(err)
              })
      }).pipe(Effect.ensuring(Effect.sync(releaseReady)))
      state.inflight += 1
      const releaseInflight = (): void => {
        state.inflight = Math.max(0, state.inflight - 1)
      }
      const id = state.nextId++
      const nonce = randomUUID()
      const raw = yield* Effect.tryPromise<RunResponse, PythonRunnerError>({
        try: () =>
          new Promise<RunResponse>((resolve, reject) => {
            let timer: NodeJS.Timeout | undefined
            const armTimer = (): void => {
              if (timer !== undefined) return
              timer = setTimeout(() => {
                const handler = state.pending.get(id)
                handler?.cleanup?.()
                state.pending.delete(id)
                stopKernelIfIdle(kernelPath, state)
                reject(
                  new PythonRunnerError({
                    message: `warm kernel request timed out after ${timeoutMs}ms`,
                    detail: `filePath=${kernelPath} id=${id}`
                  })
                )
              }, 2 * timeoutMs + 5_000)
              timer.unref?.()
            }
            let cleanupStdinError: (() => void) | undefined
            let cleanupAbort: (() => void) | undefined
            state.pending.set(id, {
              resolve: (r) => {
                cleanupStdinError?.()
                cleanupAbort?.()
                releaseInflight()
                resolve(r)
              },
              reject: (e) => {
                cleanupStdinError?.()
                cleanupAbort?.()
                releaseInflight()
                reject(e)
              },
              timer,
              cleanup: () => {
                cleanupStdinError?.()
                cleanupAbort?.()
                releaseInflight()
              },
              ...(requestSink === undefined ? {} : { sink: requestSink }),
              nonce
            })
            const onAbort = () => {
              if (timer !== undefined) clearTimeout(timer)
              state.pending.delete(id)
              cleanupAbort?.()
              cleanupStdinError?.()
              releaseInflight()
              stopKernelIfIdle(kernelPath, state)
              reject(
                new PythonRunnerError({
                  message: "warm kernel request aborted",
                  detail: `filePath=${kernelPath} id=${id}`
                })
              )
            }
            if (options?.signal?.aborted) {
              onAbort()
              return
            }
            options?.signal?.addEventListener("abort", onAbort, { once: true })
            cleanupAbort = () =>
              options?.signal?.removeEventListener("abort", onAbort)
            try {
              const payload =
                JSON.stringify({ ...request, filePath: kernelPath, id, nonce }) + "\n"
              const stdin = state.proc.stdin
              if (!stdin || !stdin.writable) {
                state.pending.delete(id)
                clearTimeout(timer)
                reject(
                  new PythonRunnerError({
                    message: "kernel stdin is closed",
                    detail: `filePath=${filePath} id=${id}`
                  })
                )
                return
              }
              const onStdinError = (): void => {
                cleanupStdinError?.()
                cleanupAbort?.()
                state.pending.delete(id)
                clearTimeout(timer)
                reject(
                  new PythonRunnerError({
                    message: "kernel stdin is closed",
                    detail: `filePath=${filePath} id=${id}`
                  })
                )
              }
              stdin.once("error", onStdinError)
              cleanupStdinError = () => stdin.off("error", onStdinError)
              armTimer()
              stdin.write(payload)
            } catch (err) {
              cleanupStdinError?.()
              state.pending.delete(id)
              clearTimeout(timer)
              reject(
                new PythonRunnerError({
                  message: "failed to write to warm kernel stdin",
                  detail: err instanceof Error ? err.message : String(err)
                })
              )
            }
          }),
        catch: (err) =>
          err instanceof PythonRunnerError
            ? err
            : new PythonRunnerError({
                message: "warm kernel request failed",
                detail: err instanceof Error ? err.message : String(err)
              })
      })
      const parsed = RunResponseSchema.safeParse(raw)
      if (!parsed.success) {
        return yield* new PythonRunnerError({
          message: "warm kernel returned an invalid response",
          detail: parsed.error.issues
            .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("; ")
        })
      }
      const response = parsed.data
      if (!response.success && response.error) {
        const cap = Math.max(0, request.maxOutputChars ?? 6_000)
        const ename = response.error.ename.slice(0, cap)
        const evalue = response.error.evalue.slice(
          0,
          Math.max(0, cap - ename.length - 2)
        )
        return yield* new PythonRunnerError({
          message: `${ename}: ${evalue}`,
          detail: response.error.traceback
            .slice(0, 5)
            .map((line) => line.slice(0, cap))
            .join("\n")
            .slice(0, cap)
        })
      }
      state.requestsHandled++
      state.lastUsed = Date.now()
      totalRequests++
      return response
    })

  const isRunning = (filePath: string): boolean => {
    // States are keyed by canonicalPathForKernel, and its resolver and the
    // sync one below disagree on Windows 8.3 spellings (RUNNER~1 vs the long
    // name), so a fresh resolution can miss a kernel that is alive and well.
    // Consult the alias recorded at registration first — the same spelling the
    // state was stored under — and fall back to a fresh resolution only for
    // paths that were never executed through this manager.
    const aliased = canonicalAliases.get(filePath)
    if (aliased !== undefined) {
      const known = states.get(aliased)
      if (known !== undefined) return known.alive
    }
    const key = (() => {
      try {
        return realpathSync(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          currentSink()?.add(
            warningFrom("path-resolution", error, `kernel lookup for ${filePath}`)
          )
        }
        return filePath
      }
    })()
    const state = states.get(key)
    return !!state && state.alive
  }

  const list = (): ReadonlyArray<KernelInfo> => {
    const out: KernelInfo[] = []
    for (const state of states.values()) {
      if (!state.alive) continue
      out.push({
        // The spelling the caller last used, not the canonical key: the list
        // is user-facing and canonical paths differ from what was typed on
        // every platform that resolves symlinks or 8.3 short names.
        filePath: state.reportedPath,
        pid: state.pid,
        lastUsedAt: state.lastUsed,
        requestsHandled: state.requestsHandled,
        stderrTail: state.stderrTail.slice(-STDERR_TAIL_MAX).join("\n"),
        warnings: [...state.warnings]
      })
    }
    return out
  }

  const restart = (filePath: string): Effect.Effect<void, never> =>
    Effect.promise(async () => {
      await killKernel(filePath)
    })

  const shutdown = (filePath: string): Effect.Effect<void, never> =>
    Effect.promise(async () => {
      await killKernel(filePath)
    })

  const disposeAll = (): Effect.Effect<void, never> =>
    Effect.promise(async () => {
      const all = Array.from(states.keys())
      await Promise.all(all.map((k) => killKernel(k)))
      states.clear()
      canonicalAliases.clear()
    })

  const stats = (): KernelManagerStats => {
    let live = 0
    for (const state of states.values()) {
      if (state.alive) live++
    }
    return { liveKernels: live, totalRequests }
  }

  return {
    execute,
    isRunning,
    list,
    restart,
    shutdown,
    disposeAll,
    stats,
    setWarningSink: (next) => {
      sinkTarget.sink = next
    }
  }
}

export interface KernelManagerShape {
  readonly execute: (
    filePath: string,
    request: RunRequest,
    runtime?: KernelRuntimeOptions,
    options?: {
      readonly signal?: AbortSignal
      readonly warningSink?: WarningSink
    }
  ) => Effect.Effect<RunResponse, NotebookError>
  readonly isRunning: (filePath: string) => boolean
  readonly list: () => ReadonlyArray<KernelInfo>
  readonly restart: (filePath: string) => Effect.Effect<void, never>
  readonly shutdown: (filePath: string) => Effect.Effect<void, never>
  readonly disposeAll: () => Effect.Effect<void, never>
  readonly stats: () => KernelManagerStats
  readonly setWarningSink?: (sink: WarningSink | undefined) => void
}
