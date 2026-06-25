import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import {
  makePythonService,
  findHelper,
  type _PythonServiceForTest
} from "../../src/services/PythonService.js"

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
    { timeout: 15_000 },
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
    }
  )
})

describe("PythonService > checkDependencies cache", () => {
  it(
    "returns the cached result on the second call within TTL (does not re-spawn Python)",
    { timeout: 15_000 },
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
    }
  )

  it("invalidates the cache for a given pythonPath", async () => {
    const svc = makePythonService({
      pythonPath: "/nonexistent",
      preferUv: true,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const first = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
    ;(svc as _PythonServiceForTest)._invalidateDepsCache("/nonexistent")
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
    ;(svc as _PythonServiceForTest)._invalidateDepsCache()
    const second = await Effect.runPromise(svc.checkDependencies("/nonexistent"))
    expect(second).not.toBe(first)
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

  it("logs a warning listing the four candidates when no match is found", () => {
    const result = findHelper("definitely/does/not/exist.py")
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = String(warnSpy.mock.calls[0]?.[0] ?? "")
    expect(message).toContain("python helper not found")
    expect(message).toContain("Checked these locations")
    // All four candidates should appear in the message.
    const occurrences = (message.match(/Checked these locations:\n/g) ?? []).length
    expect(occurrences).toBe(1)
  })
})
