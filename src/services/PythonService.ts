import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { PermissionDeniedError } from "../domain/errors.js"
import { type WarningSink, warningFrom } from "../utils/warnings.js"

const HELPER_ENV_KEYS = [
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONINSPECT"
] as const

export const helperSpawnEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const key of HELPER_ENV_KEYS) delete env[key]
  return env
}

export const kernelEnvOverrides = (): Record<string, string> | undefined => {
  const out: Record<string, string> = {}
  for (const key of HELPER_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === "string") out[key] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

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
  readonly pythonSource?: "options" | "env" | undefined
}

export interface ProbeOptions {
  readonly warningSink?: WarningSink | undefined
}

export interface PythonServiceShape {
  readonly probe: (options?: ProbeOptions) => Effect.Effect<PythonProbeResult, never>
  readonly candidates: () => Effect.Effect<ReadonlyArray<PythonProbeResult>, never>
  readonly checkDependencies: (
    pythonPath: string
  ) => Effect.Effect<ReadonlyArray<DependencyCheck>, never>
  readonly checkImport: (
    pythonPath: string,
    module: string
  ) => Effect.Effect<DependencyCheck, never>
  readonly checkImports?: (
    pythonPath: string,
    modules: ReadonlyArray<string>,
    signal?: AbortSignal
  ) => Effect.Effect<ReadonlyArray<DependencyCheck>, never>
  readonly findHelper: () => Effect.Effect<string | undefined, never>
  readonly doctor: (
    beforeDependencies?: (
      selected: PythonProbeResult
    ) => Effect.Effect<void, PermissionDeniedError>
  ) => Effect.Effect<PythonDoctor, PermissionDeniedError>
}

export interface _PythonServiceForTest {
  readonly _invalidateDepsCache: (pythonPath?: string) => void
}

const MAX_PROBE_STDOUT_BYTES = 8 * 1024 * 1024
const PROBE_TIMEOUT_MS = 4_000
const REQUIRED_DEPS = ["nbformat", "nbclient", "jupyter_client", "ipykernel"] as const

const probeEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.PYTHONPATH
  delete env.PYTHONHOME
  return env
}

