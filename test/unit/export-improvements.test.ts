import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "../../src/tool.js"
import { makePathService } from "../../src/services/PathService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makeExportImpl, type ExportOptions } from "../../src/services/NotebookExportService.js"

const FIXTURES = path.resolve(__dirname, "..", "fixtures")

const makeFakeContext = (directory: string, worktree: string): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

const runOrThrow = async <A, E>(
  effect: Effect.Effect<A, E, never>
): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, E, never>)

const buildExport = (directory: string, worktree: string) => {
  const pathSvc = makePathService({
    directory,
    worktree,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService()
  const permSvc = makePermissionService(makeFakeContext(directory, worktree))
  return { exportSvc: makeExportImpl(pathSvc, fileSvc, permSvc), pathSvc }
}

const writeNotebook = (dir: string, name: string, notebook: unknown): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, JSON.stringify(notebook))
  return file
}

describe("NotebookExportService > markdown front-matter", () => {
  it("prepends YAML front-matter when includeOutputs is false", async () => {
    const { exportSvc } = buildExport(FIXTURES, FIXTURES)
    const options: ExportOptions = {
      format: "markdown",
      includeOutputs: false,
      includeErrors: true,
      outputPath: undefined,
      maxExportChars: 1_000_000
    }
    const result = await runOrThrow(exportSvc.export(path.join(FIXTURES, "simple.ipynb"), options))

    expect(result.frontMatter).toBeDefined()
    expect(result.frontMatter).toContain("source:")
    expect(result.frontMatter).toContain("kernel: \"Python 3\"")
    expect(result.frontMatter).toContain("language: \"python\"")
    expect(result.frontMatter).toContain("cells: 4")
    expect(result.frontMatter).toContain("code_cells: 2")
    expect(result.frontMatter).toContain("markdown_cells: 2")
    expect(result.frontMatter).toContain("raw_cells: 0")
    expect(result.frontMatter?.startsWith("---")).toBe(true)
    expect(result.frontMatter?.endsWith("---")).toBe(true)
    expect(result.rendered.startsWith("---")).toBe(true)
  })

  it("omits front-matter when includeOutputs is true", async () => {
    const { exportSvc } = buildExport(FIXTURES, FIXTURES)
    const options: ExportOptions = {
      format: "markdown",
      includeOutputs: true,
      includeErrors: true,
      outputPath: undefined,
      maxExportChars: 1_000_000
    }
    const result = await runOrThrow(exportSvc.export(path.join(FIXTURES, "simple.ipynb"), options))

    expect(result.frontMatter).toBeUndefined()
    expect(result.rendered.startsWith("---")).toBe(false)
  })

  it("includes error tracebacks when includeOutputs is false but includeErrors is true", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-errors-"))
    const file = writeNotebook(dir, "errors.ipynb", {
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            { output_type: "stream", name: "stdout", text: "hidden stdout\n" },
            {
              output_type: "error",
              ename: "ValueError",
              evalue: "bad",
              traceback: ["Traceback", "ValueError: bad"]
            }
          ],
          source: "raise ValueError('bad')\n"
        }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    })

    try {
      const { exportSvc } = buildExport(dir, dir)
      const result = await runOrThrow(
        exportSvc.export(file, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: undefined,
          maxExportChars: 1_000_000
        })
      )

      expect(result.rendered).toContain("**ValueError**: bad")
      expect(result.rendered).toContain("ValueError: bad")
      expect(result.rendered).not.toContain("hidden stdout")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("omits errors when includeErrors is false", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-no-errors-"))
    const file = writeNotebook(dir, "errors.ipynb", {
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [
            {
              output_type: "error",
              ename: "ValueError",
              evalue: "bad",
              traceback: ["Traceback", "ValueError: bad"]
            }
          ],
          source: "raise ValueError('bad')\n"
        }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    })

    try {
      const { exportSvc } = buildExport(dir, dir)
      const result = await runOrThrow(
        exportSvc.export(file, {
          format: "markdown",
          includeOutputs: true,
          includeErrors: false,
          outputPath: undefined,
          maxExportChars: 1_000_000
        })
      )

      expect(result.rendered).not.toContain("**ValueError**: bad")
      expect(result.rendered).not.toContain("ValueError: bad")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to 'unknown' kernel and language when metadata is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-fm-"))
    const file = writeNotebook(dir, "bare.ipynb", {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: "x = 1\n"
        }
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    })

    try {
      const { exportSvc } = buildExport(dir, dir)
      const result = await runOrThrow(
        exportSvc.export(file, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: undefined,
          maxExportChars: 1_000_000
        })
      )

      expect(result.frontMatter).toBeDefined()
      expect(result.frontMatter).toContain("kernel: \"unknown\"")
      expect(result.frontMatter).toContain("language: \"unknown\"")
      expect(result.frontMatter).toContain("code_cells: 1")
      expect(result.frontMatter).toContain("markdown_cells: 0")
      expect(result.frontMatter).toContain("raw_cells: 0")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses kernelspec.name when display_name is absent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-fm-"))
    const file = writeNotebook(dir, "named.ipynb", {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: "x = 1\n"
        }
      ],
      metadata: {
        kernelspec: { name: "python3", language: "python" },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })

    try {
      const { exportSvc } = buildExport(dir, dir)
      const result = await runOrThrow(
        exportSvc.export(file, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: undefined,
          maxExportChars: 1_000_000
        })
      )

      expect(result.frontMatter).toContain("kernel: \"python3\"")
      expect(result.frontMatter).toContain("language: \"python\"")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("NotebookExportService > summary mode grouping", () => {
  it("groups cells by type with counts, per-type sections, and ascending indexes", async () => {
    const { exportSvc } = buildExport(FIXTURES, FIXTURES)
    const result = await runOrThrow(
      exportSvc.export(path.join(FIXTURES, "simple.ipynb"), {
        format: "summary",
        includeOutputs: false,
        includeErrors: true,
        outputPath: undefined,
        maxExportChars: 1_000_000
      })
    )

    expect(result.rendered).toContain("# Notebook Summary")
    expect(result.rendered).toContain("## Counts")
    expect(result.rendered).toContain("- total: 4")
    expect(result.rendered).toContain("- code: 2")
    expect(result.rendered).toContain("- markdown: 2")
    expect(result.rendered).toContain("- raw: 0")

    expect(result.rendered).toContain("## Code cells")
    expect(result.rendered).toContain("## Markdown cells")
    expect(result.rendered).not.toContain("## Raw cells")

    const codeSection = extractSection(result.rendered, "## Code cells")
    const codeLines = codeSection.filter((l) => l.startsWith("- ["))
    expect(codeLines.length).toBe(2)
    expect(codeLines[0]).toBe("- [1] | x = 1 | exec=null | outputs=0")
    expect(codeLines[1]).toMatch(/^- \[3\] \| def greet\(name\): \| exec=null \| outputs=0$/)

    const mdSection = extractSection(result.rendered, "## Markdown cells")
    const mdLines = mdSection.filter((l) => l.startsWith("- ["))
    expect(mdLines.length).toBe(2)
    expect(mdLines[0]).toBe("- [0] | # Simple Notebook")
    expect(mdLines[1]).toBe("- [2] | ## Section")
  })

  it("includes a Raw cells section when raw cells exist", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-sum-"))
    const file = writeNotebook(dir, "with-raw.ipynb", {
      cells: [
        {
          cell_type: "raw",
          metadata: {},
          source: "raw-cell-content"
        },
        {
          cell_type: "code",
          execution_count: 3,
          metadata: {},
          outputs: [{ output_type: "stream", name: "stdout", text: "hi" }],
          source: "print('hi')"
        }
      ],
      metadata: {
        kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })

    try {
      const { exportSvc } = buildExport(dir, dir)
      const result = await runOrThrow(
        exportSvc.export(file, {
          format: "summary",
          includeOutputs: false,
          includeErrors: true,
          outputPath: undefined,
          maxExportChars: 1_000_000
        })
      )

      expect(result.rendered).toContain("## Raw cells")
      expect(result.rendered).toContain("- raw: 1")
      const rawSection = extractSection(result.rendered, "## Raw cells")
      const rawLines = rawSection.filter((l) => l.startsWith("- ["))
      expect(rawLines.length).toBe(1)
      expect(rawLines[0]).toBe("- [0] | raw-cell-content")

      const codeSection = extractSection(result.rendered, "## Code cells")
      const codeLines = codeSection.filter((l) => l.startsWith("- ["))
      expect(codeLines[0]).toBe("- [1] | print('hi') | exec=3 | outputs=1")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("truncates the first line of each cell to 120 chars with an ellipsis", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-sum-"))
    const longLine = "x = " + "a".repeat(200)
    const file = writeNotebook(dir, "long.ipynb", {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: `${longLine}\ny = 2`
        }
      ],
      metadata: {
        kernelspec: { display_name: "Python 3", name: "python3", language: "python" },
        language_info: { name: "python" }
      },
      nbformat: 4,
      nbformat_minor: 5
    })

    try {
      const { exportSvc } = buildExport(dir, dir)
      const result = await runOrThrow(
        exportSvc.export(file, {
          format: "summary",
          includeOutputs: false,
          includeErrors: true,
          outputPath: undefined,
          maxExportChars: 1_000_000
        })
      )

      const codeSection = extractSection(result.rendered, "## Code cells")
      const codeLines = codeSection.filter((l) => l.startsWith("- ["))
      expect(codeLines.length).toBe(1)
      const line = codeLines[0]
      if (!line) throw new Error("expected one code line")

      expect(line.endsWith("... | exec=null | outputs=0")).toBe(true)
      const firstLineContent = line.split(" | ")[1] ?? ""
      expect(firstLineContent.length).toBe(123)
      expect(firstLineContent.endsWith("...")).toBe(true)
      expect(result.rendered).not.toContain("a".repeat(200))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

const extractSection = (text: string, heading: string): string[] => {
  const lines = text.split("\n")
  const start = lines.findIndex((l) => l === heading)
  if (start === -1) return []
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "))
  return lines.slice(start + 1, end === -1 ? lines.length : end)
}

describe("NotebookExportService > write safety", () => {
  it("refuses to overwrite the source notebook", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-self-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), file)
    const before = fs.readFileSync(file, "utf8")
    const { exportSvc } = buildExport(dir, dir)
    try {
      const result = await Effect.runPromiseExit(
        exportSvc.export(file, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: file,
          maxExportChars: 60_000
        })
      )
      expect(result._tag).toBe("Failure")
      expect(fs.readFileSync(file, "utf8")).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes the full export to disk while capping the tool output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-full-"))
    const file = path.join(dir, "notebook.ipynb")
    const out = path.join(dir, "out.py")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: Array.from({ length: 80 }, (_, index) => ({
          cell_type: "code",
          execution_count: null,
          metadata: {},
          outputs: [],
          source: `value_${index} = "${"x".repeat(80)}"`
        }))
      })
    )
    const { exportSvc } = buildExport(dir, dir)
    try {
      const result = await runOrThrow(
        exportSvc.export(file, {
          format: "python",
          includeOutputs: false,
          includeErrors: true,
          outputPath: out,
          maxExportChars: 200
        })
      )
      expect(result.rendered.length).toBeGreaterThan(200)
      expect(fs.statSync(out).size).toBe(result.rendered.length)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("creates nested outside directories when allowOutsideWorktree is enabled", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-out-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-out-dir-"))
    const source = path.join(worktree, "notebook.ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), source)
    const out = path.join(outside, "nested", "out.md")
    const pathSvc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform,
      allowOutsideWorktree: true
    })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeFakeContext(worktree, worktree))
    const exportSvc = makeExportImpl(pathSvc, fileSvc, permSvc)
    try {
      const result = await runOrThrow(
        exportSvc.export(source, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: out,
          maxExportChars: 60_000
        })
      )
      expect(fs.existsSync(out)).toBe(true)
      expect(fs.readFileSync(out, "utf8").length).toBe(result.rendered.length)
    } finally {
      fs.rmSync(worktree, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("refuses to overwrite the source through a symlink alias", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-alias-"))
    const source = path.join(dir, "notebook.txt")
    const alias = path.join(dir, "alias.txt")
    const body = JSON.parse(fs.readFileSync(path.join(FIXTURES, "simple.ipynb"), "utf8"))
    fs.writeFileSync(source, JSON.stringify(body))
    fs.symlinkSync(source, alias)
    const before = fs.readFileSync(source, "utf8")
    const { exportSvc } = buildExport(dir, dir)
    try {
      const result = await Effect.runPromiseExit(
        exportSvc.export(alias, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: source,
          maxExportChars: 60_000
        })
      )
      expect(result._tag).toBe("Failure")
      expect(fs.readFileSync(source, "utf8")).toBe(before)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses to overwrite a different notebook through a symlinked output", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-victim-"))
    const source = path.join(dir, "source.ipynb")
    const victim = path.join(dir, "victim.ipynb")
    const out = path.join(dir, "out.txt")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), source)
    fs.copyFileSync(path.join(FIXTURES, "outputs.ipynb"), victim)
    fs.symlinkSync(victim, out)
    const before = fs.readFileSync(victim, "utf8")
    const { exportSvc } = buildExport(dir, dir)
    try {
      const result = await Effect.runPromiseExit(
        exportSvc.export(source, {
          format: "python",
          includeOutputs: false,
          includeErrors: true,
          outputPath: out,
          maxExportChars: 60_000
        })
      )
      expect(result._tag).toBe("Failure")
      expect(fs.readFileSync(victim, "utf8")).toBe(before)
      expect(fs.lstatSync(out).isSymbolicLink()).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a hidden .ipynb output name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-hidden-"))
    const source = path.join(dir, "source.ipynb")
    const out = path.join(dir, ".ipynb")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), source)
    const { exportSvc } = buildExport(dir, dir)
    try {
      const result = await Effect.runPromiseExit(
        exportSvc.export(source, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: out,
          maxExportChars: 60_000
        })
      )
      expect(result._tag).toBe("Failure")
      expect(fs.existsSync(out)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes the pinned target when the output symlink is swapped during the prompt", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-swap-"))
    const source = path.join(dir, "source.ipynb")
    const victim = path.join(dir, "victim.ipynb")
    const target = path.join(dir, "target.txt")
    const out = path.join(dir, "out.md")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), source)
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), victim)
    fs.writeFileSync(target, "ORIGINAL")
    fs.symlinkSync(target, out)
    const victimBefore = fs.readFileSync(victim, "utf8")
    const context = {
      ...makeFakeContext(dir, dir),
      ask: async () => {
        fs.unlinkSync(out)
        fs.symlinkSync(victim, out)
      }
    } as unknown as ToolContext
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const permSvc = makePermissionService(context)
    const exportSvc = makeExportImpl(pathSvc, makeNotebookFileService(), permSvc)
    try {
      await runOrThrow(
        exportSvc.export(source, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: out,
          maxExportChars: 1_000_000
        })
      )
      expect(fs.readFileSync(victim, "utf8")).toBe(victimBefore)
      expect(fs.readFileSync(target, "utf8")).toContain("source:")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses when the pinned target itself becomes a symlink during the prompt", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-pinned-swap-"))
    const source = path.join(dir, "source.ipynb")
    const victim = path.join(dir, "victim.ipynb")
    const target = path.join(dir, "target.txt")
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), source)
    fs.copyFileSync(path.join(FIXTURES, "simple.ipynb"), victim)
    fs.writeFileSync(target, "ORIGINAL")
    const victimBefore = fs.readFileSync(victim, "utf8")
    const context = {
      ...makeFakeContext(dir, dir),
      ask: async () => {
        fs.rmSync(target)
        fs.symlinkSync(victim, target)
      }
    } as unknown as ToolContext
    const pathSvc = makePathService({ directory: dir, worktree: dir, platform: process.platform })
    const permSvc = makePermissionService(context)
    const exportSvc = makeExportImpl(pathSvc, makeNotebookFileService(), permSvc)
    try {
      const exit = await Effect.runPromiseExit(
        exportSvc.export(source, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: target,
          maxExportChars: 1_000_000
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(fs.readFileSync(victim, "utf8")).toBe(victimBefore)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes full text outputs to the export file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-full-"))
    const source = path.join(dir, "source.ipynb")
    const out = path.join(dir, "out.md")
    fs.writeFileSync(
      source,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "code",
            execution_count: 1,
            metadata: {},
            outputs: [
              { output_type: "stream", name: "stdout", text: "X".repeat(10_000) }
            ],
            source: "print('x')"
          }
        ]
      })
    )
    const { exportSvc } = buildExport(dir, dir)
    try {
      await runOrThrow(
        exportSvc.export(source, {
          format: "markdown",
          includeOutputs: true,
          includeErrors: true,
          outputPath: out,
          maxExportChars: 1_000_000
        })
      )
      const written = fs.readFileSync(out, "utf8")
      expect(written).toContain("X".repeat(10_000))
      expect(written).not.toContain("maxOutputChars to increase")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("inlines markdown-cell PNG attachments in the export", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-mdimg-"))
    const source = path.join(dir, "source.ipynb")
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3r9wAAAABJRU5ErkJggg=="
    fs.writeFileSync(
      source,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: "![x](attachment:plot.png)",
            attachments: { "plot.png": { "image/png": tinyPng } }
          }
        ]
      })
    )
    const { exportSvc } = buildExport(dir, dir)
    try {
      const result = await runOrThrow(
        exportSvc.export(source, {
          format: "markdown",
          includeOutputs: false,
          includeErrors: true,
          outputPath: undefined,
          maxExportChars: 1_000_000
        })
      )
      expect(result.rendered).toContain(`data:image/png;base64,${tinyPng}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})

describe("export output must use an export extension", () => {
  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", file_extension: ".py" }
    },
    cells: [
      { cell_type: "markdown", metadata: {}, source: "# Title" },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: "print(1)"
      }
    ]
  }

  it("refuses to overwrite .env, package.json and id_rsa", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-ext-"))
    try {
      const file = writeNotebook(dir, "n.ipynb", notebook)
      const { exportSvc } = buildExport(dir, dir)
      for (const name of [".env", "package.json", "id_rsa"]) {
        const target = path.join(dir, name)
        fs.writeFileSync(target, "SENSITIVE")
        const before = fs.readFileSync(target, "utf8")
        const exit = await Effect.runPromiseExit(
          exportSvc.export(file, {
            format: "markdown",
            outputPath: target,
            includeOutputs: false,
            maxOutputChars: 10_000
          } as never)
        )
        expect(exit._tag).toBe("Failure")
        expect(fs.readFileSync(target, "utf8")).toBe(before)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("still writes a normal markdown export", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-export-ok-"))
    try {
      const file = writeNotebook(dir, "n.ipynb", notebook)
      const { exportSvc } = buildExport(dir, dir)
      const target = path.join(dir, "out.md")
      await runOrThrow(
        exportSvc.export(file, {
          format: "markdown",
          outputPath: target,
          includeOutputs: false,
          maxOutputChars: 10_000
        } as never)
      )
      expect(fs.readFileSync(target, "utf8")).toContain("# Title")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
