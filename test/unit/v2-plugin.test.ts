import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { z } from "zod"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import plugin from "../../src/plugin.js"
import { registerV2Tools, toV2Result, type V2ToolRegistration } from "../../src/plugin-v2.js"
import { tool, type ToolContext } from "../../src/tool.js"
import { ipynbEditTool } from "../../src/tools/edit.js"
import { buildNotebookVirtualDocument } from "../../src/lsp.js"
import { materializeVirtualDocument } from "../../src/virtual-materialize.js"

const TOOL_NAMES = [
  "ipynb_inspect",
  "ipynb_read",
  "ipynb_edit",
  "ipynb_cell_insert",
  "ipynb_cell_delete",
  "ipynb_cell_move",
  "ipynb_run",
  "ipynb_outputs",
  "ipynb_clean",
  "ipynb_export",
  "ipynb_doctor",
  "ipynb_repro",
  "ipynb_kernel",
  "ipynb_lsp"
] as const

const EXPECTED_PERMISSIONS: Record<(typeof TOOL_NAMES)[number], string | undefined> = {
  ipynb_inspect: "read",
  ipynb_read: "read",
  ipynb_edit: "edit",
  ipynb_cell_insert: "edit",
  ipynb_cell_delete: "edit",
  ipynb_cell_move: "edit",
  ipynb_run: "shell",
  ipynb_outputs: undefined,
  ipynb_clean: "edit",
  ipynb_export: undefined,
  ipynb_doctor: undefined,
  ipynb_repro: "read",
  ipynb_kernel: undefined,
  ipynb_lsp: "lsp"
}

interface CapturedTool {
  name: string
  description: string
  input: { type?: string; properties?: Record<string, { type?: string }> }
  options?: { permission?: string; codemode?: boolean }
  execute: (input: unknown, context: unknown) => Promise<{
    content: unknown
    metadata?: Record<string, unknown>
  }>
}

interface PermissionCall {
  sessionID: string
  agent?: string
  source?: { type: string; messageID: string; id: string }
  action: string
  resources: ReadonlyArray<string>
  save?: ReadonlyArray<string>
  metadata?: Record<string, unknown>
}

interface CapturedSetup {
  rpc: Array<{
    definition: { id?: string }
    handlers: Record<string, (input: unknown, context?: unknown) => Promise<unknown>>
  }>
  hooks: Array<{ name: string; callback: (event: unknown) => Promise<void> | void }>
  emitted: Array<{ name: string; data: unknown }>
}

const makeContext = (
  captured: CapturedTool[],
  permissionCalls: PermissionCall[] = [],
  disposed: { value: boolean } = { value: false },
  options: Record<string, unknown> = {},
  setup?: CapturedSetup
) => ({
  location: {
    directory: "/session-dir",
    project: { directory: "/workspace", canonical: "/workspace-main" }
  },
  options,
  permission: {
    assert: async (input: PermissionCall) => {
      permissionCalls.push(input)
    }
  },
  rpc: {
    register: async (
      definition: { id?: string },
      handlers: Record<string, (input: unknown, context?: unknown) => Promise<unknown>>
    ) => {
      setup?.rpc.push({ definition, handlers })
      return {
        dispose: async () => {},
        events: {
          emit: async (name: string, data: unknown) => {
            setup?.emitted.push({ name, data })
          }
        }
      }
    }
  },
  tool: {
    transform: async (
      callback: (editor: {
        add: (tool: CapturedTool) => void
        namespace: () => void
      }) => void
    ) => {
      callback({
        add: (registered) => captured.push(registered),
        namespace: () => {}
      })
      return {
        dispose: async () => {
          disposed.value = true
        }
      }
    },
    hook: async (
      name: string,
      callback: (event: unknown) => Promise<void> | void
    ) => {
      setup?.hooks.push({ name, callback })
      return { dispose: async () => {} }
    }
  }
})

