import { afterEach, describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildNotebookVirtualDocument } from "../../src/lsp.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { materializeVirtualDocument } from "../../src/virtual-materialize.js"
import { setBeforeRenameHook } from "../../src/utils/rename-hook.js"

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

const format = {
  unit: " ",
  newline: "\n" as const,
  itemSeparator: ", ",
  keySeparator: ": ",
  ensureAscii: false,
  trailingNewline: true
}

afterEach(() => {
  setBeforeRenameHook(undefined)
})

describe("a parent directory swapped immediately before the rename", () => {
  it("does not write the notebook outside the worktree", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-swap-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-swap-out-"))
    const sub = path.join(dir, "sub")
    fs.mkdirSync(sub)
    const file = path.join(sub, "n.ipynb")
    fs.writeFileSync(file, notebook("# A"))
    let swapped = false
    setBeforeRenameHook(() => {
      if (swapped) return
      swapped = true
      const parked = path.join(dir, "sub-parked")
      fs.renameSync(sub, parked)
      fs.symlinkSync(outside, sub)
      for (const entry of fs.readdirSync(parked)) {
        if (entry.endsWith(".tmp")) {
          fs.copyFileSync(path.join(parked, entry), path.join(outside, entry))
        }
      }
    })
    try {
      const svc = makeNotebookFileService({ worktree: dir })
      const read = await Effect.runPromise(svc.readWithText(file))
      const edited = {
        ...read.notebook,
        cells: [{ cell_type: "markdown", metadata: {}, source: ["# B"] }]
      }
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(file, edited as never, {
          format,
          previousText: read.text
        })
      )
      expect(swapped).toBe(true)
      expect(exit._tag).toBe("Failure")
      expect(fs.readdirSync(outside).filter((name) => name === "n.ipynb")).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("a parent directory swapped for sidecar materialization", () => {
  it("does not write the sidecar outside the worktree", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-swap-sidecar-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-swap-sidecar-out-"))
    const sub = path.join(dir, "sub")
    fs.mkdirSync(sub)
    const file = path.join(sub, "n.ipynb")
    fs.writeFileSync(file, notebook("# A"))
    let swapped = false
    setBeforeRenameHook(() => {
      if (swapped) return
      swapped = true
      const parked = path.join(dir, "sub-parked")
      fs.renameSync(sub, parked)
      fs.symlinkSync(outside, sub)
      for (const entry of fs.readdirSync(parked)) {
        if (entry.endsWith(".tmp")) {
          fs.copyFileSync(path.join(parked, entry), path.join(outside, entry))
        }
      }
    })
    try {
      const document = buildNotebookVirtualDocument(
        JSON.parse(notebook("# A")) as never,
        { filePath: file }
      )
      try {
        await materializeVirtualDocument(document, dir)
      } catch {
        // a refusal is the expected outcome
      }
      expect(swapped).toBe(true)
      const escaped = fs
        .readdirSync(outside)
        .filter((name) => name.startsWith("opencode-ipynb-lsp-") && name.endsWith(".py"))
      expect(escaped).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe("a failed parent-swap write leaves no temp behind", () => {
  it("removes the temp even when it moved with the directory", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-swap-temp-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-swap-temp-out-"))
    const sub = path.join(dir, "sub")
    fs.mkdirSync(sub)
    const file = path.join(sub, "n.ipynb")
    fs.writeFileSync(file, notebook("# A"))
    setBeforeRenameHook(() => {
      const parked = path.join(dir, "parked")
      fs.renameSync(sub, parked)
      fs.symlinkSync(outside, sub)
      // The attacker copies the temp so the writer's rename can still find a
      // source; the replace then fails against the re-validated directory and
      // the cleanup must not leave the notebook content behind.
      for (const entry of fs.readdirSync(parked)) {
        if (entry.endsWith(".tmp")) {
          fs.copyFileSync(path.join(parked, entry), path.join(outside, entry))
        }
      }
    })
    const temps = (root: string): string[] =>
      fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(root, entry.name)
        if (entry.isDirectory()) return temps(full)
        return entry.name.endsWith(".tmp") ? [full] : []
      })
    try {
      const svc = makeNotebookFileService({ worktree: dir })
      const read = await Effect.runPromise(svc.readWithText(file))
      const edited = {
        ...read.notebook,
        cells: [{ cell_type: "markdown", metadata: {}, source: ["# B"] }]
      }
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(file, edited as never, {
          format,
          previousText: read.text
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(temps(dir)).toEqual([])
    } finally {
      setBeforeRenameHook(undefined)
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})
