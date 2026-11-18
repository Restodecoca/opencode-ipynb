import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { Cause, Effect } from "effect"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { makeKernelManager } from "../../src/services/KernelManager.js"
import type { KernelManagerShape } from "../../src/services/KernelManager.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import { makePythonService, type PythonServiceShape } from "../../src/services/PythonService.js"
import { makeWarningSink } from "../../src/utils/warnings.js"
import { NotebookValidationError } from "../../src/domain/errors.js"
import { DEFAULT_NOTEBOOK_FORMAT } from "../../src/utils/json.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"
import {
  cleanupVirtualDocuments,
  hasMaterializedDocument,
  materializeVirtualDocument
} from "../../src/virtual-materialize.js"
import { buildNotebookVirtualDocument } from "../../src/lsp.js"
import {
  diagnoseNotebook,
  diagnosticTempPath
} from "../../src/notebook-diagnostics.js"
import type { ToolContext } from "../../src/tool.js"

const notebook = {
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
}

const makeContext = (dir: string): ToolContext =>
  ({
    sessionID: "t",
    messageID: "t",
    agent: "t",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

const writeScript = (dir: string, name: string, body: string): string => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body, "utf8")
  fs.chmodSync(file, 0o755)
  return file
}

const shellHelper = (dir: string, preamble: string): string =>
  writeScript(
    dir,
    "helper.sh",
    `#!/bin/sh
${preamble}
IFS= read -r init
printf '{"ready": true, "pid": %s, "kernelPid": %s}\\n' "$$" "$$"
IFS= read -r req
id=$(printf '%s' "$req" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
nonce=$(printf '%s' "$req" | sed -n 's/.*"nonce"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\\1/p')
printf '{"id": %s, "nonce": "%s", "success": true, "executedCells": [], "durationMs": 1, "outputs": []}\\n' "$id" "$nonce"
`
  )

const fakeKernel = (): KernelManagerShape =>
  ({
    execute: () =>
      Effect.succeed({
        success: true,
        executedCells: [0],
        durationMs: 1,
        outputs: [{ cellIndex: 0, status: "ok" as const, stdout: "ok\n" }]
      })
  }) as unknown as KernelManagerShape

const fakePython = (): PythonServiceShape =>
  ({
    probe: () =>
      Effect.succeed({
        pythonPath: "/usr/bin/python3",
        version: "3",
        executable: "python3",
        from: "options" as const
      }),
    findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
    checkDependencies: () => Effect.succeed([]),
    candidates: () => Effect.succeed([]),
    checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
    doctor: () => Effect.succeed({} as never)
  }) as unknown as PythonServiceShape

