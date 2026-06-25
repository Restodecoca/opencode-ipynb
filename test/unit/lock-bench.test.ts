// SLOW BENCHMARK — run explicitly with: bun test test/unit/lock-bench.test.ts
// Set SKIP_LOCK_BENCH=1 in CI to skip.
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"

const fileSvc = makeNotebookFileService()

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lock-bench-"))

const runEff = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff) as Promise<A>

const maybeSkip = process.env.SKIP_LOCK_BENCH === "1"

const report = (label: string, totalMs: number, count: number) => {
  const mean = totalMs / count
  console.log(`[lock-bench] ${label}: total=${totalMs.toFixed(2)}ms count=${count} mean=${mean.toFixed(4)}ms`)
}

describe.skipIf(maybeSkip)("NotebookFileService.withFileLock > bench", () => {
  it("sequential lock acquire/release on a single file", async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, "x.ipynb")
    fs.writeFileSync(file, "")
    try {
      const M = 200
      const start = Bun.nanoseconds()
      for (let i = 0; i < M; i++) {
        await runEff(fileSvc.withFileLock(file, Effect.sync(() => undefined)))
      }
      const totalMs = (Bun.nanoseconds() - start) / 1e6
      report("sequential single-file", totalMs, M)
      const mean = totalMs / M
      expect(mean).toBeLessThan(10)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("parallel lock acquire/release on N different files", async () => {
    const dir = makeTmpDir()
    const N = 50
    const files: string[] = []
    for (let i = 0; i < N; i++) {
      const f = path.join(dir, `f${i}.ipynb`)
      fs.writeFileSync(f, "")
      files.push(f)
    }
    try {
      const start = Bun.nanoseconds()
      await Promise.all(
        files.map((f) => runEff(fileSvc.withFileLock(f, Effect.sync(() => undefined))))
      )
      const parallelTotalMs = (Bun.nanoseconds() - start) / 1e6
      report(`parallel N=${N} different-files`, parallelTotalMs, N)
      const perFileMs = parallelTotalMs / N
      expect(perFileMs).toBeLessThan(20)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
