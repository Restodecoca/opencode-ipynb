import { describe, expect, it } from "bun:test"
import { Cause, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  makeCleanImpl,
  makeEditImpl,
  makeNotebookFileService,
  makeOutputImpl,
  makePathService,
  makePermissionService
} from "../../src/services/index.js"
import type { ToolContext } from "../../src/tool.js"

const FIXTURES = path.resolve(__dirname, "..", "fixtures")

const makeContext = (
  dir: string,
  onAsk: () => void
): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {
      onAsk()
    }
  }) as unknown as ToolContext

const makeServices = (dir: string, onAsk: () => void) => {
  const pathSvc = makePathService({
    directory: dir,
    worktree: dir,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const permSvc = makePermissionService(makeContext(dir, onAsk))
  return { pathSvc, fileSvc, permSvc }
}

const conflictTag = (exit: Awaited<ReturnType<typeof Effect.runPromiseExit>>): string | undefined => {
  if (exit._tag !== "Failure") return undefined
  const failure = Cause.findErrorOption(exit.cause)
  return failure._tag === "Some"
    ? (failure.value as { _tag?: string })._tag
    : undefined
}

describe("revision conflict guards", () => {
  it("ipynb_edit refuses to overwrite an external edit made during the prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-conflict-edit-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const { pathSvc, fileSvc, permSvc } = makeServices(dir, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      const first = raw.cells[0]
      if (first) first["source"] = "EXTERNAL_CHANGE"
      fs.writeFileSync(file, JSON.stringify(raw))
    })
    const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
    try {
      const exit = await Effect.runPromiseExit(
        edit.editCell(file, { cellIndex: 0, source: "PLUGIN_CHANGE" })
      )
      expect(conflictTag(exit)).toBe("NotebookValidation")
      expect(fs.readFileSync(file, "utf8")).toContain("EXTERNAL_CHANGE")
      expect(fs.readFileSync(file, "utf8")).not.toContain("PLUGIN_CHANGE")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_clean refuses to overwrite an external edit made during the prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-conflict-clean-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "outputs.ipynb"), file)
    const { pathSvc, fileSvc, permSvc } = makeServices(dir, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      const first = raw.cells[0]
      if (first) first["source"] = "EXTERNAL_CHANGE"
      fs.writeFileSync(file, JSON.stringify(raw))
    })
    const clean = makeCleanImpl(pathSvc, fileSvc, permSvc)
    try {
      const exit = await Effect.runPromiseExit(clean.clean(file))
      expect(conflictTag(exit)).toBe("NotebookValidation")
      expect(fs.readFileSync(file, "utf8")).toContain("EXTERNAL_CHANGE")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_outputs clear_all refuses to overwrite an external edit made during the prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-conflict-outputs-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "outputs.ipynb"), file)
    const { pathSvc, fileSvc, permSvc } = makeServices(dir, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      const first = raw.cells[0]
      if (first) first["source"] = "EXTERNAL_CHANGE"
      fs.writeFileSync(file, JSON.stringify(raw))
    })
    const output = makeOutputImpl(pathSvc, fileSvc, permSvc)
    try {
      const exit = await Effect.runPromiseExit(output.clearAllOutputs(file))
      expect(conflictTag(exit)).toBe("NotebookValidation")
      expect(fs.readFileSync(file, "utf8")).toContain("EXTERNAL_CHANGE")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("ipynb_cell_insert refuses a concurrent external edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-conflict-insert-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const { pathSvc, fileSvc, permSvc } = makeServices(dir, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      const first = raw.cells[0]
      if (first) first["source"] = "EXTERNAL_CHANGE"
      fs.writeFileSync(file, JSON.stringify(raw))
    })
    const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
    try {
      const exit = await Effect.runPromiseExit(
        edit.insertCell(file, "code", "x = 1", 1)
      )
      expect(conflictTag(exit)).toBe("NotebookValidation")
      expect(fs.readFileSync(file, "utf8")).toContain("EXTERNAL_CHANGE")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_cell_move refuses a concurrent external edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-conflict-move-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const { pathSvc, fileSvc, permSvc } = makeServices(dir, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      const first = raw.cells[0]
      if (first) first["source"] = "EXTERNAL_CHANGE"
      fs.writeFileSync(file, JSON.stringify(raw))
    })
    const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
    try {
      const exit = await Effect.runPromiseExit(edit.moveCell(file, 0, 2))
      expect(conflictTag(exit)).toBe("NotebookValidation")
      expect(fs.readFileSync(file, "utf8")).toContain("EXTERNAL_CHANGE")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_cell_delete refuses a concurrent external edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-conflict-delete-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const { pathSvc, fileSvc, permSvc } = makeServices(dir, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      const first = raw.cells[0]
      if (first) first["source"] = "EXTERNAL_CHANGE"
      fs.writeFileSync(file, JSON.stringify(raw))
    })
    const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
    try {
      const exit = await Effect.runPromiseExit(edit.deleteCell(file, 0))
      expect(conflictTag(exit)).toBe("NotebookValidation")
      expect(fs.readFileSync(file, "utf8")).toContain("EXTERNAL_CHANGE")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ipynb_outputs clear_cell refuses a concurrent external edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-conflict-clear-"))
    const file = path.join(dir, "n.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "outputs.ipynb"), file)
    const { pathSvc, fileSvc, permSvc } = makeServices(dir, () => {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<Record<string, unknown>>
      }
      const first = raw.cells[0]
      if (first) first["source"] = "EXTERNAL_CHANGE"
      fs.writeFileSync(file, JSON.stringify(raw))
    })
    const output = makeOutputImpl(pathSvc, fileSvc, permSvc)
    try {
      const exit = await Effect.runPromiseExit(output.clearCellOutputs(file, 0))
      expect(conflictTag(exit)).toBe("NotebookValidation")
      expect(fs.readFileSync(file, "utf8")).toContain("EXTERNAL_CHANGE")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})
