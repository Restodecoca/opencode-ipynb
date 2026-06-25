import { spawnSync } from "node:child_process"

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
