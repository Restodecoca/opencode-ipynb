import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import { makePathService } from "../../src/services/PathService.js"

const FIXTURES = path.resolve(__dirname, "..", "fixtures")

const runOrThrow = async <A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, E, never>)

describe("PathService.resolve", () => {
  it("of a relative path joins against the directory on Linux/macOS and on Windows", async () => {
    if (process.platform === "win32") {
      const pathSvc = makePathService({
        directory: "C:\\foo",
        worktree: "C:\\foo",
        platform: "win32"
      })
      const result = await runOrThrow(pathSvc.resolve("simple.ipynb"))
      expect(result).toBe("C:\\foo\\simple.ipynb")
    } else {
      const pathSvc = makePathService({
        directory: "/foo",
        worktree: "/foo",
        platform: "linux"
      })
      const result = await runOrThrow(pathSvc.resolve("simple.ipynb"))
      expect(result).toBe("/foo/simple.ipynb")
    }
  })

  it("of an absolute path returns it normalized (POSIX on POSIX, Windows-style on Windows)", async () => {
    if (process.platform === "win32") {
      const pathSvc = makePathService({
        directory: "C:\\foo",
        worktree: "C:\\foo",
        platform: "win32"
      })
      const result = await runOrThrow(pathSvc.resolve("C:\\foo\\bar.ipynb"))
      expect(result).toBe("C:\\foo\\bar.ipynb")
    } else {
      const pathSvc = makePathService({
        directory: "/foo",
        worktree: "/foo",
        platform: "linux"
      })
      const result = await runOrThrow(pathSvc.resolve("/abs/file.ipynb"))
      expect(result).toBe("/abs/file.ipynb")
    }
  })

  it("of an absolute path with .. segments collapses them (Windows and POSIX)", async () => {
    if (process.platform === "win32") {
      const pathSvc = makePathService({
        directory: "C:\\foo",
        worktree: "C:\\foo",
        platform: "win32"
      })
      const result = await runOrThrow(pathSvc.resolve("C:\\foo\\..\\bar.ipynb"))
      expect(result).toBe("C:\\bar.ipynb")
    } else {
      const pathSvc = makePathService({
        directory: "/foo",
        worktree: "/foo",
        platform: "linux"
      })
      const result = await runOrThrow(pathSvc.resolve("/foo/../bar.ipynb"))
      expect(result).toBe("/bar.ipynb")
    }
  })
})

describe("PathService.relative", () => {
  it("of a path inside the worktree returns a clean relative path with no leading ..", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const inside = path.join(FIXTURES, "simple.ipynb")
    const result = await runOrThrow(pathSvc.relative(inside))
    expect(result.startsWith("..")).toBe(false)
    expect(result.endsWith("simple.ipynb")).toBe(true)
  })

  it("of a path outside the worktree returns a path that starts with .. (prefix check, cross-platform)", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })
    const outside = path.resolve(FIXTURES, "..", "evil.ipynb")
    const result = await runOrThrow(pathSvc.relative(outside))
    expect(result.startsWith("..")).toBe(true)
    expect(result.endsWith("evil.ipynb")).toBe(true)
  })
})

describe("PathService.ensureInsideWorktree", () => {
  it("rejects a path outside the worktree by default and accepts it when allowOutsideWorktree: true", async () => {
    const worktree = FIXTURES
    const outside = path.join(worktree, "..", "..", "evil.ipynb")

    const pathSvcDefault = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    const defaultResult = await Effect.runPromise(
      pathSvcDefault.ensureInsideWorktree(outside).pipe(Effect.flip)
    )
    expect((defaultResult as { _tag?: string })._tag).toBe("PathOutsideWorktree")

    const pathSvcAllowed = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform,
      allowOutsideWorktree: true
    })
    const allowedResult = await Effect.runPromise(
      pathSvcAllowed.ensureInsideWorktree(outside)
    )
    expect(allowedResult).toBeUndefined()
  })

  it("rejects Windows paths on a different drive", async () => {
    if (process.platform !== "win32") return
    const pathSvc = makePathService({
      directory: "C:\\work",
      worktree: "C:\\work",
      platform: "win32"
    })

    const err = await Effect.runPromise(
      pathSvc.ensureInsideWorktree("D:\\secret\\x.ipynb").pipe(Effect.flip)
    )
    expect((err as { _tag?: string })._tag).toBe("PathOutsideWorktree")
  })
})

describe("PathService.ensureIpynb", () => {
  it("flags a non-.ipynb path with warned: true and accepts .ipynb paths with warned: false (case-insensitive)", async () => {
    const pathSvc = makePathService({
      directory: FIXTURES,
      worktree: FIXTURES,
      platform: process.platform
    })

    const notIpynb = await runOrThrow(
      pathSvc.ensureIpynb(path.join(FIXTURES, "simple.txt"))
    )
    expect(notIpynb.warned).toBe(true)

    const ipynb = await runOrThrow(
      pathSvc.ensureIpynb(path.join(FIXTURES, "simple.ipynb"))
    )
    expect(ipynb.warned).toBe(false)

    const upperIpynb = await runOrThrow(
      pathSvc.ensureIpynb(path.join(FIXTURES, "simple.IPYNB"))
    )
    expect(upperIpynb.warned).toBe(false)
  })
})

describe("PathService.toDisplay", () => {
  it("returns forward slashes on every platform", () => {
    const pathSvc = makePathService({
      directory: "/foo",
      worktree: "/foo",
      platform: process.platform
    })
    const result = pathSvc.toDisplay("foo\\bar.ipynb")
    expect(result.includes("\\")).toBe(false)
    expect(result.endsWith("bar.ipynb")).toBe(true)
  })
})
