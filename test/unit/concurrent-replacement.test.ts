import { describe, expect, it, spyOn } from "bun:test"
import { Cause, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { NotebookValidationError } from "../../src/domain/errors.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { setAfterRenameHook } from "../../src/utils/rename-hook.js"
import { samePhysicalPath } from "../helpers.js"

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

describe("concurrent replacement detection", () => {
  it("reports the loss when another process deletes the notebook after our rename", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-deleted-"))
    const file = path.join(dir, "n.ipynb")
    const before = notebook("# A")
    fs.writeFileSync(file, before)
    const format = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false,
      trailingNewline: true
    }
    setAfterRenameHook(() => {
      fs.rmSync(file, { force: true })
    })
    try {
      const svc = makeNotebookFileService({ worktree: dir })
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(file, JSON.parse(notebook("# OURS")) as never, {
          format,
          previousText: before
        })
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        const value = error._tag === "Some" ? error.value : undefined
        expect((value as { message?: string }).message ?? "").toContain("disappeared")
      }
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      setAfterRenameHook(undefined)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a lost write when another writer rewrites the file in place", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-inplace-"))
    const file = path.join(dir, "n.ipynb")
    const before = notebook("# A")
    fs.writeFileSync(file, before)
    const format = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false,
      trailingNewline: true
    }
    const original = fs.promises.rename
    let injected = false
    let inodeBefore: number | undefined
    let inodeAfter: number | undefined
    const spy = spyOn(fs.promises, "rename").mockImplementation(((
      from: fs.PathLike,
      to: fs.PathLike
    ) => {
      return original(from, to).then((result) => {
        // The implementation renames to the realpath-resolved target: on
        // macOS the temp dir is a symlink and on Windows it is an 8.3 short
        // name, so the resolved spelling differs from the lexical one. Match
        // what the target denotes instead of how it is spelled. The temp's
        // own move (to a not-yet-existing name) fails the stat check and is
        // skipped, so only the final rename can inject.
        if (!injected && samePhysicalPath(String(to), file)) {
          injected = true
          inodeBefore = fs.statSync(file).ino
          fs.writeFileSync(file, notebook("# IN-PLACE"))
          inodeAfter = fs.statSync(file).ino
        }
        return result
      })
    }) as unknown as typeof fs.promises.rename)
    try {
      const svc = makeNotebookFileService({ worktree: dir })
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(file, JSON.parse(notebook("# OURS")) as never, {
          format,
          previousText: before
        })
      )
      expect(inodeBefore).toBe(inodeAfter)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(error._tag === "Some" ? error.value : undefined).toBeInstanceOf(
          NotebookValidationError
        )
      }
      expect(fs.readFileSync(file, "utf8")).toBe(notebook("# IN-PLACE"))
    } finally {
      spy.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a lost write when another writer replaces the file after our rename", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lost-"))
    const file = path.join(dir, "n.ipynb")
    const before = notebook("# A")
    fs.writeFileSync(file, before)
    const format = {
      unit: " ",
      newline: "\n" as const,
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false,
      trailingNewline: true
    }
    const original = fs.promises.rename
    let injected = false
    const spy = spyOn(fs.promises, "rename").mockImplementation(((
      from: fs.PathLike,
      to: fs.PathLike
    ) => {
      return original(from, to).then((result) => {
        // Same as above: match the resolved target physically, not lexically.
        if (!injected && samePhysicalPath(String(to), file)) {
          injected = true
          const competitor = path.join(dir, "competitor.tmp")
          fs.writeFileSync(competitor, notebook("# COMPETITOR"))
          return original(competitor, to).then(() => result)
        }
        return result
      })
    }) as unknown as typeof fs.promises.rename)
    try {
      const svc = makeNotebookFileService({ worktree: dir })
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(
          file,
          JSON.parse(notebook("# OURS")) as never,
          { format, previousText: before }
        )
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const error = Cause.findErrorOption(exit.cause)
        expect(error._tag === "Some" ? error.value : undefined).toBeInstanceOf(
          NotebookValidationError
        )
      }
      expect(fs.readFileSync(file, "utf8")).toBe(notebook("# COMPETITOR"))
    } finally {
      spy.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
