/** Fence long enough that backticks inside the content cannot close it. */
export const codeFence = (text: string): string => {
  const runs = text.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return "`".repeat(Math.max(3, longest + 1))
}
