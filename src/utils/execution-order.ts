import type { NotebookRaw } from "../domain/notebook.js"

export interface ExecutionOrderEntry {
  readonly cellIndex: number
  readonly executionCount: number
  readonly previousCount: number
}

export const analyzeExecutionOrder = (
  notebook: NotebookRaw
): ReadonlyArray<ExecutionOrderEntry> => {
  const outOfOrder: ExecutionOrderEntry[] = []
  let lastCount: number | null = null
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]
    if (!cell || cell.cell_type !== "code") continue
    const ec = cell.execution_count
    if (ec === null || ec === undefined) {
      lastCount = null
      continue
    }
    if (lastCount !== null && ec < lastCount) {
      outOfOrder.push({
        cellIndex: i,
        executionCount: ec,
        previousCount: lastCount
      })
    }
    lastCount = ec
  }
  return outOfOrder
}
