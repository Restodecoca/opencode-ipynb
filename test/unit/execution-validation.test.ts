import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as os from "node:os"
import * as path from "node:path"
import * as fs from "node:fs"
import { NotebookSchema } from "../../src/domain/notebook.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"
import { makeExecutionImpl } from "../../src/services/NotebookExecutionService.js"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import {
  makeNotebookFileService,
  type NotebookFileServiceShape
} from "../../src/services/NotebookFileService.js"
import { makePythonService, type PythonServiceShape } from "../../src/services/PythonService.js"
import { NotebookValidationError } from "../../src/domain/errors.js"
import type { ToolContext } from "@opencode-ai/plugin"

const makeContext = (dir: string): ToolContext =>
  (({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown) as ToolContext

const buildTinyNotebook = (): NotebookRaw =>
  NotebookSchema.parse({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    cells: [
      { cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: "x = 1" }
    ]
  }) as NotebookRaw

describe("NotebookExecutionService.execute > RunRequest validation", () => {
  it("fails with NotebookValidationError when the RunRequest payload is invalid (mode is not in the allowed union)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-exec-validate-"))
    const file = path.join(dir, "tiny.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildTinyNotebook()))
    try {
      const pathSvc = makePathService({
        directory: dir,
        worktree: dir,
        platform: process.platform
      })
      const permSvc = makePermissionService(makeContext(dir))
      const fileSvc: NotebookFileServiceShape = makeNotebookFileService()
      const pythonSvc: PythonServiceShape = makePythonService({
        pythonPath: undefined,
        preferUv: true,
        helperRelativePath: "python/ipynb_runner.py"
      })
      const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
        kernelManager: undefined as never,
        warmKernel: false,
        defaultTimeoutMs: 30_000
      })
      const req = {
        mode: "nonsense" as never,
        cellIndex: 0,
        start: undefined,
        end: undefined,
        kernel: undefined,
        timeoutMs: 30_000,
        save: false,
        workingDirectory: undefined,
        maxOutputChars: 4_000
      }
      const result = await Effect.runPromiseExit(exec.execute(file, req))
      if (result._tag === "Failure") {
        const cause = result.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string; issues?: ReadonlyArray<string> }
          expect(err._tag).toBe("NotebookValidation")
          expect(Array.isArray(err.issues)).toBe(true)
          const joined = (err.issues ?? []).join(" ")
          expect(joined).toContain("mode")
        } else {
          throw new Error("expected a typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails with NotebookValidationError when cellIndex is not an integer (string)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-exec-validate-"))
    const file = path.join(dir, "tiny.ipynb")
    fs.writeFileSync(file, JSON.stringify(buildTinyNotebook()))
    try {
      const pathSvc = makePathService({
        directory: dir,
        worktree: dir,
        platform: process.platform
      })
      const permSvc = makePermissionService(makeContext(dir))
      const fileSvc: NotebookFileServiceShape = makeNotebookFileService()
      const pythonSvc: PythonServiceShape = makePythonService({
        pythonPath: undefined,
        preferUv: true,
        helperRelativePath: "python/ipynb_runner.py"
      })
      const exec = makeExecutionImpl(pathSvc, fileSvc, permSvc, pythonSvc, {
        kernelManager: undefined as never,
        warmKernel: false,
        defaultTimeoutMs: 30_000
      })
      const req = {
        mode: "cell" as const,
        cellIndex: "0" as unknown as number,
        start: undefined,
        end: undefined,
        kernel: undefined,
        timeoutMs: 30_000,
        save: false,
        workingDirectory: undefined,
        maxOutputChars: 4_000
      }
      const result = await Effect.runPromiseExit(exec.execute(file, req))
      if (result._tag === "Failure") {
        const cause = result.cause
        if (cause._tag === "Fail") {
          const err = cause.error as { _tag?: string }
          expect(err._tag).toBe("NotebookValidation")
        } else {
          throw new Error("expected a typed failure, got defect")
        }
      } else {
        throw new Error("expected Failure, got Success")
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("NotebookValidationError carries the filePath of the targeted notebook", () => {
    const err = new NotebookValidationError({
      message: "test",
      filePath: "/tmp/x.ipynb",
      issues: ["mode: invalid"]
    })
    expect(err.filePath).toBe("/tmp/x.ipynb")
    expect(err.issues).toEqual(["mode: invalid"])
    expect(err._tag).toBe("NotebookValidation")
  })
})
