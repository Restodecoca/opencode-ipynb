import { promises as fsp } from "node:fs"

const ATTEMPTS = 5
const DELAY_MS = 2

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const realpathWithRetry = async (target: string): Promise<string> => {
  let failure: unknown
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try {
      return await fsp.realpath(target)
    } catch (error) {
      failure = error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      if (attempt + 1 < ATTEMPTS) await sleep(DELAY_MS)
    }
  }
  throw failure
}
