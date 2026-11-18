import { spawn, type ChildProcess } from "node:child_process"
import { killWindowsTree } from "../utils/windows.js"
import { promises as fsp, realpathSync } from "node:fs"
import { Effect } from "effect"
import { StringDecoder } from "node:string_decoder"
import { PythonRunnerError, type NotebookError } from "../domain/errors.js"
import {
  RunResponseSchema,
  type RunRequest,
  type RunResponse
} from "../domain/execution.js"
import { helperSpawnEnv } from "./PythonService.js"
import { MAX_HELPER_STDOUT_BYTES } from "../utils/limits.js"


export interface KernelManagerOptions {
  readonly pythonPath: string
  readonly helperPath: string
  readonly workingDirectory: string | undefined
  readonly defaultTimeoutMs: number
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
}

export interface KernelManagerStats {
  readonly liveKernels: number
  readonly totalRequests: number
}

interface PendingRequest {
  resolve: (response: RunResponse) => void
  reject: (err: PythonRunnerError) => void
  timer: NodeJS.Timeout
  cleanup?: () => void
}

interface KernelState {
  proc: ChildProcess
  filePath: string
  pythonPath: string
  helperPath: string
  requestedKernel: string | undefined
  pid: number
  kernelPid: number | undefined
  nextId: number
  pending: Map<number, PendingRequest>
  readyPromise: Promise<void>
  resolveReady: () => void
  rejectReady: (err: PythonRunnerError) => void
  readyResolved: boolean
  lastUsed: number
  requestsHandled: number
  stderrTail: string[]
  alive: boolean
  startedAt: number
  shutdownRequestId: number | undefined
}

const STDERR_TAIL_MAX = 20

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

const killPidTree = (
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGTERM"
): void => {
  if (pid === undefined || pid <= 0) return
  if (process.platform === "win32") {
    killWindowsTree(pid)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
    }
  }
}

