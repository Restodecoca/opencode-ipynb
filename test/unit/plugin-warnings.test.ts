import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import plugin from "../../src/plugin.js"
import { buildNotebookVirtualDocument } from "../../src/lsp.js"
import {
  materializeVirtualDocument
} from "../../src/virtual-materialize.js"

interface CapturedResult {
  content: string
  metadata?: Record<string, unknown>
}

interface CapturedHook {
  name: string
  callback: (event: unknown) => Promise<void> | void
}

const notebookText = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python", file_extension: ".py" }
  },
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: "x = 1"
    }
  ]
})

const makeSetup = (
  dir: string,
  options: Record<string, unknown>,
  permission?: (input: { action: string; metadata?: Record<string, unknown> }) => Promise<void>
) => {
  const hooks: CapturedHook[] = []
  const context = {
    location: { directory: dir, project: { directory: dir, canonical: dir } },
    options,
    permission: {
      assert: async (input: { action: string; metadata?: Record<string, unknown> }) => {
        await permission?.(input)
      }
    },
    rpc: {
      register: async () => ({
        dispose: async () => {},
        events: { emit: async () => {} }
      })
    },
    tool: {
      transform: async () => ({ dispose: async () => {} }),
      hook: async (name: string, callback: CapturedHook["callback"]) => {
        hooks.push({ name, callback })
        return { dispose: async () => {} }
      }
    }
  }
  return { context, hooks }
}

