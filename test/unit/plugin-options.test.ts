import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makePathService } from "../../src/services/PathService.js"
import { parsePluginOptions, resolvePythonPath, type PluginOptions } from "../../src/plugin-options.js"
import { resolveToolOptions } from "../../src/tools/_resolveOptions.js"
import { buildServices, resolveOptionsFromEnv } from "../../src/services/index.js"
import type { ToolContext } from "../../src/tool.js"

const ENV_VAR = "OPENCODE_IPYNB_OPTIONS"
const ORIGINAL_ENV = process.env[ENV_VAR]

const setEnv = (value: string | undefined) => {
  if (value === undefined) {
    delete process.env[ENV_VAR]
  } else {
    process.env[ENV_VAR] = value
  }
}

describe("PluginOptions defaults", () => {
  it("parses empty input to the documented defaults", () => {
    const parsed = parsePluginOptions({})
    expect(parsed.preferUv).toBe(true)
    expect(parsed.helperRelativePath).toBe("python/ipynb_runner.py")
    expect(parsed.defaultTimeoutMs).toBe(120_000)
    expect(parsed.defaultMaxOutputChars).toBe(6_000)
    expect(parsed.allowOutsideWorktree).toBeUndefined()
  })

  it("treats null and undefined input the same as empty", () => {
    const fromNull = parsePluginOptions(null)
    const fromUndefined = parsePluginOptions(undefined)
    expect(fromNull.defaultMaxOutputChars).toBe(6_000)
    expect(fromUndefined.defaultMaxOutputChars).toBe(6_000)
    expect(fromNull.allowOutsideWorktree).toBeUndefined()
    expect(fromUndefined.allowOutsideWorktree).toBeUndefined()
  })
})

