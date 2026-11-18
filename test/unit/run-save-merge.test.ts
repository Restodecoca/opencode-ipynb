import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  mergeExecutedOutputs,
  type MergeShapeInputs
} from "../../src/services/NotebookExecutionService.js"
import type { CellRaw, CodeCellRaw } from "../../src/domain/cell.js"
import type { CellExecutionSummary } from "../../src/domain/execution.js"

const codeCell = (): CellRaw =>
  ({
    cell_type: "code",
    execution_count: null,
    metadata: {},
    outputs: [],
    source: "x = 1"
  }) as CellRaw

const summaryAt = (
  cellIndex: number,
  stdout: string
): CellExecutionSummary =>
  ({
    cellIndex,
    status: "ok",
    stdout
  }) as CellExecutionSummary

const shapes = (fallback: MergeShapeInputs["fallback"] = "strings"): MergeShapeInputs => ({
  fallback,
  beforeShapes: undefined,
  beforeValueShapes: undefined
})

describe("mergeExecutedOutputs", () => {
  it("keeps the first summary when the runner reports duplicates", async () => {
    const exit = await Effect.runPromiseExit(
      mergeExecutedOutputs("n.ipynb", [codeCell()], [0], [
        summaryAt(0, "first"),
        summaryAt(0, "second")
      ], shapes())
    )
    if (exit._tag !== "Success") throw new Error("expected a success")
    const merged: Map<number, CodeCellRaw> = exit.value
    expect(merged.size).toBe(1)
    const outputs = [...merged.get(0)!.outputs]
    expect(outputs[0]).toMatchObject({ name: "stdout", text: "first" })
  })

  it("skips non-code cells and cells without a summary", async () => {
    const cells: CellRaw[] = [
      codeCell(),
      { cell_type: "markdown", metadata: {}, source: "text" } as unknown as CellRaw
    ]
    const exit = await Effect.runPromiseExit(
      mergeExecutedOutputs("n.ipynb", cells, [0, 1], [summaryAt(0, "ok")], shapes())
    )
    if (exit._tag !== "Success") throw new Error("expected a success")
    expect(exit.value.size).toBe(1)
    expect([...exit.value.keys()]).toEqual([0])
  })

  it("fails with the reported index when the runner goes out of bounds", async () => {
    const exit = await Effect.runPromiseExit(
      mergeExecutedOutputs("n.ipynb", [codeCell()], [3], [], shapes())
    )
    expect(exit._tag).toBe("Failure")
  })

  it("scales linearly with executed cells", async () => {
    const cells: CellRaw[] = []
    const executedCells: number[] = []
    const summaries: CellExecutionSummary[] = []
    for (let index = 0; index < 32_000; index += 1) {
      cells.push(codeCell())
      executedCells.push(index)
      summaries.push(summaryAt(index, `out ${index}`))
    }
    const started = Date.now()
    const exit = await Effect.runPromiseExit(
      mergeExecutedOutputs("n.ipynb", cells, executedCells, summaries, shapes())
    )
    const elapsed = Date.now() - started
    if (exit._tag !== "Success") throw new Error("expected a success")
    expect(exit.value.size).toBe(32_000)
    expect([...exit.value.get(31_999)!.outputs][0]).toMatchObject({
      text: "out 31999"
    })
    expect(elapsed).toBeLessThan(300)
  })
})
