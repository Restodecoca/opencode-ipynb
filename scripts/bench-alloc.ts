import { patchJsonTextDetailed } from "../src/utils/json-patch.js"

interface Sample {
  readonly heapDeltaMb: number
  readonly rssDeltaMb: number
}

const CELLS = 64_000
const LINES = 20
const RUNS = 5
const LIMIT_MB = 60
// A retained copy of the 17 MB output grows RSS by ~150 MB per run; a healthy
// run releases it, so the median stays near zero.
const RSS_LIMIT_MB = 40

const build = (): { text: string; next: unknown } => {
  const cells = Array.from({ length: CELLS }, (_, index) => ({
    cell_type: "code",
    execution_count: index,
    metadata: {},
    outputs: [
      {
        output_type: "stream",
        name: "stdout",
        text: ["line\n".repeat(LINES)]
      }
    ],
    source: ["print(1)"]
  }))
  const text = JSON.stringify({
    cells,
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5
  })
  const next = JSON.parse(text) as { cells: Array<{ source: string[] }> }
  next.cells[5]!.source = ["print(2)"]
  return { text, next }
}

const style = {
  unit: " ",
  newline: "\n" as const,
  itemSeparator: ", ",
  keySeparator: ": ",
  ensureAscii: false
}

const { text, next } = build()

patchJsonTextDetailed(text, next, { style })

// win32 Bun freezes `heapUsed` (a retained 20M-element array reports 0 MB), so
// a heap-delta guard there would pass for every implementation, including a
// deliberate 480 MB hog. Skip loudly instead of reporting a false green.
if ((await import("node:process")).platform === "win32") {
  console.log(
    "SKIP: heapUsed is frozen on win32, so the allocation guard cannot discriminate there"
  )
  process.exit(0)
}

// Two signals, because Bun's heapUsed only moves on collection boundaries:
// consecutive calls inside one GC epoch report exactly 0, which made a retained
// leak (keeping every patched string) invisible. Heap catches transient work,
// RSS after GC catches anything that stays reachable. Both are medians so one
// noisy run cannot fail the guard.
const samples: Sample[] = []
globalThis.gc?.()
const rssBaseline = process.memoryUsage().rss
for (let run = 0; run < RUNS; run += 1) {
  globalThis.gc?.()
  const heapBefore = process.memoryUsage().heapUsed
  const rssBefore = process.memoryUsage().rss
  const result = patchJsonTextDetailed(text, next, { style })
  if (result.text === undefined) {
    console.error(`patch failed: ${result.reason ?? "unknown"}`)
    process.exit(1)
  }
  const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / 1e6
  // RSS after a collection is the retained signal: a run that keeps its output
  // grows by ~150 MB per iteration, a healthy one returns to its baseline.
  globalThis.gc?.()
  samples.push({
    heapDeltaMb,
    rssDeltaMb: (process.memoryUsage().rss - rssBefore) / 1e6
  })
}

const medianOf = (values: ReadonlyArray<number>): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
const heapMedian = medianOf(samples.map((sample) => sample.heapDeltaMb))
// Cumulative growth is what a leak looks like: each run that keeps its output
// adds ~17 MB and a collection cannot reclaim it.
const rssGrowthMb = (process.memoryUsage().rss - rssBaseline) / 1e6
console.log(
  `patch allocation (${CELLS} cells, ${RUNS} runs): heap median ${heapMedian.toFixed(1)}MB (limit ${LIMIT_MB}MB), rss growth ${rssGrowthMb.toFixed(1)}MB (limit ${RSS_LIMIT_MB}MB)`
)
if (heapMedian > LIMIT_MB) {
  console.error(
    `FAIL: median patch allocation ${heapMedian.toFixed(1)}MB exceeds ${LIMIT_MB}MB (the eager node tree measured 161-171MB)`
  )
  process.exit(1)
}
if (rssGrowthMb > RSS_LIMIT_MB) {
  console.error(
    `FAIL: rss grew ${rssGrowthMb.toFixed(1)}MB across ${RUNS} runs (limit ${RSS_LIMIT_MB}MB); a retained copy is not being released`
  )
  process.exit(1)
}
