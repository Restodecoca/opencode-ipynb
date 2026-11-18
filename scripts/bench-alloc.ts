import { patchJsonTextDetailed } from "../src/utils/json-patch.js"

interface Sample {
  readonly heapDeltaMb: number
}

const CELLS = 64_000
const LINES = 20
const RUNS = 5
const LIMIT_MB = 60

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

const samples: Sample[] = []
for (let run = 0; run < RUNS; run += 1) {
  globalThis.gc?.()
  const before = process.memoryUsage().heapUsed
  const result = patchJsonTextDetailed(text, next, { style })
  if (result.text === undefined) {
    console.error(`patch failed: ${result.reason ?? "unknown"}`)
    process.exit(1)
  }
  samples.push({ heapDeltaMb: (process.memoryUsage().heapUsed - before) / 1e6 })
}

const sorted = [...samples].sort((a, b) => a.heapDeltaMb - b.heapDeltaMb)
const median = sorted[Math.floor(sorted.length / 2)]!.heapDeltaMb
const worst = sorted[sorted.length - 1]!.heapDeltaMb
console.log(
  `patch allocation (${CELLS} cells, ${RUNS} runs): median ${median.toFixed(1)}MB, worst ${worst.toFixed(1)}MB, limit ${LIMIT_MB}MB`
)
if (median > LIMIT_MB) {
  console.error(
    `FAIL: median patch allocation ${median.toFixed(1)}MB exceeds ${LIMIT_MB}MB (the eager node tree measured 161-171MB)`
  )
  process.exit(1)
}