describe("swallowed failures stay observable", () => {
  afterEach(() => {
    if (restore.length > 0) {
      for (const undo of restore.splice(0)) undo()
    }
  })
  const restore: Array<() => void> = []

  it("records a kernel warning for a non-protocol stdout line", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-kernel-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const helper = shellHelper(dir, `printf 'this is not json\\n'`)
    const sink = makeWarningSink()
    const mgr = makeKernelManager({
      pythonPath: "/bin/sh",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000,
      warningSink: sink
    })
    try {
      const response = await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 10_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(response.success).toBe(true)
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("python-probe")
      expect(warnings[0]?.detail).toContain("this is not json")
      expect(mgr.list()[0]?.warnings).toEqual(warnings)
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("routes a kernel warning to the sink of the in-flight request", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-kernel-request-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const helper = writeScript(
      dir,
      "late-helper.sh",
      `#!/bin/sh
IFS= read -r init
printf '{"ready": true, "pid": 1, "kernelPid": 2}\\n'
IFS= read -r req
printf 'not json either\\n'
id=$(printf '%s' "$req" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
nonce=$(printf '%s' "$req" | sed -n 's/.*"nonce"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\\1/p')
printf '{"id": %s, "nonce": "%s", "success": true, "executedCells": [], "durationMs": 1, "outputs": []}\\n' "$id" "$nonce"
`
    )
    const mgr = makeKernelManager({
      pythonPath: "/bin/sh",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000
    })
    const sink = makeWarningSink()
    try {
      await Effect.runPromise(
        mgr.execute(
          file,
          {
            filePath: file,
            mode: "all",
            timeoutMs: 10_000,
            save: false,
            maxOutputChars: 4_000
          },
          undefined,
          { warningSink: sink }
        )
      )
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("python-probe")
      expect(warnings[0]?.detail).toContain("not json either")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records a non-object JSON line from the helper", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-kernel-json-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const helper = shellHelper(dir, `printf '42\\n'`)
    const sink = makeWarningSink()
    const mgr = makeKernelManager({
      pythonPath: "/bin/sh",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000,
      warningSink: sink
    })
    try {
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 10_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("python-probe")
      expect(warnings[0]?.message).toContain("non-object JSON")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not warn for a healthy kernel request or a clean shutdown", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-quiet-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const helper = shellHelper(dir, "")
    const sink = makeWarningSink()
    const mgr = makeKernelManager({
      pythonPath: "/bin/sh",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000,
      warningSink: sink
    })
    try {
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 10_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      await Effect.runPromise(mgr.disposeAll())
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keys a kernel correctly when the notebook is missing without warning", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-missing-"))
    const file = path.join(dir, "missing.ipynb")
    const helper = shellHelper(dir, "")
    const sink = makeWarningSink()
    const mgr = makeKernelManager({
      pythonPath: "/bin/sh",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000,
      warningSink: sink
    })
    try {
      const response = await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 10_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      expect(response.success).toBe(true)
      expect(mgr.isRunning(file)).toBe(true)
      expect(sink.drain()).toEqual([])
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records the realpath fallback used to key a kernel", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-realpath-"))
    const file = path.join(dir, "missing.ipynb")
    const helper = shellHelper(dir, "")
    const sink = makeWarningSink()
    const mgr = makeKernelManager({
      pythonPath: "/bin/sh",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000,
      warningSink: sink
    })
    const original = fs.promises.realpath
    const spy = spyOn(fs.promises, "realpath").mockImplementation(((
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        return Promise.reject(
          Object.assign(new Error("cannot resolve notebook"), { code: "EACCES" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<string>)(
        target,
        ...rest
      )
    }) as unknown as typeof fs.promises.realpath)
    restore.push(() => spy.mockRestore())
    try {
      await Effect.runPromise(
        mgr.execute(file, {
          filePath: file,
          mode: "all",
          timeoutMs: 10_000,
          save: false,
          maxOutputChars: 4_000
        })
      )
      const warnings = sink.drain()
      expect(warnings.length).toBeGreaterThan(0)
      expect(warnings.every((warning) => warning.source === "path-resolution")).toBe(true)
      expect(warnings[0]?.detail).toContain("missing.ipynb")
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a path-resolution fallback in the execution result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-exec-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const original = fs.promises.realpath
    const spy = spyOn(fs.promises, "realpath").mockImplementation(((
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        return Promise.reject(
          Object.assign(new Error("cannot resolve notebook"), { code: "EACCES" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<string>)(
        target,
        ...rest
      )
    }) as unknown as typeof fs.promises.realpath)
    restore.push(() => spy.mockRestore())
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      makePermissionService(makeContext(dir)),
      fakePython(),
      { kernelManager: fakeKernel(), warmKernel: true, defaultTimeoutMs: 30_000 }
    )
    try {
      const result = await Effect.runPromise(
        exec.execute(file, {
          mode: "all",
          cellIndex: undefined,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(result.warnings?.map((warning) => warning.source)).toEqual([
        "path-resolution"
      ])
      expect(result.warnings?.[0]?.detail).toContain("n.ipynb")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records a warning when the write-path realpath probe fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-write-realpath-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const original = fsp.realpath
    const spy = spyOn(fsp, "realpath").mockImplementation(((
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        return Promise.reject(
          Object.assign(new Error("cannot resolve notebook"), { code: "EACCES" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<string>)(
        target,
        ...rest
      )
    }) as unknown as typeof fsp.realpath)
    restore.push(() => spy.mockRestore())
    const sink = makeWarningSink()
    const svc = makeNotebookFileService({ worktree: dir, warningSink: sink })
    try {
      await Effect.runPromise(
        svc.writeAtomic(file, {
          ...notebook,
          cells: [{ ...notebook.cells[0]!, source: "x = 2" }]
        } as unknown as NotebookRaw)
      )
      const warnings = sink.drain()
      const pathWarnings = warnings.filter(
        (warning) => warning.source === "path-resolution"
      )
      expect(pathWarnings.length).toBeGreaterThanOrEqual(1)
      expect(pathWarnings.some((warning) => (warning.detail ?? "").includes("n.ipynb"))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("announces a fallback rewrite through the warning sink", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-fallback-"))
    const file = path.join(dir, "n.ipynb")
    const broken = `{ not json`
    fs.writeFileSync(file, broken)
    const sink = makeWarningSink()
    const svc = makeNotebookFileService({ worktree: dir, warningSink: sink })
    try {
      const outcome = await Effect.runPromise(
        svc.writeAtomic(file, {
          ...notebook,
          cells: [{ ...notebook.cells[0]!, source: "x = 2" }]
        } as unknown as NotebookRaw, {
          format: DEFAULT_NOTEBOOK_FORMAT,
          previousText: broken
        })
      )
      expect(outcome.mode).toBe("fallback")
      expect(outcome.reason).toBe("parse-failed")
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toBeDefined()
      const warnings = sink.drain()
      expect(warnings.length).toBe(1)
      expect(warnings[0]?.source).toBe("json-patch")
      expect(warnings[0]?.message).toContain("rewritten from scratch")
      expect(warnings[0]?.message).toContain("parse-failed")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records a warning when the write-path stat probe fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-write-stat-"))
    const file = path.join(dir, "n.ipynb")
    const original = fsp.stat
    const spy = spyOn(fsp, "stat").mockImplementation(((
      target: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }))
      }
      return (original as unknown as (...args: unknown[]) => Promise<unknown>)(
        target,
        ...rest
      )
    }) as unknown as typeof fsp.stat)
    restore.push(() => spy.mockRestore())
    const sink = makeWarningSink()
    const svc = makeNotebookFileService({ worktree: dir, warningSink: sink })
    try {
      const exit = await Effect.runPromiseExit(
        svc.writeAtomic(file, notebook as unknown as NotebookRaw)
      )
      expect(exit._tag).toBe("Failure")
      const error = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined
      const failure = error?._tag === "Some" ? error.value : undefined
      expect(failure).toBeInstanceOf(NotebookValidationError)
      expect((failure as { message?: string }).message).toContain("could not be read")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("forwards kernel warnings to a caller-supplied sink", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-exec-sink-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const kernelSink = makeWarningSink()
    const kernel = {
      execute: (_path: string, _request: unknown, _runtime: unknown, options?: {
        readonly warningSink?: { readonly add: (warning: unknown) => void }
      }) =>
        Effect.sync(() => {
          options?.warningSink?.add({
            source: "python-probe",
            message: "helper emitted noise",
            detail: "ignored line"
          })
          return {
            success: true,
            executedCells: [0],
            durationMs: 1,
            outputs: [{ cellIndex: 0, status: "ok" as const, stdout: "ok\n" }]
          }
        })
    } as unknown as KernelManagerShape
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      makePermissionService(makeContext(dir)),
      fakePython(),
      { kernelManager: kernel, warmKernel: true, defaultTimeoutMs: 30_000 }
    )
    try {
      const result = await Effect.runPromise(
        exec.execute(
          file,
          {
            mode: "all",
            cellIndex: undefined,
            start: undefined,
            end: undefined,
            kernel: undefined,
            timeoutMs: 30_000,
            save: false,
            workingDirectory: undefined,
            maxOutputChars: 4_000
          },
          { warningSink: kernelSink }
        )
      )
      expect(result.warnings).toEqual([
        { source: "python-probe", message: "helper emitted noise", detail: "ignored line" }
      ])
      expect(kernelSink.drain()).toEqual([
        { source: "python-probe", message: "helper emitted noise", detail: "ignored line" }
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns no warnings for a healthy execution", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-exec-clean-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      makePermissionService(makeContext(dir)),
      fakePython(),
      { kernelManager: fakeKernel(), warmKernel: true, defaultTimeoutMs: 30_000 }
    )
    try {
      const result = await Effect.runPromise(
        exec.execute(file, {
          mode: "all",
          cellIndex: undefined,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(result.warnings).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records why the configured interpreter failed to probe", async () => {
    const sink = makeWarningSink()
    const svc = makePythonService({
      pythonPath: "/nonexistent/ipynb-python-xyz",
      preferUv: false,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const probe = await Effect.runPromise(svc.probe({ warningSink: sink }))
    expect(probe.from).toBe("none")
    const warnings = sink.drain()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.source).toBe("python-probe")
    expect(warnings[0]?.detail).toContain("ipynb-python-xyz")
  })

  it("records a relative configured interpreter that is never probed", async () => {
    const sink = makeWarningSink()
    const svc = makePythonService({
      pythonPath: "some/relative/python",
      preferUv: false,
      helperRelativePath: "python/ipynb_runner.py"
    })
    const probe = await Effect.runPromise(svc.probe({ warningSink: sink }))
    expect(probe.from).toBe("none")
    const warnings = sink.drain()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.source).toBe("python-probe")
    expect(warnings[0]?.detail).toContain("some/relative/python")
  })

  it("stays quiet when an unconfigured PATH interpreter is missing", async () => {
    const sink = makeWarningSink()
    const svc = makePythonService({
      pythonPath: undefined,
      preferUv: false,
      helperRelativePath: "python/ipynb_runner.py"
    })
    await Effect.runPromise(svc.probe({ warningSink: sink }))
    expect(sink.drain()).toEqual([])
  })

  it("records a leftover sidecar temp file when the write fails", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-sidecar-tmp-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const originalRm = fs.promises.rm
    const rmSpy = spyOn(fs.promises, "rm").mockImplementation(((
      target: fs.PathLike,
      options?: unknown
    ) => {
      if (String(target).includes("opencode-ipynb-lsp-")) {
        return Promise.reject(
          Object.assign(new Error("busy"), { code: "EBUSY" })
        )
      }
      return (originalRm as unknown as (...args: unknown[]) => Promise<void>)(
        target,
        options
      )
    }) as unknown as typeof fs.promises.rm)
    restore.push(() => rmSpy.mockRestore())
    const originalRename = fs.promises.rename
    const renameSpy = spyOn(fs.promises, "rename").mockImplementation(((
      from: fs.PathLike,
      to: fs.PathLike
    ) => {
      if (String(to).includes("opencode-ipynb-lsp-")) {
        return Promise.reject(
          Object.assign(new Error("rename refused"), { code: "EPERM" })
        )
      }
      return originalRename(from, to)
    }) as unknown as typeof fs.promises.rename)
    restore.push(() => renameSpy.mockRestore())
    const sink = makeWarningSink()
    try {
      let message = ""
      try {
        await materializeVirtualDocument(document, dir, { warningSink: sink })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain("rename refused")
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("temp-unlink")
      expect(warnings[0]?.detail).toContain(".tmp")
      const leftovers = fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))
      expect(leftovers).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records a failed sidecar removal instead of dropping it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-sidecar-clean-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const materialized = await materializeVirtualDocument(document, dir)
    const original = fs.promises.rm
    const spy = spyOn(fs.promises, "rm").mockImplementation(((
      target: fs.PathLike,
      options?: unknown
    ) => {
      if (path.resolve(String(target)) === path.resolve(materialized.path)) {
        return Promise.reject(
          Object.assign(new Error("busy"), { code: "EBUSY" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<void>)(
        target,
        options
      )
    }) as unknown as typeof fs.promises.rm)
    restore.push(() => spy.mockRestore())
    const sink = makeWarningSink()
    try {
      await cleanupVirtualDocuments(dir, { warningSink: sink })
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("sidecar-cleanup")
      expect(warnings[0]?.detail).toContain("opencode-ipynb-lsp-")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records an unreadable legacy sidecar directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-legacy-"))
    const legacy = path.join(dir, ".opencode", "ipynb-lsp")
    fs.mkdirSync(legacy, { recursive: true })
    const original = fs.promises.readdir
    const spy = spyOn(fs.promises, "readdir").mockImplementation(((
      target: fs.PathLike,
      options?: unknown
    ) => {
      if (path.resolve(String(target)) === path.resolve(legacy)) {
        return Promise.reject(
          Object.assign(new Error("denied"), { code: "EACCES" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<unknown>)(
        target,
        options
      )
    }) as unknown as typeof fs.promises.readdir)
    restore.push(() => spy.mockRestore())
    const sink = makeWarningSink()
    try {
      await cleanupVirtualDocuments(dir, { warningSink: sink })
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("sidecar-cleanup")
      expect(warnings[0]?.detail).toContain(".opencode")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a diagnostics temp file that could not be removed", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-diag-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const pyright = writeScript(dir, "fake-pyright", '#!/bin/sh\necho \'{"generalDiagnostics":[]}\'\n')
    const temp = diagnosticTempPath(file)
    const original = fs.promises.rm
    const spy = spyOn(fs.promises, "rm").mockImplementation(((
      target: fs.PathLike,
      options?: unknown
    ) => {
      if (path.resolve(String(target)) === path.resolve(temp)) {
        return Promise.reject(
          Object.assign(new Error("busy"), { code: "EBUSY" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<void>)(
        target,
        options
      )
    }) as unknown as typeof fs.promises.rm)
    restore.push(() => spy.mockRestore())
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document: buildNotebookVirtualDocument(notebook, { filePath: file }),
        pyrightPath: pyright,
        timeoutMs: 10_000
      })
      expect(result.skipped).toBeUndefined()
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings?.[0]?.source).toBe("temp-unlink")
      expect(result.warnings?.[0]?.detail).toContain(path.basename(temp))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a diagnostics directory it could not resolve", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-diag-dir-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const pyright = writeScript(dir, "fake-pyright", '#!/bin/sh\necho \'{"generalDiagnostics":[]}\'\n')
    const original = fs.realpathSync
    const spy = spyOn(fs, "realpathSync").mockImplementation(((target: fs.PathLike) => {
      if (path.resolve(String(target)) === path.resolve(file)) {
        throw Object.assign(new Error("cannot resolve"), { code: "EACCES" })
      }
      return original(target)
    }) as unknown as typeof fs.realpathSync)
    restore.push(() => spy.mockRestore())
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document: buildNotebookVirtualDocument(notebook, { filePath: file }),
        pyrightPath: pyright,
        timeoutMs: 10_000
      })
      const warnings = result.warnings ?? []
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("path-resolution")
      expect(warnings[0]?.detail).toContain("n.ipynb")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reports a sidecar it could not inspect instead of assuming none", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-has-sidecar-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const materialized = await materializeVirtualDocument(document, dir)
    const original = fs.promises.lstat
    const spy = spyOn(fs.promises, "lstat").mockImplementation(((
      target: fs.PathLike,
      options?: unknown
    ) => {
      if (path.resolve(String(target)) === path.resolve(materialized.path)) {
        return Promise.reject(
          Object.assign(new Error("denied"), { code: "EACCES" })
        )
      }
      return (original as unknown as (...args: unknown[]) => Promise<unknown>)(
        target,
        options
      )
    }) as unknown as typeof fs.promises.lstat)
    restore.push(() => spy.mockRestore())
    const sink = makeWarningSink()
    try {
      const exists = await hasMaterializedDocument(dir, file, { warningSink: sink })
      expect(exists).toBe(false)
      const warnings = sink.drain()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]?.source).toBe("sidecar-cleanup")
      expect(warnings[0]?.detail).toContain("opencode-ipynb-lsp-")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("stays quiet when a notebook was never materialized", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-no-sidecar-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const sink = makeWarningSink()
    try {
      const exists = await hasMaterializedDocument(dir, file, { warningSink: sink })
      expect(exists).toBe(false)
      expect(sink.drain()).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns no diagnostics warnings for a clean run", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-warn-diag-clean-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const pyright = writeScript(dir, "fake-pyright", '#!/bin/sh\necho \'{"generalDiagnostics":[]}\'\n')
    try {
      const result = await diagnoseNotebook({
        filePath: file,
        document: buildNotebookVirtualDocument(notebook, { filePath: file }),
        pyrightPath: pyright,
        timeoutMs: 10_000
      })
      expect(result.skipped).toBeUndefined()
      expect(result.warnings).toBeUndefined()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