const killProcessTree = (
  proc: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  kernelPid?: number
): void => {
  killPidTree(kernelPid, signal)
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
    } catch {
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
  const kernelLocks = new Map<string, Promise<void>>()
  let totalRequests = 0

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
      pythonPath: runtime.pythonPath,
      helperPath: runtime.helperPath,
      requestedKernel,
      pid: proc.pid ?? -1,
      kernelPid: undefined,
      nextId: 1,
      pending: new Map(),
      readyPromise: readyDeferred.promise,
      resolveReady: readyDeferred.resolve,
      rejectReady: readyDeferred.reject,
      readyResolved: false,
      lastUsed: startedAt,
      requestsHandled: 0,
      stderrTail: [],
      alive: true,
      startedAt,
      shutdownRequestId: undefined
    }

    const handleLine = (line: string): void => {
      if (!line.trim()) return
      if (line.length > MAX_HELPER_STDOUT_BYTES) {
        for (const handler of state.pending.values()) {
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
      } catch {
        return
      }
      if (!msg || typeof msg !== "object") return
      const m = msg as Record<string, unknown>
      if (!state.readyResolved && m.ready === true) {
        if (typeof m.kernelPid === "number" && m.kernelPid > 0) {
          state.kernelPid = m.kernelPid
        }
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
        } catch {
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
        killProcessTree(proc, "SIGKILL", state.kernelPid)
        return
      }
      killProcessTree(proc, "SIGKILL", state.kernelPid)
      failAllPending(
        state,
        "kernel subprocess exited",
        `code=${code ?? "?"} signal=${signal ?? "none"}`
      )
    })

    proc.on("error", (err) => {
      state.alive = false
      killProcessTree(proc, "SIGKILL", state.kernelPid)
      failAllPending(state, "kernel subprocess error", err.message)
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
    const key = await canonicalPath(filePath)
    return withKernelLock(key, () =>
      getOrStartUnlocked(key, request, runtimeFromRequest(runtimeInput))
    )
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
      states.delete(filePath)
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

  const canonicalPath = (filePath: string): Promise<string> =>
    fsp.realpath(filePath).catch(() => filePath)

  const killKernel = async (inputPath: string): Promise<void> => {
    const filePath = await canonicalPath(inputPath)
    return withKernelLock(filePath, () => killKernelUnlocked(filePath))
  }

  const killKernelUnlocked = async (filePath: string): Promise<void> => {
    const state = states.get(filePath)
    if (!state) return
    states.delete(filePath)
    if (!state.alive) return
    await sendShutdown(state)
    if (state.alive) {
      killProcessTree(state.proc, "SIGTERM", state.kernelPid)
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (state.alive) killProcessTree(state.proc, "SIGKILL", state.kernelPid)
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
    options?: { readonly signal?: AbortSignal }
  ) {
      const kernelPath = yield* Effect.promise(() => canonicalPath(filePath))
      if (options?.signal?.aborted) {
        return yield* new PythonRunnerError({
          message: "warm kernel request aborted",
          detail: `filePath=${kernelPath}`
        })
      }
      const state = yield* Effect.tryPromise({
        try: () => getOrStart(kernelPath, request, runtime),
        catch: (err) =>
          new PythonRunnerError({
            message: "failed to start warm kernel",
            detail: err instanceof Error ? err.message : String(err)
          })
      })
      const timeoutMs = request.timeoutMs ?? opts.defaultTimeoutMs
      yield* Effect.tryPromise({
        try: () =>
          withTimeout(
            state.readyPromise,
            timeoutMs,
            "warm kernel did not become ready before the timeout",
            options?.signal,
            () => void killKernel(kernelPath)
          ),
        catch: (err) =>
          err instanceof PythonRunnerError
            ? err
            : new PythonRunnerError({
                message: "warm kernel failed to become ready",
                detail: err instanceof Error ? err.message : String(err)
              })
      })
      const id = state.nextId++
      const raw = yield* Effect.tryPromise<RunResponse, PythonRunnerError>({
        try: () =>
          new Promise<RunResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
              const handler = state.pending.get(id)
              handler?.cleanup?.()
              state.pending.delete(id)
              void killKernel(kernelPath)
              reject(
                new PythonRunnerError({
                  message: `warm kernel request timed out after ${timeoutMs}ms`,
                  detail: `filePath=${kernelPath} id=${id}`
                })
              )
            }, timeoutMs + 5_000)
            let cleanupStdinError: (() => void) | undefined
            let cleanupAbort: (() => void) | undefined
            state.pending.set(id, {
              resolve: (r) => {
                cleanupStdinError?.()
                cleanupAbort?.()
                resolve(r)
              },
              reject: (e) => {
                cleanupStdinError?.()
                cleanupAbort?.()
                reject(e)
              },
              timer,
              cleanup: () => {
                cleanupStdinError?.()
                cleanupAbort?.()
              }
            })
            const onAbort = () => {
              clearTimeout(timer)
              state.pending.delete(id)
              cleanupAbort?.()
              void killKernel(kernelPath)
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
              const payload = JSON.stringify({ id, ...request }) + "\n"
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
    const key = (() => {
      try {
        return realpathSync(filePath)
      } catch {
        return filePath
      }
    })()
    const state = states.get(key)
    return !!state && state.alive
  }

  const list = (): ReadonlyArray<KernelInfo> => {
    const out: KernelInfo[] = []
    for (const [filePath, state] of states) {
      if (!state.alive) continue
      out.push({
        filePath,
        pid: state.pid,
        lastUsedAt: state.lastUsed,
        requestsHandled: state.requestsHandled,
        stderrTail: state.stderrTail.slice(-STDERR_TAIL_MAX).join("\n")
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
    stats
  }
}

export interface KernelManagerShape {
  readonly execute: (
    filePath: string,
    request: RunRequest,
    runtime?: KernelRuntimeOptions,
    options?: { readonly signal?: AbortSignal }
  ) => Effect.Effect<RunResponse, NotebookError>
  readonly isRunning: (filePath: string) => boolean
  readonly list: () => ReadonlyArray<KernelInfo>
  readonly restart: (filePath: string) => Effect.Effect<void, never>
  readonly shutdown: (filePath: string) => Effect.Effect<void, never>
  readonly disposeAll: () => Effect.Effect<void, never>
  readonly stats: () => KernelManagerStats
}
