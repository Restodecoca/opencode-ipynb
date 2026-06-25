import { Context, Effect } from "effect"
import { createTwoFilesPatch, diffLines, type Change } from "diff"

export interface DiffServiceShape {
  readonly cellDiff: (oldSource: string, newSource: string) => string
  readonly notebookJsonDiff: (oldJson: string, newJson: string, filePath: string) => string
}

export class DiffService extends Context.Tag("@ipynb/DiffService")<DiffService, DiffServiceShape>() {}

const buildDiff = (): DiffServiceShape => ({
  cellDiff: (oldSource, newSource) => {
    if (oldSource === newSource) {
      return "(no source changes)"
    }
    const changes: Change[] = diffLines(oldSource, newSource)
    const parts: string[] = []
    for (const change of changes) {
      const lines = change.value.split("\n")
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop()
      }
      for (const line of lines) {
        if (change.added) {
          parts.push(`+ ${line}`)
        } else if (change.removed) {
          parts.push(`- ${line}`)
        } else {
          parts.push(`  ${line}`)
        }
      }
    }
    return parts.join("\n")
  },
  notebookJsonDiff: (oldJson, newJson, filePath) => {
    return createTwoFilesPatch(`${filePath} (before)`, `${filePath} (after)`, oldJson, newJson, "", "", {
      context: 3
    })
  }
})

export const makeDiffService = buildDiff

export const _internal = { buildDiff, diffLines }
export const _Effect = Effect
