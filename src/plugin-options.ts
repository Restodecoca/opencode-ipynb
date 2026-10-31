import { z } from "zod"
import * as fs from "node:fs"
import * as path from "node:path"

export const PluginOptionsSchema = z.object({
  pythonPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to a Python interpreter, or a bare name resolved through PATH. OPENCODE_IPYNB_PYTHON overrides this option; otherwise the plugin uses 'python' when present, else 'python3'. Relative path-like values are rejected."
    ),
  preferUv: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true, the doctor tool will suggest `uv pip install` instead of `pip install`."),
  helperRelativePath: z
    .string()
    .optional()
    .default("python/ipynb_runner.py")
    .describe("Path to the Python helper, relative to the plugin package or absolute. It is never resolved from the project worktree."),
  defaultTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(120_000)
    .describe("Default timeout (ms) for ipynb_run when the caller does not specify one."),
  allowOutsideWorktree: z
    .boolean()
    .optional()
    .describe(
      "Power-user escape hatch: when true, PathService.ensureInsideWorktree becomes a no-op and accepts paths outside the worktree. Use at your own risk."
    ),
  defaultMaxOutputChars: z
    .number()
    .int()
    .positive()
    .optional()
    .default(6_000)
    .describe(
      "Default maximum number of output characters per cell for ipynb_read, ipynb_outputs read, and ipynb_run. Callers can still pass an explicit maxOutputChars to override."
    ),
  warmKernel: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Keep a long-lived Python kernel per notebook path so successive ipynb_run calls reuse the same kernel state. Default: false (one-shot subprocess per call). Requires nbformat/nbclient/jupyter_client/ipykernel in the user's Python."
    ),
  lspDiagnostics: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Run pyright on the notebook's virtual Python document after code-changing tools and append errors to the result. Set false to disable the extra diagnostics pass."
    ),
  pyrightPath: z
    .string()
    .optional()
    .default("pyright")
    .describe(
      "Pyright executable used for notebook diagnostics. Set an absolute path if pyright is not on PATH."
    ),
  diagnosticsTimeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .default(15_000)
    .describe("Timeout (ms) for the notebook diagnostics pass.")
})
export type PluginOptions = z.infer<typeof PluginOptionsSchema>

/**
 * Resolve the interpreter used for execution and diagnostics. The explicit
 * environment variable wins over the plugin option, matching the README.
 */
const findExecutable = (name: string): string | undefined => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const names =
    process.platform === "win32" && !/\.[a-z0-9]+$/i.test(name)
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
      : [name]
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue
    const dirAbs = dir
    for (const candidateName of names) {
      const candidate = path.join(dirAbs, candidateName)
      try {
        if (!fs.statSync(candidate).isFile()) continue
        if (process.platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {
        // keep looking
      }
    }
  }
  return undefined
}

export const resolvePythonPath = (
  options: Pick<PluginOptions, "pythonPath">
): string | undefined => {
  const env = process.env.OPENCODE_IPYNB_PYTHON
  const value =
    env !== undefined && env.length > 0 ? env : options.pythonPath
  if (value === undefined || value.trim().length === 0) return undefined
  const trimmed = value.trim()
  // Path-like values must be absolute so the permission resource and the
  // spawned executable cannot diverge. Bare names are resolved through PATH
  // here, because pyright's --pythonpath resolves relative values against the
  // notebook directory.
  if (!path.isAbsolute(trimmed) && /[\\/]/.test(trimmed)) {
    throw new Error(
      "pythonPath must be absolute or a bare command name resolved through PATH"
    )
  }
  const resolved = path.isAbsolute(trimmed)
    ? trimmed
    : findExecutable(trimmed)
  if (resolved === undefined) {
    throw new Error(`pythonPath "${trimmed}" was not found on PATH`)
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(resolved)
  } catch {
    throw new Error(`pythonPath "${resolved}" does not exist`)
  }
  if (!stat.isFile()) {
    throw new Error(`pythonPath "${resolved}" is not a regular file`)
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    throw new Error(
      `pythonPath "${resolved}" is a batch shim; use python.exe or an absolute interpreter`
    )
  }
  if (process.platform !== "win32") {
    try {
      fs.accessSync(resolved, fs.constants.X_OK)
    } catch {
      throw new Error(`pythonPath "${resolved}" is not executable`)
    }
  }
  return resolved
}

export const parsePluginOptions = (
  raw: unknown,
  fallback: Partial<PluginOptions> = {}
): PluginOptions => {
  const base = PluginOptionsSchema.parse(fallback)
  if (raw === undefined || raw === null) {
    return base
  }
  const merged = { ...base, ...(raw as Record<string, unknown>) }
  return PluginOptionsSchema.parse(merged)
}