describe("PluginOptions overrides", () => {
  it("honors allowOutsideWorktree: true", () => {
    const parsed = parsePluginOptions({ allowOutsideWorktree: true })
    expect(parsed.allowOutsideWorktree).toBe(true)
  })

  it("honors a custom defaultMaxOutputChars", () => {
    const parsed = parsePluginOptions({ defaultMaxOutputChars: 12_345 })
    expect(parsed.defaultMaxOutputChars).toBe(12_345)
  })

  it("merges a partial override with fallback defaults", () => {
    const parsed = parsePluginOptions(
      { allowOutsideWorktree: true },
      { preferUv: false, helperRelativePath: "alt/helper.py" }
    )
    expect(parsed.allowOutsideWorktree).toBe(true)
    expect(parsed.preferUv).toBe(false)
    expect(parsed.helperRelativePath).toBe("alt/helper.py")
    expect(parsed.defaultMaxOutputChars).toBe(6_000)
  })

  it("rejects a negative defaultMaxOutputChars", () => {
    let caught: unknown
    try {
      parsePluginOptions({ defaultMaxOutputChars: -1 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
  })

  it("rejects a non-integer defaultMaxOutputChars", () => {
    let caught: unknown
    try {
      parsePluginOptions({ defaultMaxOutputChars: 2.5 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
  })
})

describe("resolveToolOptions", () => {
  beforeEach(() => {
    setEnv(ORIGINAL_ENV)
  })
  afterEach(() => {
    setEnv(ORIGINAL_ENV)
  })

  it("returns defaults when the env var is not set", () => {
    setEnv(undefined)
    const opts: PluginOptions = resolveToolOptions()
    expect(opts.defaultMaxOutputChars).toBe(6_000)
    expect(opts.preferUv).toBe(true)
    expect(opts.allowOutsideWorktree).toBeUndefined()
  })

  it("returns defaults when the env var is empty", () => {
    setEnv("")
    const opts = resolveToolOptions()
    expect(opts.defaultMaxOutputChars).toBe(6_000)
    expect(opts.preferUv).toBe(true)
  })

  it("parses the env var when it is valid JSON", () => {
    setEnv(JSON.stringify({ defaultMaxOutputChars: 9_999, allowOutsideWorktree: true }))
    const opts = resolveToolOptions()
    expect(opts.defaultMaxOutputChars).toBe(9_999)
    expect(opts.allowOutsideWorktree).toBe(true)
    expect(opts.preferUv).toBe(true)
  })

  it("falls back to defaults when the env var is invalid JSON", () => {
    setEnv("not-valid-json-{")
    const opts = resolveToolOptions()
    expect(opts.defaultMaxOutputChars).toBe(6_000)
    expect(opts.allowOutsideWorktree).toBeUndefined()
  })

  it("falls back to instance options when the env schema is invalid", () => {
    setEnv('{"defaultTimeoutMs":-1}')
    const first = resolveOptionsFromEnv({ pythonPath: "/opt/python-a" })
    const second = resolveOptionsFromEnv({ pythonPath: "/opt/python-b" })
    expect(first.pythonPath).toBe("/opt/python-a")
    expect(second.pythonPath).toBe("/opt/python-b")
  })

  it("does not leak one instance's fallback when the env var is invalid", () => {
    setEnv("not-valid-json-{")
    const first = resolveOptionsFromEnv({ defaultMaxOutputChars: 1_111 })
    const second = resolveOptionsFromEnv({ defaultMaxOutputChars: 2_222 })
    expect(first.defaultMaxOutputChars).toBe(1_111)
    expect(second.defaultMaxOutputChars).toBe(2_222)
  })
})

describe("resolvePythonPath", () => {
  const original = process.env.OPENCODE_IPYNB_PYTHON
  afterEach(() => {
    if (original === undefined) delete process.env.OPENCODE_IPYNB_PYTHON
    else process.env.OPENCODE_IPYNB_PYTHON = original
  })

  const realPython = fs.realpathSync(process.execPath)
  const otherReal = fs.realpathSync("/bin/sh")

  it("lets OPENCODE_IPYNB_PYTHON win over the plugin option", () => {
    process.env.OPENCODE_IPYNB_PYTHON = realPython
    expect(resolvePythonPath({ pythonPath: otherReal })).toBe(realPython)
  })

  it("falls back to the plugin option when the env var is absent", () => {
    delete process.env.OPENCODE_IPYNB_PYTHON
    expect(resolvePythonPath({ pythonPath: otherReal })).toBe(otherReal)
  })
})

describe("PathService with allowOutsideWorktree", () => {
  const worktree = path.resolve("test", "fixtures")
  const outside = path.join(worktree, "..", "..", "evil.ipynb")

  it("rejects paths outside the worktree by default", async () => {
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    const result = await Effect.runPromise(
      pathSvc.ensureInsideWorktree(outside).pipe(Effect.flip)
    )
    expect((result as { _tag?: string })._tag).toBe("PathOutsideWorktree")
  })

  it("accepts paths outside the worktree when allowOutsideWorktree: true", async () => {
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform,
      allowOutsideWorktree: true
    })
    const result = await Effect.runPromise(pathSvc.ensureInsideWorktree(outside))
    expect(result).toBeUndefined()
  })

  it("still accepts paths inside the worktree when allowOutsideWorktree: true", async () => {
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform,
      allowOutsideWorktree: true
    })
    const inside = path.join(worktree, "simple.ipynb")
    const result = await Effect.runPromise(pathSvc.ensureInsideWorktree(inside))
    expect(result).toBeUndefined()
  })
  it("rejects relative path-like pythonPath values", () => {
    const previous = process.env.OPENCODE_IPYNB_PYTHON
    delete process.env.OPENCODE_IPYNB_PYTHON
    try {
      expect(() => resolvePythonPath({ pythonPath: "./python" })).toThrow()
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-resolve-"))
      const absolute = path.join(dir, "python")
      fs.writeFileSync(absolute, "")
      fs.chmodSync(absolute, 0o755)
      try {
        expect(resolvePythonPath({ pythonPath: absolute })).toBe(absolute)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
      const bin = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-"))
      const fakePython = path.join(bin, process.platform === "win32" ? "python.exe" : "python")
      fs.writeFileSync(fakePython, "")
      fs.chmodSync(fakePython, 0o755)
      const previousPath = process.env.PATH
      process.env.PATH = bin
      try {
        const bare = resolvePythonPath({ pythonPath: "python" })
        expect(bare).toBe(fakePython)
      } finally {
        process.env.PATH = previousPath
        fs.rmSync(bin, { recursive: true, force: true })
      }
    } finally {
      if (previous !== undefined) process.env.OPENCODE_IPYNB_PYTHON = previous
    }
  })

})

const makeServicesContext = (): ToolContext =>
  ({
    sessionID: "t",
    messageID: "t",
    agent: "t",
    directory: os.tmpdir(),
    worktree: os.tmpdir(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

describe("OPENCODE_IPYNB_OPTIONS failure reporting", () => {
  it("reports unparseable JSON through the built services", () => {
    setEnv("{ not json")
    try {
      const services = buildServices(makeServicesContext())
      expect(services.envOptionsError).toBeDefined()
    } finally {
      setEnv(ORIGINAL_ENV)
    }
  })

  it("reports schema-invalid options with the offending field", () => {
    setEnv(JSON.stringify({ warmKernel: "yes" }))
    try {
      const services = buildServices(makeServicesContext())
      expect(services.envOptionsError).toContain("warmKernel")
    } finally {
      setEnv(ORIGINAL_ENV)
    }
  })

  it("reports nothing when the options are valid", () => {
    setEnv(JSON.stringify({ warmKernel: true }))
    try {
      const services = buildServices(makeServicesContext())
      expect(services.envOptionsError).toBeUndefined()
    } finally {
      setEnv(ORIGINAL_ENV)
    }
  })

  it("reports nothing when the variable is unset", () => {
    setEnv(undefined)
    try {
      const services = buildServices(makeServicesContext())
      expect(services.envOptionsError).toBeUndefined()
    } finally {
      setEnv(ORIGINAL_ENV)
    }
  })
})
