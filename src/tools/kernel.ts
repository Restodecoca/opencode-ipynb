import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage, type PathOutsideWorktreeError } from "../domain/errors.js"
import { resolveToolOptions } from "./_resolveOptions.js"

const args = {
  action: z
    .enum(["list", "restart", "shutdown", "status"])
    .describe(
      "What to do: 'list' shows live kernels; 'restart' kills and respawns the kernel for a given filePath; 'shutdown' kills it; 'status' shows the warm-kernel feature flag and aggregate stats."
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      "Absolute or relative path to the .ipynb file. Required for 'restart' and 'shutdown'. Ignored for 'list' and 'status'."
    )
}

const formatList = (
  items: ReadonlyArray<{
    filePath: string
    pid: number
    lastUsedAt: number
    requestsHandled: number
    stderrTail: string
  }>
): string => {
  if (items.length === 0) {
    return "(no live warm kernels)"
  }
  const lines: string[] = []
  for (const k of items) {
    const ageMs = Math.max(0, Date.now() - k.lastUsedAt)
    lines.push(
      `- pid=${k.pid}  requests=${k.requestsHandled}  lastUsed=${ageMs}ms ago  file=\`${k.filePath}\``
    )
    if (k.stderrTail) {
      const tail = k.stderrTail
        .split("\n")
        .slice(-3)
        .map((l) => `    ${l}`)
        .join("\n")
      lines.push("  stderr (last 3 lines):")
      lines.push(tail)
    }
  }
  return lines.join("\n")
}

const run = (
  services: ReturnType<typeof buildServices>,
  input: z.infer<z.ZodObject<typeof args>>
): Effect.Effect<
  { readonly output: string; readonly metadata: Record<string, unknown> },
  PathOutsideWorktreeError
> =>
  Effect.gen(function* () {
    const pluginOpts = resolveToolOptions()
    if (!pluginOpts.warmKernel && input.action !== "status") {
      return {
        output:
          "Warm kernel is disabled. Set `ipynb.warmKernel: true` in opencode.json (or `OPENCODE_IPYNB_OPTIONS=\"{\\\"warmKernel\\\":true}\"` env) to enable it. ipynb_run still works without the warm kernel; this tool only reports on warm kernels.",
        metadata: { warmKernel: false, action: input.action }
      } as const
    }

    if (input.action === "status") {
      const stats = services.kernel.stats()
      return {
        output: [
          "## Warm kernel status",
          `- warmKernel: \`${pluginOpts.warmKernel}\``,
          `- liveKernels: ${stats.liveKernels}`,
          `- totalRequests: ${stats.totalRequests}`
        ].join("\n"),
        metadata: {
          warmKernel: pluginOpts.warmKernel,
          liveKernels: stats.liveKernels,
          totalRequests: stats.totalRequests
        }
      } as const
    }

    if (input.action === "list") {
      const items = services.kernel.list()
      return {
        output: formatList(items),
        metadata: { warmKernel: true, count: items.length, kernels: items }
      } as const
    }

    const filePath = input.filePath
    if (!filePath) {
      return {
        output: `Error: action='${input.action}' requires a filePath argument.`,
        metadata: { error: true, message: "filePath required" }
      } as const
    }
    const abs = yield* services.path.resolve(filePath)
    yield* services.path.ensureInsideWorktree(abs)
    yield* services.path.ensureIpynb(abs)
    if (input.action === "restart") {
      yield* services.kernel.restart(abs)
      return {
        output: `Restarted warm kernel for \`${filePath}\`.`,
        metadata: { warmKernel: true, action: "restart", filePath: abs }
      } as const
    }
    yield* services.kernel.shutdown(abs)
    return {
      output: `Shut down warm kernel for \`${filePath}\`.`,
      metadata: { warmKernel: true, action: "shutdown", filePath: abs }
    } as const
  })

export { run }

export const ipynbKernelTool = tool({
  description:
    "Inspect and manage the long-lived (warm) Python kernels used by ipynb_run when `ipynb.warmKernel: true` is set. Use 'status' to see whether the feature is on, 'list' to see the live kernels, 'restart' to kill and respawn a kernel for a given notebook, and 'shutdown' to release a kernel. When the warm kernel is disabled, this tool returns a clear message — the rest of the plugin is unaffected.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(run(services, input))
      return {
        title: `ipynb_kernel ${input.action}`,
        output: result.output,
        metadata: result.metadata
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `ipynb_kernel ${input.action} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
