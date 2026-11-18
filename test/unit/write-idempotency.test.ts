import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { detectNotebookFormat } from "../../src/utils/json.js"

const run = async <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-idem-"))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const notebook = (source: string): Record<string, unknown> => ({
  cells: [{ cell_type: "markdown", metadata: {}, source: [source] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5
})

const serialized = (source: string): string =>
  `${JSON.stringify(notebook(source), null, 1)}\n`

describe("writeAtomic idempotency", () => {
  const restore: Array<() => void> = []

  afterEach(() => {
    while (restore.length > 0) restore.pop()?.()
  })

  it("does not touch the filesystem when the stored rewrite is byte-identical", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, serialized("# A"))
      const svc = makeNotebookFileService()
      const spy = spyOn(fs.promises, "rename")
      restore.push(() => spy.mockRestore())
      const outcome = await run(svc.writeAtomic(file, notebook("# A") as never))
      expect(spy).not.toHaveBeenCalled()
      expect(fs.readFileSync(file, "utf8")).toBe(serialized("# A"))
      expect(outcome.mode).toBe("patched")
    })
  })

  it("verifies the revision, then skips an identical rewrite", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, serialized("# A"))
      const text = fs.readFileSync(file, "utf8")
      const svc = makeNotebookFileService()
      const spy = spyOn(fs.promises, "rename")
      restore.push(() => spy.mockRestore())
      const outcome = await run(
        svc.writeAtomic(file, notebook("# A") as never, {
          format: detectNotebookFormat(text),
          previousText: text
        })
      )
      expect(spy).not.toHaveBeenCalled()
      expect(fs.readFileSync(file, "utf8")).toBe(text)
      expect(outcome.mode).toBe("patched")
    })
  })

  it("still rejects an identical rewrite when the notebook changed meanwhile", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, serialized("# A"))
      const stale = fs.readFileSync(file, "utf8")
      fs.writeFileSync(file, serialized("# B"))
      const svc = makeNotebookFileService()
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(file, notebook("# A") as never, {
          format: detectNotebookFormat(stale),
          previousText: stale
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(fs.readFileSync(file, "utf8")).toBe(serialized("# B"))
    })
  })

  it("still writes when the notebook content differs", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, serialized("# A"))
      const svc = makeNotebookFileService()
      const spy = spyOn(fs.promises, "rename")
      restore.push(() => spy.mockRestore())
      await run(svc.writeAtomic(file, notebook("# B") as never))
      expect(spy).toHaveBeenCalled()
      expect(fs.readFileSync(file, "utf8")).toContain("# B")
    })
  })

  it("recreates a deleted notebook even when the rewrite is identical", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, serialized("# A"))
      const stale = fs.readFileSync(file, "utf8")
      fs.rmSync(file)
      const svc = makeNotebookFileService()
      await run(
        svc.writeAtomic(file, notebook("# A") as never, {
          format: detectNotebookFormat(stale),
          previousText: stale
        })
      )
      expect(fs.readFileSync(file, "utf8")).toBe(serialized("# A"))
    })
  })
})
