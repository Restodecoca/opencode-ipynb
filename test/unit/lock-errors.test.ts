import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { NotebookNotFoundError } from "../../src/domain/errors.js"

const fileSvc = makeNotebookFileService()

const makeTmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lock-err-"))

const runEff = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(eff) as Promise<A>

describe("NotebookFileService.withFileLock > error typing", () => {
  it("propagates a tagged error thrown inside the program verbatim", async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, "x.ipynb")
    fs.writeFileSync(file, "")
    try {
      const tagged = new NotebookNotFoundError({
        message: "file does not exist",
        filePath: "/some/missing.ipynb"
      })
      const failing = fileSvc.withFileLock(file, Effect.fail(tagged))
      const result = await runEff(failing.pipe(Effect.flip))
      expect(result).toBeInstanceOf(NotebookNotFoundError)
      expect((result as NotebookNotFoundError).filePath).toBe("/some/missing.ipynb")
      expect((result as NotebookNotFoundError).message).toBe("file does not exist")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("preserves a non-tagged error from the program", async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, "x.ipynb")
    fs.writeFileSync(file, "")
    try {
      const failing = fileSvc.withFileLock(
        file,
        Effect.fail(new Error("boom") as never)
      )
      const result = await runEff(failing.pipe(Effect.flip))
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe("boom")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
