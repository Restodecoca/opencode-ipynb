import { describe, expect, it } from "bun:test"
import { Cause, Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  makeCleanImpl,
  makeEditImpl,
  makeOutputImpl,
  makeNotebookFileService,
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

const cancellingContext = (dir: string): { context: ToolContext; controller: AbortController } => {
  const controller = new AbortController()
  return {
    controller,
    context: {
      sessionID: "t",
      messageID: "t",
      agent: "t",
      directory: dir,
      worktree: dir,
      abort: controller.signal,
      metadata: () => {},
      ask: async () => {
        controller.abort()
      }
    } as unknown as ToolContext
  }
}

const build = (dir: string, context: ToolContext) => {
  const pathSvc = makePathService({
    directory: dir,
    worktree: dir,
    platform: process.platform
  })
  const fileSvc = makeNotebookFileService({
    worktree: dir,
    signal: context.abort
  })
  const permSvc = makePermissionService(context)
  return {
    edit: makeEditImpl(pathSvc, fileSvc, permSvc),
    clean: makeCleanImpl(pathSvc, fileSvc, permSvc),
    output: makeOutputImpl(pathSvc, fileSvc, permSvc)
  }
}

const operations: Record<
  string,
  (file: string, services: ReturnType<typeof build>) => Effect.Effect<unknown, unknown, never>
> = {
  editCell: (file, services) =>
    services.edit.editCell(file, { cellIndex: 0, source: "print(2)", clearOutputs: "always" }),
  insertCell: (file, services) => services.edit.insertCell(file, "markdown", "# C", 1),
  deleteCell: (file, services) => services.edit.deleteCell(file, 0),
  moveCell: (file, services) => services.edit.moveCell(file, 0, 1),
  clean: (file, services) => services.clean.clean(file, { clearOutputs: true }),
  clearCellOutputs: (file, services) => services.output.clearCellOutputs(file, 0),
  clearAllOutputs: (file, services) => services.output.clearAllOutputs(file)
}

describe("a cancellation during the permission prompt never writes", () => {
  for (const [name, operation] of Object.entries(operations)) {
    it(`leaves the file byte-identical when ${name} is cancelled in ask`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-midcancel-"))
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, notebook)
      const before = fs.readFileSync(file)
      const { context, controller } = cancellingContext(dir)
      try {
        const exit = await Effect.runPromiseExit(
          operation(file, build(dir, context))
        )
        expect(controller.signal.aborted).toBe(true)
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const error = Cause.findErrorOption(exit.cause)
          expect(error._tag).toBe("Some")
        }
        expect(fs.readFileSync(file).equals(before)).toBe(true)
        expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
