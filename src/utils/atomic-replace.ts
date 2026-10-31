import { promises as fsp } from "node:fs"
import { randomBytes } from "node:crypto"

/**
 * Rename `temp` over `target`. On Windows rename fails when the target
 * exists; move the original to a backup first and restore it if the second
 * rename fails, so a failed replace never deletes the only copy.
 */
export const replaceFile = async (
  temp: string,
  target: string
): Promise<void> => {
  try {
    await fsp.rename(temp, target)
    return
  } catch (error) {
    if (process.platform !== "win32") throw error
    const backup = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.bak`
    let backedUp = false
    try {
      await fsp.rename(target, backup)
      backedUp = true
    } catch {
      // Target did not exist or could not be moved.
    }
    try {
      await fsp.rename(temp, target)
    } catch (second) {
      if (backedUp) {
        await fsp.rename(backup, target).catch(() => {})
      }
      throw second
    }
    if (backedUp) await fsp.rm(backup, { force: true }).catch(() => {})
  }
}
