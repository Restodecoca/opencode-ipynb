import { spawn } from "node:child_process"
import * as path from "node:path"

/** Absolute taskkill path so CreateProcess never searches the project cwd. */
export const taskkillPath = (): string => {
  const root =
    process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows"
  return path.join(root, "System32", "taskkill.exe")
}

/** Best-effort taskkill with an error listener (never crashes the host). */
export const killWindowsTree = (pid: number): void => {
  try {
    const child = spawn(taskkillPath(), ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    })
    child.on("error", () => {})
  } catch {
    // ignore
  }
}
