import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  makePythonService,
  findHelper,
  type _PythonServiceForTest
} from "../../src/services/PythonService.js"
import { buildServices, disposeSharedKernelManager } from "../../src/services/index.js"
import type { ToolContext } from "../../src/tool.js"

describe("PythonService", () => {
  it("candidates returns an array (possibly empty)", async () => {
    const svc = makePythonService({
      pythonPath: undefined,
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const cands = await Effect.runPromise(svc.candidates())
    expect(Array.isArray(cands)).toBe(true)
  })

  it("doctor reports dependencies with availability flags", async () => {
    const svc = makePythonService({
      pythonPath: undefined,
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const doctor = await Effect.runPromise(svc.doctor())
    expect(Array.isArray(doctor.dependencies)).toBe(true)
    expect(doctor.dependencies.length).toBeGreaterThan(0)
    for (const dep of doctor.dependencies) {
      expect(typeof dep.available).toBe("boolean")
      expect(typeof dep.name).toBe("string")
    }
    expect(Array.isArray(doctor.suggestions)).toBe(true)
  })

  it("checkDependencies rejects an obviously bad path with a graceful result", async () => {
    const svc = makePythonService({
      pythonPath: undefined,
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const checks = await Effect.runPromise(
      svc.checkDependencies("this-python-does-not-exist-xyz")
    )
    expect(checks.every((c) => !c.available)).toBe(true)
  })

  it(
    "preferUv toggles the suggestion text",
    async () => {
      const svcUv = makePythonService({
        pythonPath: "/nonexistent",
        preferUv: true,
        helperRelativePath: "python/ipynb_runner.py"
      })
      const doctorUv = await Effect.runPromise(svcUv.doctor())
      expect(doctorUv.preferUv).toBe(true)

      const svcPip = makePythonService({
        pythonPath: "/nonexistent",
        preferUv: false,
        helperRelativePath: "python/ipynb_runner.py"
      })
      const doctorPip = await Effect.runPromise(svcPip.doctor())
      expect(doctorPip.preferUv).toBe(false)
    },
    15_000
  )
})

describe("PythonService > checkDependencies cache", () => {
  it(
    "returns the cached result on the second call within TTL (does not re-spawn Python)",
    async () => {
      const svc = makePythonService({
        pythonPath: "/nonexistent",
        preferUv: true,
        helperRelativePath: "python/ipynb_runner.py"
      })
      const first = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
      const start = Date.now()
      const second = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
      const elapsed = Date.now() - start
      expect(second).toBe(first)
      // The cached call should be effectively instant; allow a generous
      // bound for slow CI but flag the obvious case where we re-spawned.
      expect(elapsed).toBeLessThan(50)
    },
    15_000
  )

  it("invalidates the cache for a given pythonPath", async () => {
    const svc = makePythonService({
      pythonPath: "/nonexistent",
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const first = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
    ;(svc as unknown as _PythonServiceForTest)._invalidateDepsCache("/nonexistent")
    const second = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
    // Re-probe returns a fresh array (same shape, different identity).
    expect(second).not.toBe(first)
    expect(second.length).toBe(first.length)
  })

  it("clears the entire cache when called with no argument", async () => {
    const svc = makePythonService({
      pythonPath: "/nonexistent",
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const first = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
    ;(svc as unknown as _PythonServiceForTest)._invalidateDepsCache()
    const second = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
    expect(second).not.toBe(first)
  })
})

describe("PythonService > probe cache", () => {
  it("caches the no-interpreter result within the TTL", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-probe-"))
    const log = path.join(dir, "calls.log")
    const script = path.join(dir, "python")
    fs.writeFileSync(script, `#!/bin/sh\nprintf 'x\\n' >> "${log}"\nexit 1\n`)
    fs.chmodSync(script, 0o755)
    const previousPath = process.env.PATH
    const previousPython = process.env.OPENCODE_IPYNB_PYTHON
    process.env.PATH = dir
    delete process.env.OPENCODE_IPYNB_PYTHON
    const svc = makePythonService({
      pythonPath: undefined,
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    try {
      const first = await Effect.runPromise(svc.probe())
      const second = await Effect.runPromise(svc.probe())
      expect(first.from).toBe("none")
      expect(second.from).toBe("none")
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1)
    } finally {
      process.env.PATH = previousPath
      if (previousPython === undefined) {
        delete process.env.OPENCODE_IPYNB_PYTHON
      } else {
        process.env.OPENCODE_IPYNB_PYTHON = previousPython
      }
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("PythonService > shared instance", () => {  it("reuses the Python service across buildServices calls with the same options", () => {
    const ctx = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    } as unknown as ToolContext

    const first = buildServices(ctx)
    const second = buildServices(ctx)
    expect(first.python).toBe(second.python)
  })

  it("scopes warm-kernel managers per plugin instance", async () => {
    const base = {
      sessionID: "test",
      messageID: "test",
      agent: "test",
      directory: process.cwd(),
      worktree: process.cwd(),
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }
    const scopeA = {}
    const scopeB = {}
    const ctxA = { ...base, pluginScope: scopeA } as unknown as ToolContext
    const ctxB = { ...base, pluginScope: scopeB } as unknown as ToolContext

    const managerA = buildServices(ctxA).kernel
    const managerB = buildServices(ctxB).kernel
    expect(managerA).not.toBe(managerB)
    expect(buildServices(ctxA).kernel).toBe(managerA)

    await disposeSharedKernelManager(scopeA)
    expect(buildServices(ctxB).kernel).toBe(managerB)

    await disposeSharedKernelManager(scopeB)
  })
})

describe("findHelper", () => {
  let warnSpy: ReturnType<typeof spyOn>
  let existsSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    existsSpy = spyOn(fs, "existsSync").mockReturnValue(false)
  })
  afterEach(() => {
    warnSpy.mockRestore()
    existsSpy.mockRestore()
  })

  it("logs a warning listing the candidates when no match is found", () => {
    const result = findHelper("definitely/does/not/exist.py")
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0]?.[0] ?? "")
    expect(message).toContain("python helper not found")
    expect(message).toContain("Checked these locations")
    // The warning should list the candidates once.
    const occurrences = (message.match(/Checked these locations:\n/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})

describe("PythonService > project shadowing", () => {
  it("does not import a project-local module during dependency probes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-probe-shadow-"))
    const marker = path.join(dir, "PWNED")
    const module = "shadow_probe_xyz"
    fs.writeFileSync(
      path.join(dir, `${module}.py`),
      `import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text("ran")\n`
    )
    const previous = process.cwd()
    process.chdir(dir)
    try {
      const svc = makePythonService({
        pythonPath: "python",
        preferUv: true,
        helperRelativePath: "python/ipynb_runner.py"
      })
      const check = await Effect.runPromise(svc.checkImport("python", module))
      expect(check.available).toBe(false)
      expect(fs.existsSync(marker)).toBe(false)
    } finally {
      process.chdir(previous)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("prefers the shipped helper over a project-local python/ipynb_runner.py", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-helper-shadow-"))
    const projectHelper = path.join(dir, "python", "ipynb_runner.py")
    fs.mkdirSync(path.dirname(projectHelper), { recursive: true })
    fs.writeFileSync(projectHelper, "print('evil')\n")
    const previous = process.cwd()
    process.chdir(dir)
    try {
      const helper = findHelper("python/ipynb_runner.py")
      expect(helper).toBeDefined()
      expect(helper).not.toBe(projectHelper)
    } finally {
      process.chdir(previous)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
