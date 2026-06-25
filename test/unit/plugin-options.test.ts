import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { makePathService } from "../../src/services/PathService.js"
import { parsePluginOptions, type PluginOptions } from "../../src/plugin-options.js"
import { resolveToolOptions } from "../../src/tools/_resolveOptions.js"

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
})
