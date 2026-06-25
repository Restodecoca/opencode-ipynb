import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import { errorToMessage } from "../domain/errors.js"

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
      const doctor = await Effect.runPromise(services.python.doctor())
      const lines: string[] = []
      lines.push("# opencode-ipynb doctor")
      lines.push("")
      lines.push("## Python interpreter")
      if (doctor.selected) {
        lines.push(
          `- selected: \`${doctor.selected.pythonPath}\` (${doctor.selected.version}) — source: ${doctor.selected.from}`
        )
      } else {
        lines.push("- selected: (none)")
      }
      if (doctor.candidates.length > 1) {
        lines.push("- other candidates:")
        for (const c of doctor.candidates.slice(1)) {
          lines.push(`  - \`${c.pythonPath}\` (${c.version}) — ${c.from}`)
        }
      }
      lines.push("")
      lines.push("## Helper script")
      lines.push(doctor.helperPath ? `- \`${doctor.helperPath}\`` : "- (not found)")
      lines.push("")
      lines.push("## Jupyter dependencies")
      for (const d of doctor.dependencies) {
        const mark = d.available ? "[ok]" : "[missing]"
        lines.push(`- ${mark} ${d.name} — ${d.detail}`)
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
        output: lines.join("\n"),
        metadata: {
          selected: doctor.selected,
          helperPath: doctor.helperPath,
          preferUv: doctor.preferUv,
          missing: doctor.dependencies.filter((d) => !d.available).map((d) => d.name)
        }
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: "ipynb_doctor (error)",
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
