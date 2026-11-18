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

const buildMetadataNotebook = (keys: number): string => {
  const metadata: Record<string, number> = {}
  for (let index = 0; index < keys; index += 1) {
    metadata[`k${index.toString().padStart(6, "0")}`] = index
  }
  return `${JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          id: "c0",
          metadata: {},
          outputs: [],
          source: ["print(0)"]
        }
      ],
      metadata,
      nbformat: 4,
      nbformat_minor: 5
    },
    null,
    1
  )}\n`
}

const measureMetadataPatch = (keys: number): number => {
  const text = buildMetadataNotebook(keys)
  const next = JSON.parse(text) as { metadata: Record<string, number> }
  const keep: Record<string, number> = {}
  for (const key of Object.keys(next.metadata)) {
    if (Number(key.slice(1)) % 2 === 1) keep[key] = next.metadata[key]!
  }
  for (let index = 0; index < keys / 4; index += 1) {
    keep[`a${index.toString().padStart(6, "0")}`] = index
    keep[`z${index.toString().padStart(6, "0")}`] = index
  }
  next.metadata = keep
  const started = Bun.nanoseconds()
  const result = patchJsonTextDetailed(text, next, { style: patchStyle })
  if (result.text === undefined) throw new Error(`metadata patch fell back: ${result.reason}`)
  return (Bun.nanoseconds() - started) / 1e6
}

const buildEvenMetadataNotebook = (keys: number): string => {
  const metadata: Record<string, number> = {}
  for (let index = 0; index < keys; index += 2) {
    metadata[`k${index.toString().padStart(6, "0")}`] = index
  }
  return `${JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: null,
          id: "c0",
          metadata: {},
          outputs: [],
          source: ["print(0)"]
        }
      ],
      metadata,
      nbformat: 4,
      nbformat_minor: 5
    },
    null,
    1
  )}\n`
}

