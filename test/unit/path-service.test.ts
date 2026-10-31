import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
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

  it("rejects a symlink inside the worktree that points outside", async () => {
    if (process.platform === "win32") return
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-link-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-out-"))
    const target = path.join(outside, "secret.ipynb")
    const link = path.join(worktree, "link.ipynb")
    fs.writeFileSync(target, "{}")
    fs.symlinkSync(target, link)
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    try {
      const err = await Effect.runPromise(
        pathSvc.ensureInsideWorktree(link).pipe(Effect.flip)
      )
      expect((err as { _tag?: string })._tag).toBe("PathOutsideWorktree")
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects a nonexistent target under a symlinked ancestor", async () => {
    if (process.platform === "win32") return
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-ancestor-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-ancestor-out-"))
    fs.symlinkSync(outside, path.join(worktree, "escape"))
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    try {
      const err = await Effect.runPromise(
        pathSvc.ensureInsideWorktree(path.join(worktree, "escape", "new", "file.ipynb")).pipe(Effect.flip)
      )
      expect((err as { _tag?: string })._tag).toBe("PathOutsideWorktree")
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("rejects a dangling symlink whose target is outside", async () => {
    if (process.platform === "win32") return
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-dangling-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-dangling-out-"))
    const link = path.join(worktree, "dangling.ipynb")
    fs.symlinkSync(path.join(outside, "missing.ipynb"), link)
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    try {
      const err = await Effect.runPromise(
        pathSvc.ensureInsideWorktree(link).pipe(Effect.flip)
      )
      expect((err as { _tag?: string })._tag).toBe("PathOutsideWorktree")
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("accepts an inside name that starts with two dots", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-path-dots-"))
    const file = path.join(worktree, "..notes.ipynb")
    fs.writeFileSync(file, "{}")
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    try {
      const result = await Effect.runPromise(pathSvc.ensureInsideWorktree(file))
      expect(result).toBeUndefined()
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
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


  it("does not rewrite backslashes in POSIX filenames", async () => {
    if (process.platform === "win32") return
    const pathSvc = makePathService({
      directory: "/foo",
      worktree: "/foo",
      platform: process.platform
    })
    expect(await Effect.runPromise(pathSvc.resolve("a\\b.ipynb"))).toBe(
      "/foo/a\\b.ipynb"
    )
  })

describe("PathService.writeFileSafe", () => {
  it("rejects a target symlink that escapes the worktree", async () => {
    if (process.platform === "win32") return
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-write-safe-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-write-safe-out-"))
    const target = path.join(outside, "keep.txt")
    const link = path.join(worktree, "out.txt")
    fs.writeFileSync(target, "outside")
    fs.symlinkSync(target, link)
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    try {
      const result = await Effect.runPromiseExit(pathSvc.writeFileSafe(link, "inside"))
      expect(result._tag).toBe("Failure")
      expect(fs.readFileSync(target, "utf8")).toBe("outside")
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("writes through a symlink whose target stays inside the worktree", async () => {
    if (process.platform === "win32") return
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-write-safe-"))
    const target = path.join(worktree, "target.txt")
    const link = path.join(worktree, "link.txt")
    fs.writeFileSync(target, "old")
    fs.symlinkSync(target, link)
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    try {
      await runOrThrow(pathSvc.writeFileSafe(link, "new"))
      expect(fs.readFileSync(target, "utf8")).toBe("new")
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
    }
  })

  it("rejects an ancestor symlink outside the worktree", async () => {
    if (process.platform === "win32") return
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-write-safe-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-write-safe-out-"))
    fs.symlinkSync(outside, path.join(worktree, "escape"))
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    try {
      const result = await Effect.runPromiseExit(
        pathSvc.writeFileSafe(path.join(worktree, "escape", "newdir", "out.txt"), "x")
      )
      expect(result._tag).toBe("Failure")
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
