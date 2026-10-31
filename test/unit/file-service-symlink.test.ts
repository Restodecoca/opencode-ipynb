import { describe, expect, it } from "bun:test"
import { Cause, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePathService } from "../../src/services/PathService.js"

const notebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: "x = 1"
    }
  ]
})

describe("NotebookFileService realpath pinning", () => {
  it("rejects a symlink swapped to a file outside the worktree", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-file-symlink-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-file-symlink-out-"))
    const inside = path.join(dir, "inside.ipynb")
    const target = path.join(outside, "outside.ipynb")
    const link = path.join(dir, "link.ipynb")
    fs.writeFileSync(inside, notebook)
    fs.writeFileSync(target, notebook)
    fs.symlinkSync(target, link)
    const svc = makeNotebookFileService({ worktree: dir })
    try {
      const read = await Effect.runPromiseExit(svc.read(link))
      expect(read._tag).toBe("Failure")
      const readText = await Effect.runPromiseExit(svc.readText(link))
      expect(readText._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("shares one lock across symlink aliases of the same file", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-file-lock-"))
    const real = path.join(dir, "real.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    fs.writeFileSync(real, notebook)
    fs.symlinkSync(real, alias)
    const svc = makeNotebookFileService({ worktree: dir })
    const critical: Array<{ start: number; end: number }> = []
    const section = () =>
      Effect.gen(function* () {
        const start = performance.now()
        yield* Effect.sleep(60)
        critical.push({ start, end: performance.now() })
      })
    try {
      await Promise.all([
        Effect.runPromise(svc.withFileLock(real, section())),
        Effect.runPromise(svc.withFileLock(alias, section()))
      ])
      critical.sort((a, b) => a.start - b.start)
      expect(critical).toHaveLength(2)
      expect(critical[1]!.start).toBeGreaterThanOrEqual(critical[0]!.end - 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("writes through a symlink alias to its inside target", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-file-alias-"))
    const real = path.join(dir, "real.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    fs.writeFileSync(real, notebook)
    fs.symlinkSync(real, alias)
    const svc = makeNotebookFileService({ worktree: dir })
    const parsed = JSON.parse(notebook) as {
      cells: Array<{ source: string }>
    }
    parsed.cells[0]!.source = "x = 2"
    try {
      await Effect.runPromise(svc.writeAtomic(alias, parsed as never))
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true)
      const realNotebook = JSON.parse(fs.readFileSync(real, "utf8")) as {
        cells: Array<{ source: string }>
      }
      expect(realNotebook.cells[0]?.source).toBe("x = 2")
      const aliasNotebook = JSON.parse(fs.readFileSync(alias, "utf8")) as {
        cells: Array<{ source: string }>
      }
      expect(aliasNotebook.cells[0]?.source).toBe("x = 2")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not create directories outside the worktree through a symlink", async () => {
    if (process.platform === "win32") return
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-write-work-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-write-out-"))
    fs.symlinkSync(outside, path.join(worktree, "escape"))
    const svc = makeNotebookFileService({ worktree })
    const parsed = JSON.parse(notebook) as never
    try {
      const result = await Effect.runPromiseExit(
        svc.writeAtomic(
          path.join(worktree, "escape", "new", "notebook.ipynb"),
          parsed
        )
      )
      expect(result._tag).toBe("Failure")
      expect(fs.existsSync(path.join(outside, "new"))).toBe(false)
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("accepts a worktree that is itself a symlink", async () => {
    if (process.platform === "win32") return
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-work-real-"))
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-work-link-"))
    const link = path.join(linkParent, "work")
    fs.symlinkSync(real, link)
    const svc = makeNotebookFileService({ worktree: link })
    const parsed = JSON.parse(notebook) as never
    try {
      await Effect.runPromise(
        svc.writeAtomic(path.join(link, "notebook.ipynb"), parsed)
      )
      expect(fs.existsSync(path.join(real, "notebook.ipynb"))).toBe(true)
    } finally {
      fs.rmSync(real, { recursive: true, force: true })
      fs.rmSync(linkParent, { recursive: true, force: true })
    }
  })

  it("preserves the notebook file mode on atomic writes", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-mode-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebook, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
    const svc = makeNotebookFileService({ worktree: dir })
    const parsed = JSON.parse(notebook) as never
    try {
      await Effect.runPromise(svc.writeAtomic(file, parsed))
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("classifies unreadable notebooks as a validation error, not not-found", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-unreadable-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebook)
    fs.chmodSync(file, 0o000)
    const svc = makeNotebookFileService({ worktree: dir })
    try {
      const result = await Effect.runPromiseExit(svc.read(file))
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const failure = Cause.findErrorOption(result.cause)
        expect(failure._tag).toBe("Some")
        if (failure._tag === "Some") {
          expect((failure.value as { _tag?: string })._tag).toBe(
            "NotebookValidation"
          )
        }
      }
    } finally {
      fs.chmodSync(file, 0o644)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("accepts a lexical session path whose real target is inside the worktree", async () => {
    if (process.platform === "win32") return
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-session-real-"))
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-session-link-"))
    const link = path.join(linkParent, "root")
    fs.mkdirSync(path.join(real, "notebooks"))
    fs.symlinkSync(real, link)
    const file = path.join(link, "notebooks", "notebook.ipynb")
    const pathSvc = makePathService({
      directory: link,
      worktree: real,
      platform: process.platform
    })
    const svc = makeNotebookFileService({ worktree: real })
    const parsed = JSON.parse(notebook) as never
    try {
      await Effect.runPromise(pathSvc.ensureInsideWorktree(file))
      await Effect.runPromise(svc.writeAtomic(file, parsed))
      expect(fs.existsSync(path.join(real, "notebooks", "notebook.ipynb"))).toBe(true)
    } finally {
      fs.rmSync(real, { recursive: true, force: true })
      fs.rmSync(linkParent, { recursive: true, force: true })
    }
  })

  it("writes through a symlink alias when no worktree is configured", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-no-worktree-"))
    const real = path.join(dir, "real.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    fs.writeFileSync(real, notebook)
    fs.symlinkSync(real, alias)
    const svc = makeNotebookFileService()
    const parsed = JSON.parse(notebook) as { cells: Array<{ source: string }> }
    parsed.cells[0]!.source = "x = 7"
    try {
      await Effect.runPromise(svc.writeAtomic(alias, parsed as never))
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true)
      const updated = JSON.parse(fs.readFileSync(real, "utf8")) as {
        cells: Array<{ source: string }>
      }
      expect(updated.cells[0]?.source).toBe("x = 7")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a FIFO that masquerades as a notebook", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-fifo-"))
    const file = path.join(dir, "notebook.ipynb")
    const made = Bun.spawnSync(["mkfifo", file])
    if (made.exitCode !== 0) {
      fs.rmSync(dir, { recursive: true, force: true })
      return
    }
    const svc = makeNotebookFileService({ worktree: dir })
    try {
      const result = await Effect.runPromiseExit(svc.read(file))
      expect(result._tag).toBe("Failure")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})