const probeOnce = (
  executable: string,
  onFailure?: (reason: string) => void
): Promise<PythonProbeResult | null> =>
  new Promise((resolve) => {
    const child = spawn(
      executable,
      ["-E", "-c", "import sys; print(sys.executable); print(sys.version.split()[0])"],
      {
        cwd: os.tmpdir(),
        env: probeEnv(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const kill = (): void => {
      if (child.pid === undefined) return
      if (process.platform === "win32") {
        child.kill("SIGKILL")
      } else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
    }
    const timer = setTimeout(() => {
      kill()
      onFailure?.(`timed out after ${PROBE_TIMEOUT_MS}ms`)
      resolve(null)
    }, PROBE_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_PROBE_STDOUT_BYTES) return
      const take = chunk.subarray(0, MAX_PROBE_STDOUT_BYTES - stdoutBytes)
      stdoutBytes += take.length
      stdoutChunks.push(take)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 4_000) return
      const take = chunk.subarray(0, 4_000 - stderrBytes)
      stderrBytes += take.length
      stderrChunks.push(take)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      const code = (error as NodeJS.ErrnoException).code
      onFailure?.(code ?? error.message)
      resolve(null)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
        onFailure?.(
          stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? `exited with code ${code}`
        )
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
  from: PythonProbeResult["from"],
  onFailure?: (reason: string) => void
): Promise<PythonProbeResult | null> => {
  const result = await probeOnce(executable, onFailure)
  if (!result) return null
  return { ...result, from }
}

const checkImport = (pythonPath: string, module: string): Promise<DependencyCheck> =>
  new Promise((resolve) => {
    const child = spawn(
      pythonPath,
      [
        "-E",
        "-c",
        `import sys
sys.path[:] = [p for p in sys.path if p not in ("", ".")]
import importlib.util, importlib.metadata
root = ${JSON.stringify(module)}.split(".")[0]
try:
    spec = importlib.util.find_spec(root)
except Exception:
    spec = None
if spec is None:
    raise SystemExit(1)
try:
    print(importlib.metadata.version(${JSON.stringify(module)}))
except Exception:
    print("ok")`
      ],
      {
        cwd: os.tmpdir(),
        env: probeEnv(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const kill = (): void => {
      if (child.pid === undefined) return
      if (process.platform === "win32") {
        child.kill("SIGKILL")
      } else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
    }
    const timer = setTimeout(() => {
      kill()
      resolve({ name: module, available: false, detail: "timeout" })
    }, PROBE_TIMEOUT_MS)
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_PROBE_STDOUT_BYTES) return
      const take = chunk.subarray(0, MAX_PROBE_STDOUT_BYTES - stdoutBytes)
      stdoutBytes += take.length
      stdoutChunks.push(take)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 4_000) return
      const take = chunk.subarray(0, 4_000 - stderrBytes)
      stderrBytes += take.length
      stderrChunks.push(take)
    })
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


const checkImportsChunk = (
  pythonPath: string,
  modules: ReadonlyArray<string>,
  signal?: AbortSignal
): Promise<ReadonlyArray<DependencyCheck>> =>
  new Promise((resolve) => {
    if (modules.length === 0) {
      resolve([])
      return
    }
    const roots = [...new Set(modules.map((m) => m.split(".")[0]!))]
    if (signal?.aborted) {
      resolve(roots.map((name) => ({ name, available: false, detail: "aborted" })))
      return
    }
    const child = spawn(
      pythonPath,
      [
        "-E",
        "-c",
        `import sys
sys.path[:] = [p for p in sys.path if p not in ("", ".")]
import os, json, importlib.util, importlib.metadata
out = {}
for root in json.loads(os.environ.get("OPENCODE_IPYNB_MODULES", "[]")):
    try:
        spec = importlib.util.find_spec(root)
    except Exception:
        spec = None
    if spec is None:
        out[root] = {"available": False, "detail": "not found"}
        continue
    try:
        out[root] = {"available": True, "detail": importlib.metadata.version(root)}
    except Exception:
        out[root] = {"available": True, "detail": "ok"}
print(json.dumps(out))`
      ],
      {
        cwd: os.tmpdir(),
        env: { ...probeEnv(), OPENCODE_IPYNB_MODULES: JSON.stringify(roots) },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"]
      }
    )
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    const kill = (): void => {
      if (child.pid === undefined) return
      if (process.platform === "win32") {
        child.kill("SIGKILL")
      } else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
    }
    const unavailable = (detail: string): ReadonlyArray<DependencyCheck> =>
      roots.map((name) => ({ name, available: false, detail }))
    const timeoutMs = Math.min(
      30_000,
      PROBE_TIMEOUT_MS + roots.length * 100
    )
    const timer = setTimeout(() => {
      kill()
      resolve(unavailable("timeout"))
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      kill()
      resolve(unavailable("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= MAX_PROBE_STDOUT_BYTES) return
      const take = chunk.subarray(0, MAX_PROBE_STDOUT_BYTES - stdoutBytes)
      stdoutBytes += take.length
      stdoutChunks.push(take)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 4_000) return
      const take = chunk.subarray(0, 4_000 - stderrBytes)
      stderrBytes += take.length
      stderrChunks.push(take)
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve(unavailable(err.message))
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (code !== 0) {
        const detail =
          Buffer.concat(stderrChunks).toString("utf8").trim().split("\n").slice(-1)[0] ??
          "missing"
        resolve(unavailable(detail))
        return
      }
      try {
        const parsed = JSON.parse(
          Buffer.concat(stdoutChunks).toString("utf8").trim()
        ) as Record<string, { available?: boolean; detail?: unknown }>
        resolve(
          roots.map((name) => ({
            name,
            available: parsed[name]?.available === true,
            detail:
              typeof parsed[name]?.detail === "string"
                ? String(parsed[name]!.detail)
                : "ok"
          }))
        )
      } catch {
        resolve(unavailable("invalid output"))
      }
    })
  })

const IMPORTS_BATCH_SIZE = 128

const checkImportsBatch = async (
  pythonPath: string,
  modules: ReadonlyArray<string>,
  signal?: AbortSignal
): Promise<ReadonlyArray<DependencyCheck>> => {
  const roots = [...new Set(modules.map((m) => m.split(".")[0]!))]
  const checks: DependencyCheck[] = []
  const tooLong: DependencyCheck[] = roots
    .filter((name) => name.length > 256)
    .map((name) => ({
      name,
      available: false,
      detail: "module name is too long"
    }))
  checks.push(...tooLong)
  const usable = roots.filter((name) => name.length <= 256)
  const envBudget = process.platform === "win32" ? 16_000 : 60_000
  const chunks: string[][] = []
  let current: string[] = []
  let currentBytes = 2
  for (const name of usable) {
    const size = JSON.stringify(name).length + 3
    if (
      current.length > 0 &&
      (current.length >= IMPORTS_BATCH_SIZE ||
        currentBytes + size > envBudget)
    ) {
      chunks.push(current)
      current = []
      currentBytes = 2
    }
    current.push(name)
    currentBytes += size
  }
  if (current.length > 0) chunks.push(current)
  for (const chunk of chunks) {
    if (signal?.aborted) break
    try {
      checks.push(...(await checkImportsChunk(pythonPath, chunk, signal)))
    } catch (error) {
      checks.push(
        ...chunk.map((name) => ({
          name,
          available: false,
          detail: `spawn failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        }))
      )
    }
  }
  const byName = new Map(checks.map((check) => [check.name, check]))
  return roots.map(
    (name) =>
      byName.get(name) ?? {
        name,
        available: false,
        detail: signal?.aborted === true ? "aborted" : "not checked"
      }
  )
}

export const pythonInterpreterResources = (
  configured?: string
): ReadonlyArray<string> => {
  const names =
    process.platform === "win32"
      ? ["python.exe", "python3.exe"]
      : ["python", "python3"]
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const out = new Set<string>()
  const add = (candidate: string): boolean => {
    try {
      if (!fs.statSync(candidate).isFile()) return false
    } catch {
      return false
    }
    out.add(candidate)
    try {
      out.add(fs.realpathSync(candidate))
    } catch {
    }
    return true
  }
  if (configured !== undefined && configured.length > 0) {
    if (path.isAbsolute(configured)) {
      add(configured)
    } else {
      const configuredNames =
        process.platform === "win32" && !configured.endsWith(".exe")
          ? [configured, `${configured}.exe`]
          : [configured]
      outer: for (const name of configuredNames) {
        for (const dir of dirs) {
          if (!path.isAbsolute(dir)) continue
          const candidate = path.join(dir, name)
          try {
            fs.accessSync(candidate, fs.constants.X_OK)
            if (add(candidate)) break outer
          } catch {
          }
        }
      }
    }
    return [...out]
  }
  for (const name of names) {
    let found = false
    for (const dir of dirs) {
      if (!path.isAbsolute(dir)) continue
      const candidate = path.join(dir, name)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        if (add(candidate)) {
          found = true
          break
        }
      } catch {
      }
    }
    if (found) break
  }
  return [...out]
}

export const pathPythonCandidates = (): ReadonlyArray<string> =>
  pythonInterpreterResources().filter((value) => {
    try {
      return fs.realpathSync(value) === value
    } catch {
      return false
    }
  })

const __filename = fileURLToPath(import.meta.url)

let findHelperWarned = false

const findHelper = (rel: string): string | undefined => {
  const candidates: string[] = []
  if (path.isAbsolute(rel)) {
    candidates.push(rel)
  } else {
    const distDir = path.dirname(__filename)
    candidates.push(
      path.basename(distDir) === "dist"
        ? path.resolve(distDir, "..", rel)
        : path.resolve(distDir, "..", "..", rel)
    )
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
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
      "No working Python interpreter was found. Set the plugin `pythonPath` option or `OPENCODE_IPYNB_PYTHON` env, or install Python on PATH."
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
  const selectedSpecs = (): Array<{
    readonly executable: string
    readonly from: PythonProbeResult["from"]
  }> => {
    const configured = opts.pythonPath
    if (configured !== undefined && configured.length > 0) {
      if (path.isAbsolute(configured)) {
        return [{ executable: configured, from: opts.pythonSource ?? "options" }]
      }
      if (/[\\/]/.test(configured)) return []
      const resolved = pythonInterpreterResources(configured)[0]
      return resolved === undefined
        ? []
        : [{ executable: resolved, from: opts.pythonSource ?? "options" }]
    }
    const first = pythonInterpreterResources()[0]
    if (first === undefined) return []
    const name = path.basename(first).toLowerCase()
    return [
      {
        executable: first,
        from: name.startsWith("python3")
          ? "path-python3"
          : "path-python"
      }
    ]
  }

  const probeAll = async (): Promise<PythonProbeResult[]> => {
    const specs = selectedSpecs()
    const list = (
      await Promise.all(
        specs.map((spec) => probeWithFrom(spec.executable, spec.from))
      )
    ).filter((item): item is PythonProbeResult => item !== null)
    const seen = new Set<string>()
    return list.filter((item) => {
      const key = path.resolve(item.executable)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  const PROBE_TTL_MS = 60_000
  let candidatesCheckedAt = 0
  let probed = false
  let selectedProbe: PythonProbeResult | undefined
  let selectedCheckedAt = 0
  let selectedProbed = false
  let configuredProbeFailure: string | undefined

  const warnConfiguredProbeFailure = (sink: WarningSink): void => {
    const configured = opts.pythonPath
    if (configured === undefined || configured.length === 0) return
    sink.add(
      warningFrom(
        "python-probe",
        new Error(
          configuredProbeFailure ??
            "the configured python interpreter did not run"
        ),
        `pythonPath=${configured}`
      )
    )
  }

  const probe = (options?: ProbeOptions): Effect.Effect<PythonProbeResult, never> =>
    Effect.gen(function* () {
      const sink = options?.warningSink
      const now = Date.now()
      if (
        probed &&
        candidates.length > 0 &&
        now - candidatesCheckedAt < PROBE_TTL_MS
      ) {
        selectedProbe = candidates[0]!
        selectedCheckedAt = now
        selectedProbed = true
        return selectedProbe
      }
      if (selectedProbed && now - selectedCheckedAt < PROBE_TTL_MS) {
        if (sink !== undefined) warnConfiguredProbeFailure(sink)
        return selectedProbe!
      }
      const specs = selectedSpecs()
      for (const attempt of specs) {
        const found = yield* Effect.promise(() =>
          probeWithFrom(attempt.executable, attempt.from, (reason) => {
            configuredProbeFailure = reason
          })
        )
        if (found) {
          configuredProbeFailure = undefined
          selectedProbe = found
          selectedCheckedAt = Date.now()
          selectedProbed = true
          return found
        }
      }
      if (specs.length === 0) {
        configuredProbeFailure =
          "the configured path is not an absolute interpreter or PATH name"
      }
      selectedProbe = {
        pythonPath: opts.pythonPath ?? "python",
        version: "unknown",
        executable: opts.pythonPath ?? "python",
        from: "none"
      }
      selectedCheckedAt = Date.now()
      selectedProbed = true
      if (sink !== undefined) warnConfiguredProbeFailure(sink)
      return selectedProbe
    })
  const allCandidates = (): Effect.Effect<ReadonlyArray<PythonProbeResult>, never> =>
    Effect.gen(function* () {
      if (!probed || Date.now() - candidatesCheckedAt >= PROBE_TTL_MS) {
        candidates.length = 0
        const fresh = yield* Effect.promise(() => probeAll())
        candidates.push(...fresh)
        candidatesCheckedAt = Date.now()
        probed = true
      }
      return candidates
    })

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

  const doctor = (
    beforeDependencies?: (
      selected: PythonProbeResult
    ) => Effect.Effect<void, PermissionDeniedError>
  ): Effect.Effect<PythonDoctor, PermissionDeniedError> =>
    Effect.gen(function* () {
      const cands = yield* allCandidates()
      const selected = cands[0]
      if (selected !== undefined && beforeDependencies !== undefined) {
        yield* beforeDependencies(selected)
      }
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
    checkImports: (pythonPath, modules, signal) =>
      Effect.promise(() => checkImportsBatch(pythonPath, modules, signal)),
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
