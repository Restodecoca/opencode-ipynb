import * as fsp from "node:fs/promises"
import * as path from "node:path"

const ATTEMPTS = 3

const parentIsStable = async (target: string): Promise<boolean> => {
  const parent = path.dirname(target)
  if (parent === target) return false
  try {
    await fsp.stat(parent)
    return true
  } catch {
    return false
  }
}

export const realpathWithRetry = async (target: string): Promise<string> => {
  let failure: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await fsp.realpath(target)
    } catch (error) {
      failure = error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (!(await parentIsStable(target))) throw error
      if (attempt + 1 < ATTEMPTS) await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  throw failure
}
