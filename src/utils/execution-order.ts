import type { NotebookRaw } from "../domain/notebook.js"

export interface ExecutionOrderEntry {
  readonly cellIndex: number
  readonly executionCount: number
  readonly previousCount: number
}

/** Cells whose execution_count is lower than a previous non-null count. */
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
      // A null count is a fresh-run boundary: subsequent cells compare
      // against the new starting count, not the last non-null one.
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
