import { spawn } from "node:child_process"
import * as path from "node:path"
import { type WarningSink, warningFrom } from "./warnings.js"

export const taskkillPath = (): string => {
  const root =
    process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows"
  return path.join(root, "System32", "taskkill.exe")
}

export const killWindowsTree = (pid: number, sink?: WarningSink): void => {
  const context = `taskkill ${pid}`
  try {
    const child = spawn(taskkillPath(), ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    })
    child.on("error", (error) => {
      sink?.add(warningFrom("cleanup", error, context))
    })
  } catch (error) {
    sink?.add(warningFrom("cleanup", error, context))
  }
}
