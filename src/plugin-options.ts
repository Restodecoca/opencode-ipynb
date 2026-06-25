import { z } from "zod"

export const PluginOptionsSchema = z.object({
  pythonPath: z
    .string()
    .optional()
    .describe(
      "Absolute path to a Python interpreter. Falls back to OPENCODE_IPYNB_PYTHON env, then 'python', then 'python3'."
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
    .describe("Where to look for the Python helper, relative to the plugin or worktree."),
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
      "Default maximum number of output characters per cell for ipynb_read and ipynb_outputs read. Callers can still pass an explicit maxOutputChars to override."
    ),
  warmKernel: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "v1.0 — keep a long-lived Python kernel per notebook path so successive ipynb_run calls reuse the same kernel state. Default: false (one-shot subprocess per call). Requires nbformat/nbclient/jupyter_client/ipykernel in the user's Python."
    )
})
export type PluginOptions = z.infer<typeof PluginOptionsSchema>

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
