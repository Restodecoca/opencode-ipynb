import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { realpathWithRetry } from "../../src/utils/realpath.js"

const notebook = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }

const deepDir = (root: string, depth: number): string => {
  let dir = root
  for (let index = 0; index < depth; index += 1) dir = path.join(dir, `d${index}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe("realpath retry cost", () => {
  it("does not spend the retry budget on a path whose parent already exists", async () => {
    // The budget below is calibrated on Linux; win32 file APIs have a different
    // fixed cost per call, so the same threshold is not meaningful there.
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-realpath-cost-"))
    try {
      const dir = deepDir(root, 64)
      const missing = path.join(dir, "new.ipynb")
      const started = performance.now()
      for (let index = 0; index < 20; index += 1) {
        await expect(realpathWithRetry(missing)).rejects.toMatchObject({ code: "ENOENT" })
      }
      expect(performance.now() - started).toBeLessThan(100)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("creates a new notebook deep in the worktree well inside a latency budget", async () => {
    for (const depth of [8, 64]) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-deep-write-"))
      try {
        const dir = deepDir(root, depth)
        const service = makeNotebookFileService({ worktree: root })
        const started = performance.now()
        const exit = await Effect.runPromiseExit(
          service.writeAtomic(path.join(dir, "new.ipynb"), notebook as never)
        )
        const elapsed = performance.now() - started
        expect(exit._tag).toBe("Success")
        expect(elapsed).toBeLessThan(100)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  })
})
