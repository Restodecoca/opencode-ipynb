import { promises as fsp } from "node:fs"
import { randomBytes } from "node:crypto"
import { type WarningSink, warningFrom } from "./warnings.js"

export const replaceFile = async (
  temp: string,
  target: string,
  sink?: WarningSink
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
    } catch (moveError) {
      sink?.add(warningFrom("atomic-replace", moveError, "backup before replace"))
    }
    try {
      await fsp.rename(temp, target)
    } catch (second) {
      if (backedUp) {
        try {
          await fsp.rename(backup, target)
        } catch (restoreError) {
          sink?.add(
            warningFrom(
              "atomic-replace",
              restoreError,
              `restore failed, original kept at ${backup}`
            )
          )
        }
      }
      throw second
    }
    if (backedUp) {
      try {
        await fsp.rm(backup, { force: true })
      } catch (cleanupError) {
        sink?.add(warningFrom("atomic-replace", cleanupError, `left ${backup}`))
      }
    }
  }
}