describe("plugin hook reports swallowed failures", () => {
  const dirs: string[] = []

  const makeDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-hook-warn-"))
    dirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a sidecar cleanup failure when the plugin unloads", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const dir = makeDir()
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    const subdir = path.join(dir, "sub")
    fs.mkdirSync(subdir)
    const nested = path.join(subdir, "notebook.ipynb")
    fs.writeFileSync(nested, notebookText)
    const { context } = makeSetup(dir, { lspDiagnostics: false })
    const cleanup = await plugin.setup(context as never)
    const materialized = await materializeVirtualDocument(
      buildNotebookVirtualDocument(JSON.parse(notebookText) as never, {
        filePath: nested
      }),
      dir
    )
    const target = materialized.path
    const mode = fs.statSync(subdir).mode & 0o777
    fs.chmodSync(subdir, 0o500)
    try {
      const warn = console.warn
      const logged: string[] = []
      console.warn = (message?: unknown) => {
        logged.push(String(message))
      }
      try {
        await cleanup?.()
      } finally {
        console.warn = warn
      }
      expect(fs.existsSync(target)).toBe(true)
      expect(logged.join("\n")).toContain("sidecar-cleanup")
      expect(logged.join("\n")).toContain(path.basename(target))
    } finally {
      fs.chmodSync(subdir, mode)
      fs.rmSync(target, { force: true })
    }
  })

  it("reports a sidecar refresh failure in metadata as well as text", async () => {
    const dir = makeDir()
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    const { context, hooks } = makeSetup(
      dir,
      { lspDiagnostics: false },
      async (input) => {
        if (input.metadata?.operation === "materialize-refresh") {
          throw new Error("refresh denied")
        }
      }
    )
    await plugin.setup(context as never)
    await materializeVirtualDocument(
      buildNotebookVirtualDocument(JSON.parse(notebookText) as never, { filePath: file }),
      dir
    )
    const edited = JSON.parse(notebookText) as { cells: Array<{ source: string }> }
    edited.cells[0]!.source = "y = 2"
    fs.writeFileSync(file, JSON.stringify(edited))
    const hook = hooks.find((candidate) => candidate.name === "execute.after")
    const result: CapturedResult = { content: "Edited", metadata: { changed: true, cellType: "code" } }
    await hook?.callback({
      tool: "ipynb_edit",
      status: "completed",
      input: { filePath: file },
      result
    })
    expect(result.content).toContain("Notebook LSP sidecar was not refreshed: refresh denied")
    expect(result.metadata?.notebookWarnings).toEqual([
      expect.objectContaining({ source: "sidecar-cleanup", message: "refresh denied" })
    ])
  })

  it("reports a swallowed diagnostics failure in metadata instead of dropping it", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const dir = makeDir()
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    const { context, hooks } = makeSetup(dir, { lspDiagnostics: true })
    await plugin.setup(context as never)
    const mode = fs.statSync(file).mode & 0o777
    fs.chmodSync(file, 0o000)
    try {
      const hook = hooks.find((candidate) => candidate.name === "execute.after")
      const result: CapturedResult = {
        content: "Edited",
        metadata: { changed: true, cellType: "code" }
      }
      await hook?.callback({
        tool: "ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result
      })
      expect(result.content).toContain("Notebook diagnostics failed:")
      expect(result.metadata?.notebookWarnings).toEqual([
        expect.objectContaining({
          source: "python-probe",
          detail: expect.stringContaining("notebook.ipynb")
        })
      ])
    } finally {
      fs.chmodSync(file, mode)
    }
  })

  it("keeps a diagnostics temp-file warning in the result metadata", async () => {
    if (process.platform === "win32") return
    const dir = makeDir()
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    const pyright = path.join(dir, "fake-pyright")
    fs.writeFileSync(
      pyright,
      "#!/bin/sh\necho '{\"generalDiagnostics\":[]}'\n",
      "utf8"
    )
    fs.chmodSync(pyright, 0o755)
    const { context, hooks } = makeSetup(dir, {
      lspDiagnostics: true,
      pyrightPath: pyright
    })
    await plugin.setup(context as never)
    const hook = hooks.find((candidate) => candidate.name === "execute.after")
    const result: CapturedResult = {
      content: "Edited",
      metadata: { changed: true, cellType: "code" }
    }
    const original = fs.promises.rm
    const spy = spyOn(fs.promises, "rm").mockImplementation(((
      target: fs.PathLike,
      options?: unknown
    ) => {
      if (String(target).includes("opencode-ipynb-diag-")) {
        return Promise.reject(
          Object.assign(new Error("busy"), { code: "EBUSY" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<void>)(
        target,
        options
      )
    }) as unknown as typeof fs.promises.rm)
    try {
      await hook?.callback({
        tool: "ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result
      })
      expect(result.metadata?.notebookWarnings).toEqual([
        expect.objectContaining({
          source: "temp-unlink",
          detail: expect.stringContaining("opencode-ipynb-diag-")
        })
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it("reports a configured pyright that exists but cannot run", async () => {
    if (process.platform === "win32") return
    const dir = makeDir()
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    const broken = path.join(dir, "broken-pyright")
    fs.writeFileSync(broken, "not executable", "utf8")
    fs.chmodSync(broken, 0o644)
    const { context, hooks } = makeSetup(dir, {
      lspDiagnostics: true,
      pyrightPath: broken
    })
    await plugin.setup(context as never)
    const hook = hooks.find((candidate) => candidate.name === "execute.after")
    const result: CapturedResult = {
      content: "Edited",
      metadata: { changed: true, cellType: "code" }
    }
    await hook?.callback({
      tool: "ipynb_edit",
      status: "completed",
      input: { filePath: file },
      result
    })
    expect(result.metadata?.notebookWarnings).toEqual([
      expect.objectContaining({
        source: "python-probe",
        detail: expect.stringContaining("broken-pyright")
      })
    ])
  })

  it("stays quiet when the default pyright is simply not installed", async () => {
    const original = process.env.PATH
    const dir = makeDir()
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    process.env.PATH = dir
    try {
      const { context, hooks } = makeSetup(dir, {
        lspDiagnostics: true,
        pyrightPath: "pyright"
      })
      await plugin.setup(context as never)
      const hook = hooks.find((candidate) => candidate.name === "execute.after")
      const result: CapturedResult = {
        content: "Edited",
        metadata: { changed: true, cellType: "code" }
      }
      await hook?.callback({
        tool: "ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result
      })
      expect(result.metadata?.notebookWarnings).toBeUndefined()
      expect(result.content).toBe("Edited")
    } finally {
      process.env.PATH = original
    }
  })

  it("stays quiet when diagnostics succeed", async () => {
    const dir = makeDir()
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    const pyright = path.join(dir, "fake-pyright")
    fs.writeFileSync(pyright, "#!/bin/sh\necho '{\"generalDiagnostics\":[]}'\n", "utf8")
    fs.chmodSync(pyright, 0o755)
    const { context, hooks } = makeSetup(dir, {
      lspDiagnostics: true,
      pyrightPath: pyright
    })
    await plugin.setup(context as never)
    const hook = hooks.find((candidate) => candidate.name === "execute.after")
    const result: CapturedResult = { content: "Edited", metadata: { changed: true, cellType: "code" } }
    await hook?.callback({
      tool: "ipynb_edit",
      status: "completed",
      input: { filePath: file },
      result
    })
    expect(result.content).toBe("Edited")
    expect(result.metadata?.notebookWarnings).toBeUndefined()
  })
})

describe("plugin setup tolerates a missing accumulate helper", () => {
  let dir: string

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-hook-setup-"))
  })

  it("still registers the hook when no rpc events are available", async () => {
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(file, notebookText)
    const hooks: CapturedHook[] = []
    const context = {
      location: { directory: dir, project: { directory: dir, canonical: dir } },
      options: { lspDiagnostics: false },
      permission: { assert: async () => {} },
      rpc: {
        register: async () => ({
          dispose: async () => {},
          events: {
            emit: async () => {
              throw new Error("emit failed")
            }
          }
        })
      },
      tool: {
        transform: async () => ({ dispose: async () => {} }),
        hook: async (name: string, callback: CapturedHook["callback"]) => {
          hooks.push({ name, callback })
          return { dispose: async () => {} }
        }
      }
    }
    await plugin.setup(context as never)
    const hook = hooks.find((candidate) => candidate.name === "execute.after")
    const result: CapturedResult = { content: "Edited", metadata: { changed: true } }
    await hook?.callback({
      tool: "ipynb_edit",
      status: "completed",
      input: { filePath: file },
      result
    })
    expect(result.content).toBe("Edited")
    expect(hooks).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
