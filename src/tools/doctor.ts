import { z } from "zod"
import { Effect } from "effect"
import { rethrowPermissionDenied, runToolEffect, tool } from "../tool.js"
import type { ToolContext } from "../tool.js"
import { buildServices } from "../services/index.js"
import { errorToMessage, PermissionDeniedError } from "../domain/errors.js"
import { pythonInterpreterResources } from "../services/PythonService.js"
import {
  sanitizeInline,
  truncateMarkdown
} from "../utils/markdown-safe.js"
import { MAX_READ_RESPONSE_CHARS } from "../utils/limits.js"

const args = {
  includeSuggestions: z
    .boolean()
    .optional()
    .default(true)
    .describe("If true, include actionable suggestions (e.g. how to install missing deps).")
}

export const ipynbDoctorTool = tool({
  description:
    "Diagnose the opencode-ipynb environment: which Python interpreter was found, where the helper lives, which Jupyter dependencies are available, and how to fix anything that is missing. Never installs anything.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      if (services.pythonPathError !== undefined) {
        const message = `Invalid pythonPath: ${services.pythonPathError}`
        return {
          title: "ipynb_doctor (error)",
          output: `Error: ${message}`,
          metadata: { error: true, message }
        }
      }
      const patterns = [...pythonInterpreterResources(services.pythonPath)]
      try {
        if (patterns.length > 0) {
          await context.ask({
            permission: "shell",
            patterns,
            always: patterns,
            metadata: { action: "ipynb_doctor" }
          })
        }
      } catch (err) {
        throw new PermissionDeniedError({
          message: err instanceof Error ? err.message : String(err),
          action: "shell",
          cause: err
        })
      }
      const resources = pythonInterpreterResources(services.pythonPath)
      const doctor = await runToolEffect(
        services.python.doctor((selected) =>
          resources.includes(selected.pythonPath)
            ? Effect.void
            : services.permission.ask({
                kind: "shell",
                action: "ipynb_doctor_python",
                patterns: [selected.pythonPath],
                always: [selected.pythonPath],
                metadata: { pythonPath: selected.pythonPath }
              })
        )
      )
      const lines: string[] = []
      lines.push("# opencode-ipynb doctor")
      lines.push("")
      lines.push("## Python interpreter")
      if (doctor.selected) {
        lines.push(
          `- selected: \`${sanitizeInline(doctor.selected.pythonPath)}\` (${sanitizeInline(doctor.selected.version)}) — source: ${sanitizeInline(doctor.selected.from)}`
        )
      } else {
        lines.push("- selected: (none)")
      }
      if (doctor.candidates.length > 1) {
        lines.push("- other candidates:")
        for (const c of doctor.candidates.slice(1)) {
          lines.push(
            `  - \`${sanitizeInline(c.pythonPath)}\` (${sanitizeInline(c.version)}) — ${sanitizeInline(c.from)}`
          )
        }
      }
      lines.push("")
      lines.push("## Helper script")
      lines.push(
        doctor.helperPath
          ? `- \`${sanitizeInline(doctor.helperPath)}\``
          : "- (not found)"
      )
      lines.push("")
      lines.push("## Jupyter dependencies")
      for (const d of doctor.dependencies) {
        const mark = d.available ? "[ok]" : "[missing]"
        lines.push(
          `- ${mark} ${sanitizeInline(d.name)} — ${sanitizeInline(d.detail)}`
        )
      }
      lines.push("")
      if (input.includeSuggestions !== false) {
        lines.push("## Suggestions")
        for (const s of doctor.suggestions) {
          lines.push(`- ${s}`)
        }
      }
      return {
        title: "ipynb_doctor",
        output: truncateMarkdown(
          lines.join("\n"),
          MAX_READ_RESPONSE_CHARS,
          "\n... (truncated: hard response limit reached)"
        ),
        metadata: {
          selected:
            doctor.selected === undefined
              ? undefined
              : {
                  ...doctor.selected,
                  pythonPath: sanitizeInline(doctor.selected.pythonPath).slice(0, 500),
                  version: sanitizeInline(doctor.selected.version).slice(0, 200),
                  executable: sanitizeInline(doctor.selected.executable).slice(0, 500)
                },
          helperPath:
            doctor.helperPath === undefined
              ? undefined
              : sanitizeInline(doctor.helperPath).slice(0, 500),
          preferUv: doctor.preferUv,
          missing: doctor.dependencies.filter((d) => !d.available).map((d) => d.name)
        }
      }
    } catch (err) {
      rethrowPermissionDenied(err)
      const message = errorToMessage(err)
      return {
        title: "ipynb_doctor (error)",
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
