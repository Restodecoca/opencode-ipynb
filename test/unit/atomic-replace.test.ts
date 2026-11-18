import { describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { replaceFile } from "../../src/utils/atomic-replace.js"
import { makeWarningSink } from "../../src/utils/warnings.js"

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-"))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("replaceFile", () => {
  it("renames the temp file over the target", async () => {
    await withTempDir(async (dir) => {
      const temp = path.join(dir, "new.tmp")
      const target = path.join(dir, "notebook.ipynb")
      fs.writeFileSync(temp, "new")
      fs.writeFileSync(target, "old")
      await replaceFile(temp, target)
      expect(fs.readFileSync(target, "utf8")).toBe("new")
      expect(fs.existsSync(temp)).toBe(false)
    })
  })

  it("creates the target when it does not exist yet", async () => {
    await withTempDir(async (dir) => {
      const temp = path.join(dir, "new.tmp")
      const target = path.join(dir, "fresh.ipynb")
      fs.writeFileSync(temp, "content")
      await replaceFile(temp, target)
      expect(fs.readFileSync(target, "utf8")).toBe("content")
    })
  })

  it("rejects instead of deleting both copies when the rename fails", async () => {
    if (process.platform === "win32") return
    await withTempDir(async (dir) => {
      const temp = path.join(dir, "new.tmp")
      const target = path.join(dir, "notebook.ipynb")
      fs.writeFileSync(temp, "new")
      fs.mkdirSync(target)
      fs.writeFileSync(path.join(target, "inner"), "keep")
      const sink = makeWarningSink()
      await expect(replaceFile(temp, target, sink)).rejects.toBeDefined()
      expect(fs.existsSync(path.join(target, "inner"))).toBe(true)
    })
  })

  it("reports when it cannot move the target aside", async () => {
    if (process.platform !== "win32") return
    await withTempDir(async (dir) => {
      const temp = path.join(dir, "new.tmp")
      const target = path.join(dir, "notebook.ipynb")
      fs.writeFileSync(temp, "new")
      fs.writeFileSync(target, "old")
      const original = fs.promises.rename
      let firstAttempt = true
      const spy = spyOn(fs.promises, "rename").mockImplementation(((
        from: fs.PathLike,
        to: fs.PathLike
      ) => {
        if (firstAttempt) {
          firstAttempt = false
          return Promise.reject(
            Object.assign(new Error("locked"), { code: "EPERM" })
          )
        }
        if (path.resolve(String(from)) === path.resolve(target)) {
          return Promise.reject(
            Object.assign(new Error("locked"), { code: "EPERM" })
          )
        }
        return original(from, to)
      }) as unknown as typeof fs.promises.rename)
      try {
        const sink = makeWarningSink()
        await replaceFile(temp, target, sink)
        expect(sink.drain().length).toBeGreaterThan(0)
      } finally {
        spy.mockRestore()
      }
    })
  })
})
