import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as fs from "node:fs"
import * as path from "node:path"
import * as readline from "node:readline"
import { Effect, Context } from "effect"
import { PythonRunnerError, type NotebookError } from "../domain/errors.js"
import { RunResponseSchema, type RunRequest, type RunResponse } from "../domain/execution.js"

export interface PythonProbeResult {
  readonly pythonPath: string
  readonly version: string
  readonly executable: string
  readonly from: "options" | "env" | "path-python" | "path-python3" | "none"
}

export interface DependencyCheck {
  readonly name: string
  readonly available: boolean
  readonly detail: string
}

export interface PythonDoctor {
  readonly selected: PythonProbeResult | undefined
  readonly candidates: ReadonlyArray<PythonProbeResult>
  readonly dependencies: ReadonlyArray<DependencyCheck>
  readonly helperPath: string | undefined
  readonly preferUv: boolean
  readonly suggestions: ReadonlyArray<string>
}

export interface PythonServiceOptions {
  readonly pythonPath: string | undefined
  readonly preferUv: boolean
  readonly helperRelativePath: string
}

export interface PythonServiceShape {
  readonly probe: () => Effect.Effect<PythonProbeResult, never>
  readonly candidates: () => Effect.Effect<ReadonlyArray<PythonProbeResult>, never>
  readonly checkDependencies: (
    pythonPath: string
  ) => Effect.Effect<ReadonlyArray<DependencyCheck>, never>
  readonly checkImport: (
    pythonPath: string,
    module: string
  ) => Effect.Effect<DependencyCheck, never>
  readonly findHelper: () => Effect.Effect<string | undefined, never>
  readonly doctor: () => Effect.Effect<PythonDoctor, never>
}

// Test-only surface: cache invalidation is an implementation detail of the
// dependency check, and consumers should not depend on it. Underscore prefix
// follows the same convention as Python's "private by convention".
export interface _PythonServiceForTest {
  readonly _invalidateDepsCache: (pythonPath?: string) => void
}

export class PythonService extends Context.Tag("@ipynb/PythonService")<
  PythonService,
  PythonServiceShape
>() {}

const PROBE_TIMEOUT_MS = 4_000
const REQUIRED_DEPS = ["nbformat", "nbclient", "jupyter_client", "ipykernel"] as const

const probeOnce = (executable: string): Promise<PythonProbeResult | null> =>
  new Promise((resolve) => {
    const child = spawn(executable, ["-c", "import sys; print(sys.executable); print(sys.version.split()[0])"], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(null)
    }, PROBE_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    child.on("error", () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve(null)
        return
      }
      const out = Buffer.concat(stdoutChunks).toString("utf8").trim()
      const lines = out.split(/\r?\n/)
      const exe = lines[0] ?? executable
      const version = lines[1] ?? "?"
      resolve({ pythonPath: exe, version, executable, from: "path-python" })
    })
  })

const probeWithFrom = async (
  executable: string,
  from: PythonProbeResult["from"]
): Promise<PythonProbeResult | null> => {
  const result = await probeOnce(executable)
  if (!result) return null
  return { ...result, from }
}

const checkImport = (pythonPath: string, module: string): Promise<DependencyCheck> =>
  new Promise((resolve) => {
    const child = spawn(
      pythonPath,
      ["-c", `import importlib, sys; m = importlib.import_module(${JSON.stringify(module)}); print(getattr(m, "__version__", "ok"))`],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve({ name: module, available: false, detail: "timeout" })
    }, PROBE_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ name: module, available: false, detail: err.message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        const version = Buffer.concat(stdoutChunks).toString("utf8").trim() || "ok"
        resolve({ name: module, available: true, detail: version })
      } else {
        const err = Buffer.concat(stderrChunks).toString("utf8").trim().split("\n").slice(-1)[0] ?? "missing"
        resolve({ name: module, available: false, detail: err })
      }
    })
  })

const __filename = fileURLToPath(import.meta.url)

let findHelperWarned = false

const findHelper = (rel: string): string | undefined => {
  const candidates: string[] = []
  if (process.cwd()) candidates.push(path.resolve(process.cwd(), rel))
  const distDir = path.dirname(__filename)
  candidates.push(path.resolve(distDir, "..", "..", rel))
  candidates.push(path.resolve(distDir, "..", "..", "..", rel))
  candidates.push(path.resolve(distDir, "..", rel))
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  // Log the candidates we tried so debugging layout issues is easier.
  // Project has no logging service yet; console.warn is the only signal
  // that survives in production. Deduped: chained tool calls would
  // otherwise spam the same warning on every invocation.
  if (!findHelperWarned) {
    findHelperWarned = true
    console.warn(
      `[opencode-ipynb] python helper not found. Checked these locations:\n` +
        candidates.map((c) => `  - ${c}`).join("\n") +
        `\nThe plugin ships the helper; reinstall via npm or run from a plugin checkout.`
    )
  }
  return undefined
}

