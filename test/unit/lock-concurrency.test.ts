import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"

const fileSvc = makeNotebookFileService()

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lock-"))

const runEff = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff) as Promise<A>

describe("NotebookFileService.withFileLock > concurrency", () => {
  it("serializes N concurrent critical sections on the same file", async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, "x.ipynb")
    fs.writeFileSync(file, "")
    try {
      const N = 20
      const critical: Array<{ start: number; end: number }> = []

      const promises: Array<Promise<void>> = []
      for (let i = 0; i < N; i++) {
        promises.push(
          runEff(
            fileSvc.withFileLock(
              file,
              Effect.gen(function* () {
                const start = performance.now()
                yield* Effect.sleep(50)
                const end = performance.now()
                critical.push({ start, end })
              })
            )
          )
        )
      }
      await Promise.all(promises)

      critical.sort((a, b) => a.start - b.start)
      let maxOverlap = 0
      for (let i = 1; i < critical.length; i++) {
        const prev = critical[i - 1]
        const cur = critical[i]
        if (!prev || !cur) continue
        const overlap = Math.max(0, prev.end - cur.start)
        if (overlap > maxOverlap) maxOverlap = overlap
      }
      expect(maxOverlap).toBeLessThanOrEqual(1)
      expect(critical.length).toBe(N)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not block on different files", async () => {
    const dir = makeTmpDir()
    const fileA = path.join(dir, "a.ipynb")
    const fileB = path.join(dir, "b.ipynb")
    fs.writeFileSync(fileA, "")
    fs.writeFileSync(fileB, "")
    try {
      const lockA = fileSvc.withFileLock(fileA, Effect.sleep(200))
      const lockB = fileSvc.withFileLock(fileB, Effect.sleep(200))
      const start = Date.now()
      await Promise.all([runEff(lockA), runEff(lockB)])
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(350)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("releases the lock even when the program fails", async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, "x.ipynb")
    fs.writeFileSync(file, "")
    try {
      const failing = fileSvc.withFileLock(
        file,
        Effect.fail(new Error("boom") as never)
      )
      await expect(runEff(failing)).rejects.toThrow("boom")

      const start = Date.now()
      const ok = fileSvc.withFileLock(file, Effect.sync(() => "ok"))
      const result = await Promise.race([
        runEff(ok),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("lock not released within 1s")), 1000)
        )
      ])
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(500)
      expect(result).toBe("ok")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
