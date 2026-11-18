import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { patchJsonTextDetailed } from "../src/utils/json-patch.js"
import {
  makeEditImpl,
  makeNotebookFileService,
  makeOutputImpl,
  makePathService,
  makePermissionService
} from "../src/services/index.js"
import type { ToolContext } from "../src/tool.js"

const makeContext = (dir: string): ToolContext =>
  ({
    sessionID: "bench",
    messageID: "bench",
    agent: "bench",
    directory: dir,
    worktree: dir,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

const build = (cells: number): string => {
  const list = Array.from({ length: cells }, (_, index) => ({
    cell_type: "code",
    execution_count: index,
    id: `c${index}`,
    metadata: {},
    outputs: [{ name: "stdout", output_type: "stream", text: [`line ${index}\n`] }],
    source: [`print(${index})`]
  }))
  return `${JSON.stringify({ cells: list, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`
}

const patchStyle = {
  unit: " ",
  newline: "\n" as const,
  itemSeparator: ",",
  keySeparator: ": ",
  ensureAscii: false
}

const measurePatch = (cells: number): number => {
  const text = build(cells)
  const next = JSON.parse(text) as { cells: Array<Record<string, unknown>> }
  for (let index = 0; index < next.cells.length; index += 1) {
    const cell = next.cells[index]!
    cell.outputs = []
    cell.execution_count = null
    cell.source = [`print(${index}) `]
  }
  const started = Bun.nanoseconds()
  const result = patchJsonTextDetailed(text, next, { style: patchStyle })
  if (result.text === undefined) throw new Error(`patch fell back: ${result.reason}`)
  return (Bun.nanoseconds() - started) / 1e6
}

interface Measurement {
  readonly cells: number
  readonly bytes: number
  readonly clearAllMs: number
  readonly moveMs: number
  readonly editMs: number
  readonly patchMs: number
}

const measure = async (cells: number): Promise<Measurement> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-bench-"))
  try {
    const text = build(cells)
    const pathSvc = makePathService({
      directory: dir,
      worktree: dir,
      platform: process.platform
    })
    const fileSvc = makeNotebookFileService()
    const permSvc = makePermissionService(makeContext(dir))
    const edit = makeEditImpl(pathSvc, fileSvc, permSvc)
    const output = makeOutputImpl(pathSvc, fileSvc, permSvc)
    const file = path.join(dir, "bench.ipynb")
    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromise(effect as Effect.Effect<A, E, never>)
    const time = async (action: () => Promise<unknown>): Promise<number> => {
      const started = Bun.nanoseconds()
      await action()
      return (Bun.nanoseconds() - started) / 1e6
    }

    fs.writeFileSync(file, text)
    const clearAllMs = await time(() => run(output.clearAllOutputs(file)))

    fs.writeFileSync(file, text)
    const moveMs = await time(() => run(edit.moveCell(file, 0, cells - 1)))

    fs.writeFileSync(file, text)
    const editMs = await time(() =>
      run(
        edit.editCell(file, {
          cellIndex: Math.floor(cells / 2),
          source: "print('x')",
          clearOutputs: "never"
        })
      )
    )

    const patchMs = measurePatch(cells)
    return { cells, bytes: text.length, clearAllMs, moveMs, editMs, patchMs }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const ratios = (small: Measurement, large: Measurement) => ({
  cells: large.cells / small.cells,
  bytes: large.bytes / small.bytes,
  clearAll: large.clearAllMs / Math.max(small.clearAllMs, 0.5),
  move: large.moveMs / Math.max(small.moveMs, 0.5),
  edit: large.editMs / Math.max(small.editMs, 0.5),
  patch: large.patchMs / Math.max(small.patchMs, 0.5)
})

const BUDGET = Number(process.env.IPYNB_BENCH_RATIO ?? "2.5")
const SMALL = Number(process.env.IPYNB_BENCH_SMALL ?? "1000")
const LARGE = Number(process.env.IPYNB_BENCH_LARGE ?? "4000")

const main = async (): Promise<void> => {
  await measure(SMALL)
  const small = await measure(SMALL)
  const large = await measure(LARGE)
  const ratio = ratios(small, large)
  for (const sample of [small, large]) {
    console.log(
      `cells=${sample.cells} bytes=${sample.bytes} clearAll=${sample.clearAllMs.toFixed(1)}ms move=${sample.moveMs.toFixed(1)}ms edit=${sample.editMs.toFixed(1)}ms patchAll=${sample.patchMs.toFixed(1)}ms`
    )
  }
  console.log(
    `scaling ${SMALL}->${LARGE} cells (${ratio.cells.toFixed(1)}x input): clearAll=${ratio.clearAll.toFixed(1)}x move=${ratio.move.toFixed(1)}x edit=${ratio.edit.toFixed(1)}x patchAll=${ratio.patch.toFixed(1)}x`
  )
  const normalized = {
    clearAll: ratio.clearAll / ratio.bytes,
    move: ratio.move / ratio.bytes,
    edit: ratio.edit / ratio.bytes,
    patch: ratio.patch / ratio.bytes
  }
  console.log(
    `cost per byte vs linear: clearAll=${normalized.clearAll.toFixed(2)}x move=${normalized.move.toFixed(2)}x edit=${normalized.edit.toFixed(2)}x patchAll=${normalized.patch.toFixed(2)}x`
  )
  const failures: string[] = []
  if (normalized.clearAll > BUDGET) failures.push(`clearAll ${normalized.clearAll.toFixed(2)}x`)
  if (normalized.move > BUDGET) failures.push(`move ${normalized.move.toFixed(2)}x`)
  if (normalized.edit > BUDGET) failures.push(`edit ${normalized.edit.toFixed(2)}x`)
  if (normalized.patch > BUDGET) failures.push(`patchAll ${normalized.patch.toFixed(2)}x`)
  if (failures.length > 0) {
    console.error(
      `FAIL: write cost grows faster than the notebook (budget ${BUDGET}x linear): ${failures.join(", ")}`
    )
    process.exit(1)
  }
  console.log(`ok: every write is within ${BUDGET}x of linear for a ${ratio.bytes.toFixed(1)}x larger notebook`)
}

await main()
