import { describe, expect, it } from "bun:test"
import { Cause, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PermissionDeniedError } from "../../src/domain/errors.js"
import {
  makeCleanImpl,
  makeEditImpl,
  makeNotebookFileService,
  makeOutputImpl,
  makePathService,
  makePermissionService
} from "../../src/services/index.js"
import type { ToolContext } from "../../src/tool.js"

const notebook = `${JSON.stringify(
  {
    cells: [
      {
        cell_type: "code",
        execution_count: 3,
        metadata: {},
        outputs: [{ output_type: "stream", name: "stdout", text: ["hi\n"] }],
        source: ["print(1)"]
      },
      { cell_type: "markdown", metadata: {}, source: ["# B"] }
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  },
  null,
  1
)}\n`

const context = (dir: string): ToolContext =>
  ({
    sessionID: "t",
    messageID: "t",
    agent: "t",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {
      throw new Error("denied by host")
    }
  }) as unknown as ToolContext

const expectDenied = async (
  effect: Effect.Effect<unknown, unknown, never>
): Promise<void> => {
  const exit = await Effect.runPromiseExit(effect)
  expect(exit._tag).toBe("Failure")
  if (exit._tag !== "Failure") return
  const error = Cause.findErrorOption(exit.cause)
  expect(error._tag).toBe("Some")
  if (error._tag === "Some") {
    expect(error.value).toBeInstanceOf(PermissionDeniedError)
  }
}

const operations: Record<
  string,
  (file: string, services: ReturnType<typeof build>) => Effect.Effect<unknown, unknown, never>
> = {
  editCell: (file, services) =>
    services.edit.editCell(file, {
      cellIndex: 0,
      source: "print(2)",
      clearOutputs: "never"
    }),
  insertCell: (file, services) =>
    services.edit.insertCell(file, "markdown", "# C", 1),
  deleteCell: (file, services) => services.edit.deleteCell(file, 0),
  moveCell: (file, services) => services.edit.moveCell(file, 0, 1),
  clean: (file, services) => services.clean.clean(file, { clearOutputs: true }),
  clearCellOutputs: (file, services) => services.output.clearCellOutputs(file, 0),
  clearAllOutputs: (file, services) => services.output.clearAllOutputs(file)
}

const build = (dir: string) => {
  const pathSvc = makePathService({
    directory: dir,
    worktree: dir,
    platform: process.platform
  })
  const ctx = context(dir)
  const permSvc = makePermissionService(ctx)
  const fileSvc = makeNotebookFileService({ worktree: dir })
  return {
    edit: makeEditImpl(pathSvc, fileSvc, permSvc),
    clean: makeCleanImpl(pathSvc, fileSvc, permSvc),
    output: makeOutputImpl(pathSvc, fileSvc, permSvc)
  }
}

describe("a denied edit never reaches the notebook", () => {
  for (const [name, operation] of Object.entries(operations)) {
    it(`leaves the file byte-identical when ${name} is denied`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-deny-"))
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, notebook)
      const before = fs.readFileSync(file)
      try {
        await expectDenied(operation(file, build(dir)))
        expect(fs.readFileSync(file).equals(before)).toBe(true)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
