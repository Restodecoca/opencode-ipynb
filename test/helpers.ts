import { describe } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"

/**
 * True when both paths denote the same physical file or directory.
 *
 * macOS spells the temp dir through a symlink (/tmp -> /private/tmp) and
 * Windows through 8.3 short names (RUNNER~1), so the implementation's resolved
 * paths and a test's lexical paths are two spellings of one inode. Spy hooks
 * and assertions must compare what a path denotes, not how it is spelled.
 */
export const samePhysicalPath = (a: string, b: string): boolean => {
  try {
    const left = fs.statSync(a)
    const right = fs.statSync(b)
    return left.ino === right.ino && left.dev === right.dev
  } catch {
    return false
  }
}

export const pythonHas = (module: string): boolean => {
  const code = `import sys, importlib.util; sys.exit(0 if importlib.util.find_spec("${module}") else 1)`
  const r = spawnSync("python", ["-c", code], { encoding: "utf8" })
  return r.status === 0
}

export const realHelperAvailable = (): boolean =>
  pythonHas("nbformat") && pythonHas("nbclient") && pythonHas("ipykernel")

export const realHelperEnabled = (): boolean => {
  if (process.env.SKIP_REAL_HELPER === "1") return false
  return realHelperAvailable()
}

export const describeIf = (cond: boolean, name: string, fn: () => void): void => {
  if (cond) describe(name, fn)
  else describe.skip(name, fn)
}