const buildSuggestions = (
  doctor: Omit<PythonDoctor, "suggestions">,
  preferUv: boolean
): string[] => {
  const out: string[] = []
  if (!doctor.selected) {
    out.push(
      "No working Python interpreter was found. Set `ipynb.pythonPath` in opencode.json or `OPENCODE_IPYNB_PYTHON` env, or install Python on PATH."
    )
  }
  if (doctor.selected) {
    const missing = doctor.dependencies.filter((d) => !d.available).map((d) => d.name)
    if (missing.length > 0) {
      const cmd = preferUv ? "uv pip install" : "pip install"
      out.push(
        `Missing Python dependencies: ${missing.join(", ")}. Run: ${cmd} ${missing.join(" ")}`
      )
      if (preferUv) {
        out.push(
          "Tip: `uv` is preferred because it is fast and avoids touching the system Python. Install it from https://docs.astral.sh/uv/."
        )
      }
    }
  }
  if (!doctor.helperPath) {
    out.push(
      `Could not find python/ipynb_runner.py. Make sure you installed the plugin via npm (it ships the helper) or run from a checkout of the repository.`
    )
  }
  if (out.length === 0) {
    out.push("Everything looks good. You can run ipynb_run.")
  }
  return out
}

const makePythonImpl = (
  opts: PythonServiceOptions
): PythonServiceShape & _PythonServiceForTest => {
  const candidates: PythonProbeResult[] = []
  const probeAll = async (): Promise<PythonProbeResult[]> => {
    const list: PythonProbeResult[] = []
    if (opts.pythonPath) {
      const explicit = await probeWithFrom(opts.pythonPath, "options")
      if (explicit) list.push(explicit)
    }
    const envPy = process.env.OPENCODE_IPYNB_PYTHON
    if (envPy && envPy !== opts.pythonPath) {
      const env = await probeWithFrom(envPy, "env")
      if (env) list.push(env)
    }
    for (const exe of ["python", "python3"]) {
      const r = await probeWithFrom(exe, exe === "python" ? "path-python" : "path-python3")
      if (r) list.push(r)
    }
    return list
  }

  const probe = (): Effect.Effect<PythonProbeResult, never> =>
    Effect.gen(function* () {
      if (candidates.length === 0) {
        const fresh = yield* Effect.promise(() => probeAll())
        candidates.push(...fresh)
      }
      const first = candidates[0]
      if (!first) {
        return {
          pythonPath: opts.pythonPath ?? "python",
          version: "unknown",
          executable: opts.pythonPath ?? "python",
          from: "none"
        }
      }
      return first
    })

  const allCandidates = (): Effect.Effect<ReadonlyArray<PythonProbeResult>, never> =>
    Effect.gen(function* () {
      if (candidates.length === 0) {
        const fresh = yield* Effect.promise(() => probeAll())
        candidates.push(...fresh)
      }
      return candidates
    })

  // Dependency-check cache: `checkDependencies` spawns 4 Python subprocesses per
  // call, so without this a 200ms notebook run would pay >=1s of dep-probe
  // overhead on every `ipynb_run`. Keyed by pythonPath, with a 60s TTL.
  const DEPS_TTL_MS = 60_000
  interface DepsCacheEntry {
    readonly checkedAt: number
    readonly results: ReadonlyArray<DependencyCheck>
  }
  const depsCache = new Map<string, DepsCacheEntry>()

  const checkDeps = (
    pythonPath: string
  ): Effect.Effect<ReadonlyArray<DependencyCheck>, never> =>
    Effect.promise(async () => {
      const cached = depsCache.get(pythonPath)
      if (cached && Date.now() - cached.checkedAt < DEPS_TTL_MS) {
        return cached.results
      }
      const results = await Promise.all(REQUIRED_DEPS.map((m) => checkImport(pythonPath, m)))
      depsCache.set(pythonPath, { checkedAt: Date.now(), results })
      return results
    })

  const findHelperEff = (): Effect.Effect<string | undefined, never> =>
    Effect.sync(() => findHelper(opts.helperRelativePath))

  const doctor = (): Effect.Effect<PythonDoctor, never> =>
    Effect.gen(function* () {
      const cands = yield* allCandidates()
      const selected = cands[0]
      const deps = selected
        ? yield* checkDeps(selected.pythonPath)
        : (REQUIRED_DEPS.map((name) => ({ name, available: false, detail: "no python selected" })) as ReadonlyArray<DependencyCheck>)
      const helper = yield* findHelperEff()
      const draft: Omit<PythonDoctor, "suggestions"> = {
        selected,
        candidates: cands,
        dependencies: deps,
        helperPath: helper,
        preferUv: opts.preferUv
      }
      return { ...draft, suggestions: buildSuggestions(draft, opts.preferUv) }
    })

  return {
    probe,
    candidates: allCandidates,
    checkDependencies: checkDeps,
    checkImport: (pythonPath, module) => Effect.promise(() => checkImport(pythonPath, module)),
    findHelper: findHelperEff,
    doctor,
    _invalidateDepsCache: (pythonPath?: string) => {
      if (pythonPath === undefined) {
        depsCache.clear()
      } else {
        depsCache.delete(pythonPath)
      }
    }
  }
}

