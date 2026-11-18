import { describe, expect, it, spyOn } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"

const notebook = (source: string): string =>
  `${JSON.stringify(
    {
      cells: [{ cell_type: "markdown", metadata: {}, source: [source] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    },
    null,
    1
  )}\n`

const transientOnce = (target: string): (() => void) => {
  const original = fs.promises.realpath
  let failed = false
  const spy = spyOn(fs.promises, "realpath")
  spy.mockImplementation(((
    candidate: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (!failed && path.resolve(String(candidate)) === path.resolve(target)) {
      failed = true
      return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }))
    }
    return (original as unknown as (...args: never[]) => Promise<string>)(
      (candidate as never),
      ...(rest as never[])
    )
  }) as unknown as typeof fs.promises.realpath)
  return () => spy.mockRestore()
}

describe("transient realpath in the write and lock paths", () => {
  it("writes through a symlink even when realpath fails once", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-symlink-retry-"))
    const real = path.join(dir, "real.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    fs.writeFileSync(real, notebook("# A"))
    fs.symlinkSync(real, alias)
    const restore = transientOnce(alias)
    try {
      const svc = makeNotebookFileService({ worktree: dir })
      const read = await Effect.runPromise(svc.readWithText(alias))
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(alias, read.notebook as never, {
          format: read.format,
          previousText: read.text
        })
      )
      expect(exit._tag).toBe("Success")
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(real, "utf8")).toContain("# A")
    } finally {
      restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keys the lock by real path even when realpath fails once", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lock-retry-"))
    const real = path.join(dir, "real.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    fs.writeFileSync(real, notebook("# A"))
    fs.symlinkSync(real, alias)
    const restore = transientOnce(alias)
    try {
      const svc = makeNotebookFileService({ worktree: dir })
      let active = 0
      let maxActive = 0
      const hold = (): Promise<void> =>
        svc
          .withFileLock(
            alias,
            Effect.promise(async () => {
              active += 1
              maxActive = Math.max(maxActive, active)
              await new Promise((resolve) => setTimeout(resolve, 40))
              active -= 1
            })
          )
          .pipe(Effect.runPromise)
      const holdReal = (): Promise<void> =>
        svc
          .withFileLock(
            real,
            Effect.promise(async () => {
              active += 1
              maxActive = Math.max(maxActive, active)
              await new Promise((resolve) => setTimeout(resolve, 40))
              active -= 1
            })
          )
          .pipe(Effect.runPromise)
      await Promise.all([hold(), holdReal()])
      expect(maxActive).toBe(1)
    } finally {
      restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