const measureInterleavedMetadataPatch = (keys: number): number => {
  const text = buildEvenMetadataNotebook(keys)
  const next = JSON.parse(text) as { metadata: Record<string, number> }
  const target: Record<string, number> = {}
  for (const key of Object.keys(next.metadata)) {
    target[key] = next.metadata[key]!
    const odd = Number(key.slice(1)) + 1
    if (odd < keys) target[`k${odd.toString().padStart(6, "0")}`] = odd
  }
  next.metadata = target
  const started = Bun.nanoseconds()
  const result = patchJsonTextDetailed(text, next, { style: patchStyle })
  if (result.text === undefined) {
    throw new Error(`interleaved metadata patch fell back: ${result.reason}`)
  }
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
const META_SMALL = Number(process.env.IPYNB_BENCH_META_SMALL ?? "1000")
const META_LARGE = Number(process.env.IPYNB_BENCH_META_LARGE ?? "32000")
const INTERLEAVED_SMALL = Number(process.env.IPYNB_BENCH_INTERLEAVED_SMALL ?? "1000")
const INTERLEAVED_LARGE = Number(process.env.IPYNB_BENCH_INTERLEAVED_LARGE ?? "64000")

const measureLargeOutput = (): { ms: number; rssDeltaMb: number } => {
  const { formatOutputs } = require("../src/format/outputs.js") as {
    formatOutputs: (
      outputs: ReadonlyArray<Record<string, unknown>>,
      options: { maxOutputChars: number }
    ) => string
  }
  const text = "x".repeat(40 * 1024 * 1024)
  const before = process.memoryUsage().rss
  const started = Bun.nanoseconds()
  formatOutputs(
    [{ output_type: "stream", name: "stdout", text }],
    { maxOutputChars: 6_000 }
  )
  return {
    ms: (Bun.nanoseconds() - started) / 1e6,
    rssDeltaMb: (process.memoryUsage().rss - before) / 1e6
  }
}

const measureUnicodeEscape = (): { ms: number; rssDeltaMb: number } => {
  const { formatJsonValue } = require("../src/utils/json-patch.js") as {
    formatJsonValue: (
      value: unknown,
      style: Record<string, unknown>,
      multiline?: boolean
    ) => string
  }
  const value = {
    cells: [],
    metadata: { note: "é".repeat(4 * 1024 * 1024) },
    nbformat: 4,
    nbformat_minor: 5
  }
  const style = {
    unit: " ",
    newline: "\n",
    itemSeparator: ", ",
    keySeparator: ": ",
    ensureAscii: true
  }
  const before = process.memoryUsage().rss
  const started = Bun.nanoseconds()
  formatJsonValue(value, style, true)
  return {
    ms: (Bun.nanoseconds() - started) / 1e6,
    rssDeltaMb: (process.memoryUsage().rss - before) / 1e6
  }
}

const measureObjectHeavyPatch = (): { ms: number; rssDeltaMb: number } => {
  const { patchJsonTextDetailed } = require("../src/utils/json-patch.js") as {
    patchJsonTextDetailed: (
      text: string,
      next: unknown,
      options: { style: Record<string, unknown> }
    ) => { text?: string; reason?: string }
  }
  const metadata: Record<string, number> = {}
  for (let index = 0; index < 64_000; index += 1) {
    metadata[`k${String(index).padStart(6, "0")}`] = index
  }
  const text = JSON.stringify({
    cells: [],
    metadata,
    nbformat: 4,
    nbformat_minor: 5
  })
  const next = JSON.parse(text) as { metadata: Record<string, number> }
  next.metadata.k000005 = 999
  const style = {
    unit: " ",
    newline: "\n",
    itemSeparator: ", ",
    keySeparator: ": ",
    ensureAscii: false
  }
  const before = process.memoryUsage().rss
  const started = Bun.nanoseconds()
  patchJsonTextDetailed(text, next, { style })
  return {
    ms: (Bun.nanoseconds() - started) / 1e6,
    rssDeltaMb: (process.memoryUsage().rss - before) / 1e6
  }
}

const measureLargeNotebookEdit = async (): Promise<{
  ms: number
  rssDeltaMb: number
  mb: number
}> => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-bench-large-"))
  try {
    const cells = Array.from({ length: 64_000 }, (_, index) => ({
      cell_type: "code",
      execution_count: index,
      metadata: {},
      outputs: [{ output_type: "stream", name: "stdout", text: ["line\n".repeat(20)] }],
      source: ["print(1)"]
    }))
    const file = path.join(dir, "large.ipynb")
    const body = JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 })
    fs.writeFileSync(file, body)
    const pathSvc = makePathService({
      directory: dir,
      worktree: dir,
      platform: process.platform
    })
    const edit = makeEditImpl(
      pathSvc,
      makeNotebookFileService(),
      makePermissionService(makeContext(dir))
    )
    const before = process.memoryUsage().rss
    const started = Bun.nanoseconds()
    await Effect.runPromise(
      edit.editCell(file, { cellIndex: 5, source: "print(2)", clearOutputs: "always" })
    )
    return {
      ms: (Bun.nanoseconds() - started) / 1e6,
      rssDeltaMb: (process.memoryUsage().rss - before) / 1e6,
      mb: body.length / 1e6
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const measurePatchAllocation = (): { ok: boolean; line: string } => {
  const result = Bun.spawnSync(
    [process.execPath, "--expose-gc", path.join(import.meta.dir, "bench-alloc.ts")],
    { stdout: "pipe", stderr: "pipe" }
  )
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim()
  return { ok: (result.exitCode ?? 1) === 0, line: output.split("\n").slice(-2).join(" | ") }
}

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
  const metadataSmall = measureMetadataPatch(META_SMALL)
  const metadataLarge = measureMetadataPatch(META_LARGE)
  const metadataRatio =
    metadataLarge / Math.max(metadataSmall, 0.5) / (META_LARGE / META_SMALL)
  console.log(
    `metadata object patch ${META_SMALL}->${META_LARGE} keys: ${metadataSmall.toFixed(1)}ms -> ${metadataLarge.toFixed(1)}ms (${metadataRatio.toFixed(2)}x of linear)`
  )
  const interleavedSmall = measureInterleavedMetadataPatch(INTERLEAVED_SMALL)
  const interleavedLarge = measureInterleavedMetadataPatch(INTERLEAVED_LARGE)
  const interleavedRatio =
    interleavedLarge /
    Math.max(interleavedSmall, 0.5) /
    (INTERLEAVED_LARGE / INTERLEAVED_SMALL)
  console.log(
    `interleaved metadata patch ${INTERLEAVED_SMALL}->${INTERLEAVED_LARGE} keys: ${interleavedSmall.toFixed(1)}ms -> ${interleavedLarge.toFixed(1)}ms (${interleavedRatio.toFixed(2)}x of linear)`
  )
  const largeOutput = measureLargeOutput()
  console.log(
    `large per-cell output 40MB with maxOutputChars=6000: ${largeOutput.ms.toFixed(1)}ms, rss +${largeOutput.rssDeltaMb.toFixed(0)}MB`
  )
  const unicodeEscape = measureUnicodeEscape()
  console.log(
    `unicode escape 4MB ensureAscii: ${unicodeEscape.ms.toFixed(1)}ms, rss +${unicodeEscape.rssDeltaMb.toFixed(0)}MB`
  )
  const patchAllocation = measurePatchAllocation()
  console.log(`patch allocation guard: ${patchAllocation.line}`)
  const objectHeavy = measureObjectHeavyPatch()
  console.log(
    `one-key edit in 64k-key metadata: ${objectHeavy.ms.toFixed(0)}ms, rss +${objectHeavy.rssDeltaMb.toFixed(0)}MB`
  )
  const largeEdit = await measureLargeNotebookEdit()
  console.log(
    `one-cell edit in a ${largeEdit.mb.toFixed(1)}MB / 64k-cell notebook: ${largeEdit.ms.toFixed(0)}ms, rss +${largeEdit.rssDeltaMb.toFixed(0)}MB`
  )
  const failures: string[] = []
  if (!patchAllocation.ok) failures.push("patchAllocation (see bench-alloc.ts)")
  // These are absolute budgets, not a discriminator between implementations:
  // 18 lazy runs measured 421-585 ms / 91-231 MB and 5 eager runs 464-663 ms /
  // 213-288 MB, so this machine's variance overlaps the two. The ceilings only
  // catch a gross regression (a runaway allocation or a quadratic patch).
  if (largeEdit.ms > 900) failures.push(`largeEditTime ${largeEdit.ms.toFixed(0)}ms`)
  if (largeEdit.rssDeltaMb > 400) failures.push(`largeEditRss ${largeEdit.rssDeltaMb.toFixed(0)}MB`)
  // The object-heavy delta is often negative (the GC frees more than the patch
  // allocates), so only the time budget is meaningful here.
  if (objectHeavy.ms > 400) failures.push(`objectHeavyTime ${objectHeavy.ms.toFixed(0)}ms`)
  if (unicodeEscape.ms > 400) failures.push(`unicodeEscapeTime ${unicodeEscape.ms.toFixed(1)}ms`)
  if (unicodeEscape.rssDeltaMb > 200) failures.push(`unicodeEscapeRss ${unicodeEscape.rssDeltaMb.toFixed(0)}MB`)
  if (largeOutput.ms > 200) failures.push(`largeOutputTime ${largeOutput.ms.toFixed(1)}ms`)
  if (largeOutput.rssDeltaMb > 100) failures.push(`largeOutputRss ${largeOutput.rssDeltaMb.toFixed(0)}MB`)
  if (normalized.clearAll > BUDGET) failures.push(`clearAll ${normalized.clearAll.toFixed(2)}x`)
  if (normalized.move > BUDGET) failures.push(`move ${normalized.move.toFixed(2)}x`)
  if (normalized.edit > BUDGET) failures.push(`edit ${normalized.edit.toFixed(2)}x`)
  if (normalized.patch > BUDGET) failures.push(`patchAll ${normalized.patch.toFixed(2)}x`)
  if (metadataRatio > BUDGET) failures.push(`metadataPatch ${metadataRatio.toFixed(2)}x`)
  if (interleavedRatio > BUDGET) {
    failures.push(`interleavedMetadataPatch ${interleavedRatio.toFixed(2)}x`)
  }
  if (failures.length > 0) {
    console.error(
      `FAIL: write cost grows faster than the notebook (budget ${BUDGET}x linear): ${failures.join(", ")}`
    )
    process.exit(1)
  }
  console.log(`ok: every write is within ${BUDGET}x of linear for a ${ratio.bytes.toFixed(1)}x larger notebook`)
}

await main()
