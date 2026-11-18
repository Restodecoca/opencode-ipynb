import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makeWarningSink } from "../../src/utils/warnings.js"

const run = async <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fsvc-"))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const notebook = (): Record<string, unknown> => ({
  cells: [{ cell_type: "markdown", metadata: {}, source: ["# A"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5
})

describe("writeAtomic temp handling", () => {
  it("leaves no temp file when the write succeeds", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, `${JSON.stringify(notebook(), null, 1)}\n`)
      const sink = makeWarningSink()
      const svc = makeNotebookFileService({ warningSink: sink })
      const outcome = await run(svc.writeAtomic(file, notebook() as never))
      expect(outcome.mode).toBeDefined()
      expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
      expect(sink.drain()).toEqual([])
    })
  })

  it("reports an unlink failure instead of leaking the temp file silently", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "n.ipynb")
      fs.mkdirSync(file)
      const sink = makeWarningSink()
      const svc = makeNotebookFileService({ warningSink: sink })
      await expect(run(svc.writeAtomic(file, notebook() as never))).rejects.toBeDefined()
      expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
    })
  })

  it("reports when the serialized notebook exceeds the size limit", async () => {
    await withTempDir(async (dir) => {
      const file = path.join(dir, "big.ipynb")
      const sink = makeWarningSink()
      const svc = makeNotebookFileService({ warningSink: sink })
      const huge = {
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: ["x".repeat(60 * 1024 * 1024)]
          }
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
      }
      await expect(run(svc.writeAtomic(file, huge as never))).rejects.toBeDefined()
      expect(fs.existsSync(file)).toBe(false)
    })
  })
})