const makeToolContext = () => {
  const controller = new AbortController()
  return {
    sessionID: "ses_1",
    messageID: "msg_1",
    agent: "build",
    id: "call_1",
    signal: controller.signal,
    progress: async () => {}
  }
}

const ENV_VARS = ["OPENCODE_IPYNB_OPTIONS", "OPENCODE_IPYNB_PYTHON"] as const
const ORIGINAL_ENV = Object.fromEntries(ENV_VARS.map((key) => [key, process.env[key]]))

const restoreEnv = () => {
  for (const key of ENV_VARS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe("V2 plugin entrypoint", () => {
  beforeEach(restoreEnv)
  afterEach(restoreEnv)

  it("default export is a V2 definition only", () => {
    expect(typeof plugin).toBe("object")
    expect(plugin.id).toBe("opencode-ipynb")
    expect(typeof plugin.setup).toBe("function")
    expect("server" in plugin).toBe(false)
  })

  it("setup registers all fourteen tools with JSON Schema inputs", async () => {
    const captured: CapturedTool[] = []
    const cleanup = await plugin.setup(makeContext(captured) as never)

    expect(captured.map((entry) => entry.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const entry of captured) {
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.input.type).toBe("object")
      expect(typeof entry.execute).toBe("function")
    }
    expect(captured.find((entry) => entry.name === "ipynb_read")?.input.properties?.filePath?.type).toBe("string")
    expect(typeof cleanup).toBe("function")
  })

  it("maps every tool to its V2 permission name", async () => {
    const captured: CapturedTool[] = []
    await plugin.setup(makeContext(captured) as never)

    for (const name of TOOL_NAMES) {
      const entry = captured.find((candidate) => candidate.name === name)
      expect(entry?.options?.permission).toBe(EXPECTED_PERMISSIONS[name])
      expect(entry?.options?.codemode).toBe(false)
    }
  })

  it("disposes plugin registrations on cleanup", async () => {
    const captured: CapturedTool[] = []
    const disposed = { value: false }
    const cleanup = await plugin.setup(
      makeContext(captured, [], disposed) as never
    )

    expect(typeof cleanup).toBe("function")
    await (cleanup as () => Promise<void>)()
    expect(disposed.value).toBe(true)
  })

  it("rejects invalid plugin options during setup", async () => {
    const captured: CapturedTool[] = []
    await expect(
      plugin.setup(
        makeContext(captured, [], { value: false }, {
          defaultTimeoutMs: -1
        }) as never
      )
    ).rejects.toThrow()
  })
})

describe("V2 tool adapter", () => {
  it("strips undefined metadata values recursively so the host keeps the result", () => {
    expect(
      toV2Result({
        output: "x",
        metadata: {
          absent: undefined,
          nested: { absent: undefined, kept: 1 },
          list: [1, undefined, 2]
        }
      }).metadata
    ).toEqual({ nested: { kept: 1 }, list: [1, 2] })
  })

  it("converts tool results into V2 content, files, and metadata", async () => {
    const captured: { input: { name: string; greeting: string }; context: ToolContext }[] = []
    const definition = tool({
      description: "Synthetic tool",
      args: {
        name: z.string(),
        greeting: z.string().optional().default("hi")
      },
      async execute(input, context) {
        captured.push({ input, context })
        return {
          title: "Synthetic",
          output: `Hello ${input.name}`,
          metadata: { ok: true },
          attachments: [
            {
              type: "file" as const,
              mime: "image/png",
              url: "data:image/png;base64,AAA",
              filename: "chart.png"
            },
            {
              type: "file" as const,
              mime: "image/svg+xml",
              url: "data:image/svg+xml;base64,BBB"
            }
          ]
        }
      }
    })

    const registered: CapturedTool[] = []
    const context = makeContext(registered)
    await registerV2Tools(
      context as never,
      [{ name: "synthetic", definition }] as V2ToolRegistration[]
    )

    const v2Context = makeToolContext()
    const result = await registered[0]!.execute({ name: "Ada" }, v2Context)

    expect(result.content).toEqual([
      { type: "text", text: "Hello Ada" },
      { type: "file", uri: "data:image/png;base64,AAA", mime: "image/png", name: "chart.png" },
      { type: "file", uri: "data:image/svg+xml;base64,BBB", mime: "image/svg+xml" }
    ])
    expect(result.metadata).toEqual({ ok: true, title: "Synthetic" })
    expect(captured[0]!.input.greeting).toBe("hi")
    expect(captured[0]!.context.directory).toBe("/session-dir")
    expect(captured[0]!.context.worktree).toBe("/workspace")
    expect(captured[0]!.context.sessionID).toBe("ses_1")
    expect(captured[0]!.context.abort).toBe(v2Context.signal)
  })

  it("returns a plain string when the tool returns one", () => {
    expect(toV2Result("plain")).toEqual({ content: "plain" })
  })

  it("passes the plugin instance options through the tool context", async () => {
    let seen: unknown
    const definition = tool({
      description: "Reads options",
      args: {},
      async execute(_input, context) {
        seen = context.pluginOptions
        return "ok"
      }
    })

    const registered: CapturedTool[] = []
    const context = makeContext(registered, [], { value: false }, {
      pythonPath: "/opt/python",
      warmKernel: true
    })
    await registerV2Tools(context as never, [{ name: "options", definition }])

    await registered[0]!.execute({}, makeToolContext())
    expect(seen).toEqual({ pythonPath: "/opt/python", warmKernel: true })
  })

  it("routes ctx.ask through ctx.permission.assert with V2 action names", async () => {
    const permissionCalls: PermissionCall[] = []
    const definition = tool({
      description: "Asks",
      args: { value: z.string() },
      async execute(input, context) {
        await context.ask({
          permission: "bash",
          patterns: ["/usr/bin/python", "/work/helper.py"],
          always: ["/work/notebook.ipynb"],
          metadata: { filePath: "/work/notebook.ipynb" }
        })
        return input.value
      }
    })

    const registered: CapturedTool[] = []
    await registerV2Tools(
      makeContext(registered, permissionCalls) as never,
      [{ name: "runner", definition, permission: "shell" }]
    )

    const result = await registered[0]!.execute({ value: "ok" }, makeToolContext())

    expect(result.content).toBe("ok")
    expect(permissionCalls).toHaveLength(1)
    expect(permissionCalls[0]).toEqual({
      sessionID: "ses_1",
      agent: "build",
      source: { type: "tool", messageID: "msg_1", id: "call_1" },
      action: "shell",
      resources: ["/usr/bin/python", "/work/helper.py"],
      save: ["/work/notebook.ipynb"],
      metadata: { filePath: "/work/notebook.ipynb" }
    })
  })

  it("reports validation errors as tool content", async () => {
    const definition = tool({
      description: "Needs a name",
      args: { name: z.string() },
      async execute(input) {
        return input.name
      }
    })

    const registered: CapturedTool[] = []
    await registerV2Tools(makeContext(registered) as never, [
      { name: "needs_name", definition }
    ])

    const result = await registered[0]!.execute({}, makeToolContext())
    expect(String(result.content)).toStartWith("Error:")
    expect(result.metadata?.error).toBe(true)
  })

  it("declares the requested permission on the V2 definition", async () => {
    const definition = tool({
      description: "Writes",
      args: { value: z.string() },
      async execute(input) {
        return input.value
      }
    })

    const registered: CapturedTool[] = []
    await registerV2Tools(makeContext(registered) as never, [
      { name: "writer", definition, permission: "edit" }
    ])

    expect(registered[0]!.options?.permission).toBe("edit")
  })
})

describe("LSP integration", () => {
  it("exposes a virtual notebook document and emits changed after edits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-lsp-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
          language_info: { name: "python", file_extension: ".py" }
        },
        cells: [
          {
            cell_type: "markdown",
            metadata: {},
            source: "# Title"
          },
          {
            cell_type: "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: ["x = 1\n", "print(x)"]
          },
          {
            cell_type: "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: "y = 2"
          }
        ]
      })
    )

    const captured: CapturedTool[] = []
    const setup: CapturedSetup = { rpc: [], hooks: [], emitted: [] }
    const context = {
      ...makeContext(captured, [], { value: false }, { lspDiagnostics: false }, setup),
      location: {
        directory: dir,
        project: { directory: dir, canonical: dir }
      }
    }
    const cleanup = await plugin.setup(context as never)

    try {
      const rpc = setup.rpc[0]
      expect(rpc?.definition.id).toBe("opencode-ipynb")
      const document = (await rpc?.handlers.document?.({ filePath: file }, {})) as {
        notebookUri: string
        languageId: string
        fileExtension?: string
        kernelName?: string
        text: string
        sanitizedText?: string
        cells: Array<{
          cellIndex: number
          cellType: string
          languageId: string
          text: string
          uri?: string
          startLine: number
          endLine: number
          lineCount: number
        }>
      }
      const notebookUri = pathToFileURL(file).href
      expect(document.notebookUri).toBe(notebookUri)
      expect(document.languageId).toBe("python")
      expect(document.fileExtension).toBe(".py")
      expect(document.kernelName).toBe("python3")
      expect(document.text).toBe("x = 1\nprint(x)\ny = 2")
      expect(document.sanitizedText).toBe("x = 1\nprint(x)\ny = 2")
      expect(document.cells).toEqual([
        {
          cellIndex: 1,
          cellType: "code",
          languageId: "python",
          text: "x = 1\nprint(x)",
          uri: `${notebookUri}#cell=1`,
          startLine: 0,
          endLine: 2,
          lineCount: 2
        },
        {
          cellIndex: 2,
          cellType: "code",
          languageId: "python",
          text: "y = 2",
          uri: `${notebookUri}#cell=2`,
          startLine: 2,
          endLine: 3,
          lineCount: 1
        }
      ])

      const hook = setup.hooks.find((candidate) => candidate.name === "execute.after")
      const sidecar = await materializeVirtualDocument(
        buildNotebookVirtualDocument(
          JSON.parse(fs.readFileSync(file, "utf8")) as never,
          { filePath: file }
        ),
        dir
      )
      const edited = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string | string[] }>
      }
      edited.cells[2]!.source = "y = 3"
      fs.writeFileSync(file, JSON.stringify(edited))
      await hook?.callback({
        tool: "ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result: { metadata: { changed: true, cellType: "code" } }
      })
      expect(setup.emitted).toEqual([{ name: "changed", data: { filePath: file } }])
      expect(fs.readFileSync(sidecar.path, "utf8")).toContain("y = 3")

      setup.emitted.length = 0
      await hook?.callback({
        tool: "ipynb_edit",
        status: "error",
        input: { filePath: file }
      })
      await hook?.callback({
        tool: "ipynb_cell_move",
        status: "completed",
        input: { filePath: file, fromIndex: 1, toIndex: 1 },
        result: { metadata: {} }
      })
      await hook?.callback({
        tool: "ipynb_outputs",
        status: "completed",
        input: { filePath: file, operation: "clear_all" },
        result: { metadata: { removedOutputs: 0, removedExecutionCounts: 0 } }
      })
      await hook?.callback({
        tool: "ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result: { metadata: { error: true } }
      })
      await hook?.callback({ tool: "ipynb_read", status: "completed", input: { filePath: file } })
      expect(setup.emitted).toEqual([])

      await hook?.callback({
        tool: "ipynb_outputs",
        status: "completed",
        input: { filePath: file, operation: "clear_all" },
        result: { metadata: { removedOutputs: 1, removedExecutionCounts: 1 } }
      })
      expect(setup.emitted).toEqual([{ name: "changed", data: { filePath: file } }])

      setup.emitted.length = 0
      await hook?.callback({
        tool: "acme_ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result: { metadata: { cellType: "code" } }
      })
      expect(setup.emitted).toEqual([{ name: "changed", data: { filePath: file } }])
    } finally {
      if (cleanup) await cleanup()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("permission propagation", () => {
  it("rethrows a rejected permission request instead of returning tool content", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
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
    )
    const context = {
      sessionID: "ses_1",
      messageID: "msg_1",
      agent: "build",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {
        throw new Error("user rejected")
      }
    } satisfies ToolContext

    try {
      await expect(
        ipynbEditTool.execute(
          { filePath: file, cellIndex: 0, source: "x = 2", clearOutputs: "auto" },
          context
        )
      ).rejects.toThrow("user rejected")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("appends diagnostics to a completed edit result and exposes cell metadata", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-hook-diag-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
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
    )
    const fake = path.join(dir, "fake-pyright")
    fs.writeFileSync(
      fake,
      `#!/bin/sh
for last; do :; done
cat <<EOF
{"generalDiagnostics":[{"file":"$last","severity":"error","message":"boom","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}}]}
EOF
`,
      "utf8"
    )
    fs.chmodSync(fake, 0o755)
    const captured: CapturedTool[] = []
    const setup: CapturedSetup = { rpc: [], hooks: [], emitted: [] }
    const context = {
      ...makeContext(captured, [], { value: false }, {
        lspDiagnostics: true,
        pyrightPath: fake
      }, setup),
      location: { directory: dir, project: { directory: dir, canonical: dir } }
    }
    const cleanup = await plugin.setup(context as never)
    try {
      const hook = setup.hooks.find((candidate) => candidate.name === "execute.after")
      const result: {
        content: string
        metadata: Record<string, unknown>
      } = { content: "Edited", metadata: { cellType: "code", changed: true } }
      await hook?.callback({
        tool: "ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result
      })
      expect(result.content).toContain("LSP errors detected in this file")
      expect(result.content).toContain("boom")
      expect(result.metadata.notebookDiagnostics).toEqual([
        expect.objectContaining({ cellIndex: 0, message: "boom" })
      ])
    } finally {
      if (cleanup) await cleanup()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a sidecar refresh failure instead of silently leaving it stale", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-sidecar-note-"))
    const file = path.join(dir, "notebook.ipynb")
    fs.writeFileSync(
      file,
      JSON.stringify({
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
    )
    const setup: CapturedSetup = { rpc: [], hooks: [], emitted: [] }
    const base = makeContext([], [], { value: false }, { lspDiagnostics: false }, setup)
    const context = {
      ...base,
      location: {
        directory: dir,
        project: { directory: dir, canonical: dir }
      },
      permission: {
        assert: async (call: PermissionCall) => {
          if (call.metadata?.operation === "materialize-refresh") {
            throw new Error("refresh denied")
          }
        }
      }
    }
    const cleanup = await plugin.setup(context as never)
    try {
      await materializeVirtualDocument(
        buildNotebookVirtualDocument(
          JSON.parse(fs.readFileSync(file, "utf8")) as never,
          { filePath: file }
        ),
        dir
      )
      const edited = JSON.parse(fs.readFileSync(file, "utf8")) as {
        cells: Array<{ source: string }>
      }
      edited.cells[0]!.source = "y = 2"
      fs.writeFileSync(file, JSON.stringify(edited))
      const hook = setup.hooks.find((candidate) => candidate.name === "execute.after")
      const result: { content: string; metadata: Record<string, unknown> } = {
        content: "Edited",
        metadata: { changed: true, cellType: "code" }
      }
      await hook?.callback({
        tool: "ipynb_edit",
        status: "completed",
        input: { filePath: file },
        result
      })
      expect(result.content).toContain("Notebook LSP sidecar was not refreshed: refresh denied")
    } finally {
      if (cleanup) await cleanup()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})
