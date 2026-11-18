import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makePathService } from "../../src/services/PathService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import {
  permissionAliases,
  resolveDeepReal
} from "../../src/services/PermissionService.js"
import { killWindowsTree } from "../../src/utils/windows.js"
import { makeWarningSink } from "../../src/utils/warnings.js"

const isRoot = typeof process.getuid === "function" && process.getuid() === 0
const canDenyByMode = process.platform !== "win32" && !isRoot

const makeTmpDir = (prefix: string): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), prefix))

const makeBlockedDir = (root: string, name: string): string => {
  const blocked = path.join(root, name)
  fs.mkdirSync(blocked)
  fs.chmodSync(blocked, 0o000)
  return blocked
}

const unlock = (root: string): void => {
  fs.chmodSync(root, 0o700)
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(path.join(root, entry.name))
  }
}

const withCleanup = async (
  root: string,
  run: () => Promise<void>
): Promise<void> => {
  try {
    await run()
  } finally {
    try {
      unlock(root)
    } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const waitForWarnings = async (
  drain: () => ReadonlyArray<{ source: string; message: string; detail?: string }>
) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const warnings = drain()
    if (warnings.length > 0) return warnings
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return drain()
}

describe("PermissionService.permissionAliases > realpath failures", () => {
  it("reports a realpath failure that is not a missing path", async () => {
    if (!canDenyByMode) return
    const root = makeTmpDir("ipynb-warn-alias-")
    const blocked = makeBlockedDir(root, "blocked")
    const sink = makeWarningSink()
    try {
      const aliases = await permissionAliases(
        path.join(blocked, "new.ipynb"),
        [root],
        { warningSink: sink }
      )
      expect(aliases).toContain(path.join(blocked, "new.ipynb"))
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("permission-alias")
      expect(warnings[0]?.detail).toContain("EACCES")
    } finally {
      await withCleanup(root, async () => {})
    }
  })

  it("stays quiet for a path that does not exist yet", async () => {
    if (process.platform === "win32") return
    const root = makeTmpDir("ipynb-warn-alias-quiet-")
    const sink = makeWarningSink()
    try {
      const aliases = await permissionAliases(
        path.join(root, "missing", "new.ipynb"),
        [root],
        { warningSink: sink }
      )
      expect(aliases.length).toBeGreaterThan(0)
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("NotebookFileService.withFileLock > canonicalization failures", () => {
  it("reports a lock key it could not canonicalize", async () => {
    if (!canDenyByMode) return
    const root = makeTmpDir("ipynb-warn-lock-")
    const blocked = makeBlockedDir(root, "blocked")
    const sink = makeWarningSink()
    const svc = makeNotebookFileService({ warningSink: sink })
    try {
      const value = await Effect.runPromise(
        svc.withFileLock(path.join(blocked, "x.ipynb"), Effect.succeed(7))
      )
      expect(value).toBe(7)
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("lock")
      expect(warnings[0]?.detail).toContain("EACCES")
    } finally {
      await withCleanup(root, async () => {})
    }
  })

  it("stays quiet for a notebook that does not exist yet", async () => {
    if (process.platform === "win32") return
    const root = makeTmpDir("ipynb-warn-lock-quiet-")
    const sink = makeWarningSink()
    const svc = makeNotebookFileService({ warningSink: sink })
    try {
      await Effect.runPromise(
        svc.withFileLock(path.join(root, "missing.ipynb"), Effect.succeed(1))
      )
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("PermissionService.resolveDeepReal", () => {
  it("reports the first unreadable ancestor once and still returns a path", async () => {
    if (!canDenyByMode) return
    const root = makeTmpDir("ipynb-warn-deep-")
    const blocked = makeBlockedDir(root, "blocked")
    const sink = makeWarningSink()
    try {
      const resolved = await resolveDeepReal(
        path.join(blocked, "nested", "new.ipynb"),
        { warningSink: sink }
      )
      expect(resolved.endsWith(path.join("nested", "new.ipynb"))).toBe(true)
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("permission-alias")
    } finally {
      await withCleanup(root, async () => {})
    }
  })

  it("stays quiet for a not-yet-existing path", async () => {
    if (process.platform === "win32") return
    const root = makeTmpDir("ipynb-warn-deep-quiet-")
    const sink = makeWarningSink()
    try {
      await resolveDeepReal(path.join(root, "missing", "new.ipynb"), {
        warningSink: sink
      })
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("PathService.ensureInsideWorktree > unreadable components", () => {
  it("reports an unreadable component it had to skip", async () => {
    if (!canDenyByMode) return
    const root = makeTmpDir("ipynb-warn-confinement-")
    const blocked = makeBlockedDir(root, "blocked")
    const sink = makeWarningSink()
    const pathSvc = makePathService({
      directory: root,
      worktree: root,
      platform: process.platform,
      warningSink: sink
    })
    try {
      await Effect.runPromise(
        pathSvc.ensureInsideWorktree(path.join(blocked, "n.ipynb"))
      )
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("path-resolution")
      expect(warnings[0]?.detail).toContain("EACCES")
    } finally {
      await withCleanup(root, async () => {})
    }
  })

  it("reports a worktree root it could not resolve", async () => {
    if (!canDenyByMode) return
    const root = makeTmpDir("ipynb-warn-root-")
    const blocked = makeBlockedDir(root, "blocked")
    const worktree = path.join(blocked, "work")
    const sink = makeWarningSink()
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform,
      warningSink: sink
    })
    try {
      const exit = await Effect.runPromiseExit(
        pathSvc.ensureInsideWorktree(path.join(worktree, "n.ipynb"))
      )
      expect(exit._tag).toBe("Failure")
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("path-resolution")
      expect(warnings[0]?.detail).toContain("EACCES")
    } finally {
      await withCleanup(root, async () => {})
    }
  })

  it("stays quiet while walking ancestors that do not exist yet", async () => {
    if (process.platform === "win32") return
    const root = makeTmpDir("ipynb-warn-confinement-quiet-")
    const sink = makeWarningSink()
    const pathSvc = makePathService({
      directory: root,
      worktree: root,
      platform: process.platform,
      warningSink: sink
    })
    try {
      await Effect.runPromise(
        pathSvc.ensureInsideWorktree(path.join(root, "missing", "deep", "n.ipynb"))
      )
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("PathService.ensureExists > unreadable paths", () => {
  it("reports an unreadable path that looks missing", async () => {
    if (!canDenyByMode) return
    const root = makeTmpDir("ipynb-warn-exists-")
    const blocked = makeBlockedDir(root, "blocked")
    const sink = makeWarningSink()
    const pathSvc = makePathService({
      directory: root,
      worktree: root,
      platform: process.platform,
      warningSink: sink
    })
    try {
      const error = await Effect.runPromise(
        pathSvc.ensureExists(path.join(blocked, "n.ipynb")).pipe(Effect.flip)
      )
      expect(error._tag).toBe("NotebookNotFound")
      expect(error.message).toBe("file does not exist")
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("path-resolution")
      expect(warnings[0]?.detail).toContain("EACCES")
    } finally {
      await withCleanup(root, async () => {})
    }
  })

  it("stays quiet for a path that is genuinely absent", async () => {
    if (process.platform === "win32") return
    const root = makeTmpDir("ipynb-warn-exists-quiet-")
    const sink = makeWarningSink()
    const pathSvc = makePathService({
      directory: root,
      worktree: root,
      platform: process.platform,
      warningSink: sink
    })
    try {
      const error = await Effect.runPromise(
        pathSvc.ensureExists(path.join(root, "absent.ipynb")).pipe(Effect.flip)
      )
      expect(error._tag).toBe("NotebookNotFound")
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("PathService.writeFileSafe > mode probing", () => {
  it("keeps the resolved env free of the sink", () => {
    const sink = makeWarningSink()
    const pathSvc = makePathService({
      directory: "/foo",
      worktree: "/foo",
      platform: process.platform,
      warningSink: sink
    })
    expect(pathSvc.env).toEqual({
      directory: "/foo",
      worktree: "/foo",
      platform: process.platform
    })
  })

  it("stays quiet when the target does not exist and when it is a regular file", async () => {
    if (process.platform === "win32") return
    const root = makeTmpDir("ipynb-warn-write-quiet-")
    const sink = makeWarningSink()
    const pathSvc = makePathService({
      directory: root,
      worktree: root,
      platform: process.platform,
      warningSink: sink
    })
    try {
      const file = path.join(root, "out.txt")
      await Effect.runPromise(pathSvc.writeFileSafe(file, "one"))
      await Effect.runPromise(pathSvc.writeFileSafe(file, "two"))
      expect(fs.readFileSync(file, "utf8")).toBe("two")
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("windows.killWindowsTree > spawn failures", () => {
  it("reports a taskkill process that could not be started", async () => {
    if (process.platform === "win32") return
    const sink = makeWarningSink()
    killWindowsTree(4242, sink)
    const warnings = await waitForWarnings(sink.drain)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.source).toBe("cleanup")
    expect(warnings[0]?.message).toContain("taskkill")
  })
})
