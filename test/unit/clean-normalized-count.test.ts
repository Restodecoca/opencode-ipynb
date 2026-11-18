import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { makeCleanImpl } from "../../src/services/NotebookCleanService.js"
import { makeNotebookFileService } from "../../src/services/NotebookFileService.js"
import { makePathService } from "../../src/services/PathService.js"
import { makePermissionService } from "../../src/services/PermissionService.js"
import type { ToolContext } from "../../src/tool.js"

const ctx = (dir: string) =>
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

const run = async <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

const notebook = () => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: ["a = 1\n"]
    },
    {
      cell_type: "markdown",
      metadata: {},
      source: ["# title\n"]
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: "b = 2\n"
    }
  ]
})

const cleanIn = async (options: Record<string, unknown>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clean-count-"))
  const file = path.join(dir, "n.ipynb")
  fs.writeFileSync(file, JSON.stringify(notebook()))
  try {
    const pathSvc = makePathService({
      directory: dir,
      worktree: dir,
      platform: process.platform
    })
    const clean = makeCleanImpl(
      pathSvc,
      makeNotebookFileService(),
      makePermissionService(ctx(dir))
    )
    return await run(clean.clean(file, options))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("ipynb_clean normalized source count", () => {
  it("counts the cells whose source arrays it joined", async () => {
    const result = await cleanIn({})
    expect(result.normalizedSources).toBe(2)
    expect(result.affectedCells).toBe(2)
  })

  it("counts zero when normalization is disabled", async () => {
    const result = await cleanIn({ normalizeSource: false })
    expect(result.normalizedSources).toBe(0)
    expect(result.affectedCells).toBe(0)
  })
})
