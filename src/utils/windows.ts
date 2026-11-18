import { spawn } from "node:child_process"
import * as path from "node:path"

export const taskkillPath = (): string => {
  const root =
    process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows"
  return path.join(root, "System32", "taskkill.exe")
}

export const killWindowsTree = (pid: number): void => {
  try {
    const child = spawn(taskkillPath(), ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    })
    child.on("error", () => {})
  } catch {
  }
}
