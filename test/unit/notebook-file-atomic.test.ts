import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { NotebookSchema, type NotebookRaw } from "../../src/domain/notebook.js"
import { NotebookValidationError, NotebookWriteError } from "../../src/domain/errors.js"

const makeMinimalNotebook = (label: string): NotebookRaw => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python" }
  },
  cells: [
    {
      cell_type: "markdown",
      metadata: {},
      source: [`# ${label}\n`]
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: ["x = 1\n"]
    }
  ]
})

const runOrThrow = async <A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, E, never>)

describe("NotebookFileService.writeAtomic", () => {
  it("writes valid JSON that re-parses and equals the input", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "out.ipynb")
    const notebook = makeMinimalNotebook("write")
    try {
      await runOrThrow(fileSvc.writeAtomic(file, notebook))

      expect(fs.existsSync(file)).toBe(true)
      const text = fs.readFileSync(file, "utf8")
      const raw = JSON.parse(text) as unknown
      const parsed = NotebookSchema.safeParse(raw)
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data).toEqual(notebook)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("creates parent directories if they do not exist", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const nested = path.join(dir, "a", "b", "c")
    const file = path.join(nested, "out.ipynb")
    const notebook = makeMinimalNotebook("mkdir")
    try {
      expect(fs.existsSync(nested)).toBe(false)
      await runOrThrow(fileSvc.writeAtomic(file, notebook))
      expect(fs.existsSync(nested)).toBe(true)
      expect(fs.existsSync(file)).toBe(true)
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown
      const parsed = NotebookSchema.safeParse(raw)
      expect(parsed.success).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("overwrites an existing file atomically (replaces content)", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "out.ipynb")
    const first = makeMinimalNotebook("first")
    const second = makeMinimalNotebook("second")
    try {
      await runOrThrow(fileSvc.writeAtomic(file, first))
      const beforeText = fs.readFileSync(file, "utf8")
      expect(beforeText).toContain("# first")

      await runOrThrow(fileSvc.writeAtomic(file, second))
      const afterText = fs.readFileSync(file, "utf8")
      expect(afterText).toContain("# second")
      expect(afterText).not.toContain("# first")

      const entries = fs.readdirSync(dir)
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"))
      expect(tmpFiles.length).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a notebook that fails schema validation with NotebookValidationError", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "bad.ipynb")
    try {
      const bad = {
        nbformat: 3,
        cells: [],
        metadata: {}
      } as unknown as NotebookRaw
      const result = await Effect.runPromise(
        fileSvc.writeAtomic(file, bad).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(NotebookValidationError)
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("cleans up the .tmp file when the rename fails (dest is a directory)", async () => {
    const fileSvc = makeNotebookFileService()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-"))
    const file = path.join(dir, "out.ipynb")
    const notebook = makeMinimalNotebook("cleanup")
    fs.mkdirSync(file)
    try {
      const result = await Effect.runPromise(
        fileSvc.writeAtomic(file, notebook).pipe(Effect.flip)
      )
      expect(result).toBeInstanceOf(NotebookWriteError)
      const entries = fs.readdirSync(dir)
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"))
      expect(tmpFiles.length).toBe(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
