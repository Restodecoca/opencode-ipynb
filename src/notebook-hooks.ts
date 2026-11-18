
export const notebookMutatingTools = new Set([
  "ipynb_edit",
  "ipynb_cell_insert",
  "ipynb_cell_delete",
  "ipynb_cell_move",
  "ipynb_clean",
  "ipynb_outputs",
  "ipynb_run"
])

export const diagnosableTools = new Set([
  "ipynb_edit",
  "ipynb_cell_insert",
  "ipynb_cell_delete",
  "ipynb_cell_move"
])

export function toolName(tool: string): string {
  const known = [...notebookMutatingTools, ...diagnosableTools]
  if (known.includes(tool)) return tool
  return (
    known.find(
      (name) => tool.endsWith(`_${name}`) || tool.endsWith(`.${name}`)
    ) ?? tool
  )
}

export const changedNotebook = (
  tool: string,
  input: unknown,
  metadata?: Record<string, unknown>
): boolean => {
  const name = toolName(tool)
  if (!notebookMutatingTools.has(name)) return false
  if (metadata?.error === true) return false
  const value = input as
    | { operation?: unknown; save?: unknown; fromIndex?: unknown; toIndex?: unknown }
    | undefined
  if (name === "ipynb_outputs") {
    if (value?.operation !== "clear_cell" && value?.operation !== "clear_all") return false
    const removed =
      (typeof metadata?.removedOutputs === "number" ? metadata.removedOutputs : 0) +
      (typeof metadata?.removedExecutionCounts === "number"
        ? metadata.removedExecutionCounts
        : 0)
    return removed > 0
  }
  if (name === "ipynb_run") {
    if (value?.save === false) return false
    return !Array.isArray(metadata?.executedCells) || metadata.executedCells.length > 0
  }
  if (name === "ipynb_clean") {
    const removed =
      (typeof metadata?.affectedCells === "number" ? metadata.affectedCells : 0) +
      (typeof metadata?.removedOutputs === "number" ? metadata.removedOutputs : 0) +
      (typeof metadata?.removedExecutionCounts === "number"
        ? metadata.removedExecutionCounts
        : 0) +
      (typeof metadata?.removedWidgets === "number" ? metadata.removedWidgets : 0) +
      (typeof metadata?.removedImages === "number" ? metadata.removedImages : 0)
    return removed > 0
  }
  if (name === "ipynb_cell_move") {
    const from =
      typeof metadata?.fromIndex === "number" ? metadata.fromIndex : value?.fromIndex
    const to = typeof metadata?.toIndex === "number" ? metadata.toIndex : value?.toIndex
    return from !== to
  }
  if (name === "ipynb_edit") return metadata?.changed !== false
  return true
}

export const changesCode = (
  name: string,
  metadata?: Record<string, unknown>
): boolean => {
  switch (name) {
    case "ipynb_edit":
    case "ipynb_cell_insert":
      return metadata?.cellType === "code"
    case "ipynb_cell_delete":
      return metadata?.deletedType === "code"
    case "ipynb_cell_move":
      return metadata?.cellType === "code"
    default:
      return false
  }
}

export type MutableResult = {
  content?:
    | string
    | ReadonlyArray<
        | { type: "text"; text: string }
        | { type: "file"; uri: string; mime: string; name?: string }
      >
  metadata?: Record<string, unknown>
}

export const appendResultText = (
  result: MutableResult,
  text: string
): void => {
  const block = { type: "text" as const, text: `\n\n${text}` }
  if (typeof result.content === "string") {
    result.content += `\n\n${text}`
    return
  }
  if (Array.isArray(result.content)) {
    result.content = [...result.content, block]
    return
  }
  result.content = text
}