export const makePythonService = (opts: PythonServiceOptions): PythonServiceShape =>
  makePythonImpl(opts)

export { REQUIRED_DEPS, findHelper }

// ---------------------------------------------------------------------------
// v1.0 — KernelManager: long-lived Python subprocess per notebook path.
// ---------------------------------------------------------------------------

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
  pid: number
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

// Minimal deferred (resolve/reject are always assigned synchronously in the
// executor). Equivalent to Promise.withResolvers but typed against a custom
// error type without resorting to ``unknown``.
const createDeferred = <A, E>(): Deferred<A, E> => {
  let resolve!: (a: A) => void
  let reject!: (e: E) => void
  const promise = new Promise<A>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Sentinel resolved to the pending shutdown handler when the kernel exits
// cleanly. The shutdown call site ignores the value (`sendShutdown` always
// resolves its outer promise), so the only requirement is that it satisfies
// the RunResponse type. Keep it minimal: zero cells, zero duration.
const EMPTY_SHUTDOWN_RESPONSE = {
  success: true,
  executedCells: [] as ReadonlyArray<number>,
  durationMs: 0,
  outputs: [] as ReadonlyArray<unknown>
} as unknown as RunResponse

const killProc = (proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void => {
  try {
    proc.kill(signal)
  } catch {
    // proc may already be dead; ignore.
  }
}

export const makeKernelManager = (opts: KernelManagerOptions): KernelManagerShape => {
  const states = new Map<string, KernelState>()
  let totalRequests = 0

  const appendStderr = (state: KernelState, chunk: string): void => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue
      state.stderrTail.push(line)
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

  const spawnKernel = (filePath: string, runtime: KernelRuntimeOptions): KernelState => {
    const proc = spawn(
      runtime.pythonPath,
      [runtime.helperPath],
      {
        cwd: opts.workingDirectory ?? process.cwd(),
        stdio: ["pipe", "pipe", "pipe"]
      }
    )
    const startedAt = Date.now()
    // Build the ready-deferred promise up front so we can store the
    // resolve/reject closures on the state in one place — no second pass
    // after construction to wire them up.
    const readyDeferred = createDeferred<void, PythonRunnerError>()
    const state: KernelState = {
      proc,
      filePath,
      pythonPath: runtime.pythonPath,
      helperPath: runtime.helperPath,
      pid: proc.pid ?? -1,
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

    const rl = readline.createInterface({ input: proc.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (!msg || typeof msg !== "object") return
      const m = msg as Record<string, unknown>
      if (!state.readyResolved && m.ready === true) {
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
    })

    proc.stderr.on("data", (chunk: Buffer) => {
      appendStderr(state, chunk.toString("utf8"))
    })

    proc.on("close", (code, signal) => {
      state.alive = false
      // When the kernel exits cleanly (exit 0), there is no failure to
      // propagate for the shutdown request we sent ourselves; resolve it
      // immediately so we don't wait for its 2s safety-net timer to fire.
      // For non-zero or null exit codes, fall back to the standard failure
      // path. Any other pending request (a real `cell`/`all` call in flight
      // when the process died) must be failed explicitly so the caller sees
      // "kernel exited unexpectedly" instead of a bogus `null` response.
      if (code === 0) {
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
        return
      }
      failAllPending(
        state,
        "kernel subprocess exited",
        `code=${code ?? "?"} signal=${signal ?? "none"}`
      )
    })

    proc.on("error", (err) => {
      state.alive = false
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
    const runtime = runtimeFromRequest(runtimeInput)
    const existing = states.get(filePath)
    if (
      existing &&
      existing.alive &&
      existing.pythonPath === runtime.pythonPath &&
      existing.helperPath === runtime.helperPath
    ) {
      return existing
    }
    if (existing && existing.alive) {
      await killKernel(filePath)
    }
    if (existing && !existing.alive) {
      states.delete(filePath)
    }
    const state = spawnKernel(filePath, runtime)
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
      // Guard against a closed/destroyed stdin before writing. The
      // ``stdin?.write`` form silently no-ops on a missing stream but
      // emits EPIPE asynchronously when the stream is destroyed; that
      // becomes an uncaught error and crashes the plugin. Reject the
      // shutdown request immediately so killKernel can move on.
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
      // Attach a one-shot error handler so EPIPE / write-after-close
      // failures are swallowed instead of crashing the process.
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

  const killKernel = async (filePath: string): Promise<void> => {
    const state = states.get(filePath)
    if (!state) return
    states.delete(filePath)
    if (!state.alive) return
    await sendShutdown(state)
    if (state.alive) {
      killProc(state.proc, "SIGTERM")
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (state.alive) killProc(state.proc, "SIGKILL")
          resolve()
        }, 3_000)
        state.proc.once("close", () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  const execute = (
    filePath: string,
    request: RunRequest,
    runtime?: KernelRuntimeOptions
  ): Effect.Effect<RunResponse, NotebookError> =>
    Effect.gen(function* () {
      const state = yield* Effect.tryPromise({
        try: () => getOrStart(filePath, request, runtime),
        catch: (err) =>
          new PythonRunnerError({
            message: "failed to start warm kernel",
            detail: err instanceof Error ? err.message : String(err)
          })
      })
      yield* Effect.tryPromise({
        try: () => state.readyPromise,
        catch: (err) =>
          err instanceof PythonRunnerError
            ? err
            : new PythonRunnerError({
                message: "warm kernel failed to become ready",
                detail: err instanceof Error ? err.message : String(err)
              })
      })
      const id = state.nextId++
      const timeoutMs = request.timeoutMs ?? opts.defaultTimeoutMs
      const raw = yield* Effect.tryPromise<RunResponse, PythonRunnerError>({
        try: () =>
          new Promise<RunResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
              const handler = state.pending.get(id)
              handler?.cleanup?.()
              state.pending.delete(id)
              reject(
                new PythonRunnerError({
                  message: `warm kernel request timed out after ${timeoutMs}ms`,
                  detail: `filePath=${filePath} id=${id}`
                })
              )
            }, timeoutMs)
            state.pending.set(id, {
              resolve: (r) => {
                cleanupStdinError?.()
                resolve(r)
              },
              reject: (e) => {
                cleanupStdinError?.()
                reject(e)
              },
              timer,
              cleanup: () => cleanupStdinError?.()
            })
            let cleanupStdinError: (() => void) | undefined
            try {
              const payload = JSON.stringify({ id, ...request }) + "\n"
              // Guard against a closed stdin before writing. If the kernel
              // has already exited, the ``?.write`` form would silently
              // no-op and the request would sit in ``pending`` until the
              // timeout fired. Reject immediately with a clear cause.
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
              // One-shot error handler so a destroy-during-write (EPIPE)
              // is observed on the request and not as an uncaught
              // stream error that crashes the plugin.
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
              // ``write`` returns false when the internal buffer is full;
              // that is normal back-pressure, not an error. The data is
              // queued and Node will flush it. We only reject on a real
              // exception.
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
        return yield* new PythonRunnerError({
          message: `${response.error.ename}: ${response.error.evalue}`,
          detail: response.error.traceback.slice(0, 5).join("\n")
        })
      }
      state.requestsHandled++
      state.lastUsed = Date.now()
      totalRequests++
      return response
    })

  const isRunning = (filePath: string): boolean => {
    const state = states.get(filePath)
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
    runtime?: KernelRuntimeOptions
  ) => Effect.Effect<RunResponse, NotebookError>
  readonly isRunning: (filePath: string) => boolean
  readonly list: () => ReadonlyArray<KernelInfo>
  readonly restart: (filePath: string) => Effect.Effect<void, never>
  readonly shutdown: (filePath: string) => Effect.Effect<void, never>
  readonly disposeAll: () => Effect.Effect<void, never>
  readonly stats: () => KernelManagerStats
}

export class KernelManager extends Context.Tag("@ipynb/KernelManager")<
  KernelManager,
  KernelManagerShape
>() {}
