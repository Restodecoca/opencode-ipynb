import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { makePathService } from "../../src/services/PathService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { PermissionDeniedError } from "../../src/domain/errors.js"
import type { PermissionServiceShape } from "../../src/services/PermissionService.js"
import {
  pathPythonCandidates,
  type PythonServiceShape
} from "../../src/services/PythonService.js"

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

const deniedPermissions = (calls: string[]): PermissionServiceShape => ({
  aliases: (filePath) => Effect.succeed([filePath]),
  ask: (req) =>
    Effect.sync(() => {
      calls.push(req.kind)
    }).pipe(
      Effect.flatMap(() =>
        req.kind === "shell"
          ? Effect.fail(
              new PermissionDeniedError({
                message: "shell denied",
                action: "shell"
              })
            )
          : Effect.void
      )
    )
})

const countingPython = () => {
  const state = { probes: 0 }
  const service = {
    probe: () =>
      Effect.sync(() => {
        state.probes += 1
        return {
          pythonPath: "/usr/bin/python3",
          version: "3",
          executable: "python3",
          from: "options" as const
        }
      }),
    findHelper: () => Effect.succeed("/tmp/ipynb_runner.py"),
    checkDependencies: () => Effect.succeed([]),
    candidates: () => Effect.succeed([]),
    checkImport: () => Effect.succeed({ name: "x", available: true, detail: "ok" }),
    doctor: () => Effect.succeed({} as never)
  } as unknown as PythonServiceShape
  return { service, state }
}

describe("permission ordering", () => {
  it("does not probe Python when shell is denied for ipynb_run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-run-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const calls: string[] = []
    const python = countingPython()
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      deniedPermissions(calls),
      python.service,
      { warmKernel: false, defaultTimeoutMs: 30_000 }
    )
    try {
      const exit = await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(exit._tag).toBe("Failure")
      expect(python.state.probes).toBe(0)
      expect(calls).toEqual(["edit", "shell"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not probe Python when shell is denied for ipynb_repro", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-repro-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const calls: string[] = []
    const python = countingPython()
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      deniedPermissions(calls),
      python.service,
      { warmKernel: false, defaultTimeoutMs: 30_000 }
    )
    try {
      const exit = await Effect.runPromiseExit(exec.reportEnv(file))
      expect(exit._tag).toBe("Failure")
      expect(python.state.probes).toBe(0)
      expect(calls).toEqual(["shell"])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
  it("includes the configured interpreter in the shell permission resources", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-python-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const patterns: string[][] = []
    const perm = {
      aliases: (filePath: string) => Effect.succeed([filePath]),
      ask: (req: { kind: string; patterns: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          if (req.kind === "shell") patterns.push([...req.patterns])
        })
    } as unknown as PermissionServiceShape
    const python = countingPython()
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      perm,
      python.service,
      {
        warmKernel: false,
        defaultTimeoutMs: 30_000,
        pythonPath: "/custom/secret-python"
      }
    )
    try {
      await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(patterns[0]).toContain("/custom/secret-python")
      // An explicit interpreter must not drag in unused PATH installations.
      for (const candidate of pathPythonCandidates()) {
        expect(patterns[0]).not.toContain(candidate)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("includes both the lexical alias and the real target for a symlinked notebook", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-alias-"))
    const real = path.join(dir, "real.ipynb")
    const link = path.join(dir, "link.ipynb")
    fs.writeFileSync(real, JSON.stringify(notebook))
    fs.symlinkSync(real, link)
    const patterns: string[][] = []
    const perm = {
      aliases: (filePath: string) => Effect.succeed([filePath]),
      ask: (req: { kind: string; patterns: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          patterns.push([...req.patterns])
        })
    } as unknown as PermissionServiceShape
    const python = countingPython()
    const kernel = {
      execute: () =>
        Effect.succeed({
          success: true,
          executedCells: [0],
          durationMs: 1,
          outputs: []
        })
    }
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      perm,
      python.service,
      {
        kernelManager: kernel as never,
        warmKernel: true,
        defaultTimeoutMs: 30_000
      }
    )
    try {
      await Effect.runPromise(
        exec.execute(link, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: true,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      expect(patterns[0]).toContain(link)
      expect(patterns[0]).toContain(real)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("includes PATH interpreters when no explicit interpreter is configured", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-path-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    const patterns: string[][] = []
    const perm = {
      aliases: (filePath: string) => Effect.succeed([filePath]),
      ask: (req: { kind: string; patterns: ReadonlyArray<string> }) =>
        Effect.sync(() => {
          if (req.kind === "shell") patterns.push([...req.patterns])
        })
    } as unknown as PermissionServiceShape
    const python = countingPython()
    const exec = makeExecutionImpl(
      makePathService({ directory: dir, worktree: dir, platform: process.platform }),
      makeNotebookFileService(),
      perm,
      python.service,
      { warmKernel: false, defaultTimeoutMs: 30_000 }
    )
    try {
      await Effect.runPromiseExit(
        exec.execute(file, {
          mode: "cell",
          cellIndex: 0,
          start: undefined,
          end: undefined,
          kernel: undefined,
          timeoutMs: 30_000,
          save: false,
          workingDirectory: undefined,
          maxOutputChars: 4_000
        })
      )
      for (const candidate of pathPythonCandidates()) {
        expect(patterns[0]).toContain(candidate)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

})
