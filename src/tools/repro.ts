import { z } from "zod"
import { tool } from "@opencode-ai/plugin"
import { Cause, Effect } from "effect"
import type { ToolContext } from "@opencode-ai/plugin"
import { buildServices } from "../services/index.js"
import {
  errorToMessage,
  type NotebookNotFoundError,
  type NotebookNotImplementedError,
  type NotebookParseError,
  type NotebookValidationError,
  type PathOutsideWorktreeError,
  type PythonRunnerError
} from "../domain/errors.js"
import {
  analyzeMissingPackagesForPython,
  analyzeReproducibility
} from "../services/NotebookInspectService.js"
import { cellSource } from "../domain/notebook.js"
import type { NotebookRaw } from "../domain/notebook.js"
import type { EnvReport } from "../domain/execution.js"

const args = {
  filePath: z.string().describe("Absolute or relative path to the .ipynb file")
}

const FS_PATTERNS: ReadonlyArray<{ readonly pattern: string; readonly regex: RegExp }> = [
  { pattern: "open(", regex: /open\(/ },
  { pattern: "read_csv", regex: /read_csv/ },
  { pattern: "read_json", regex: /read_json/ },
  { pattern: "read_parquet", regex: /read_parquet/ },
  { pattern: "read_excel", regex: /read_excel/ },
  { pattern: "read_table", regex: /read_table/ },
  { pattern: "pd.read_*", regex: /pd\.read_\w+/ },
  { pattern: "np.load", regex: /np\.load/ },
  { pattern: "pickle.load", regex: /pickle\.load/ }
]

const SEED_PATTERNS: ReadonlyArray<{ readonly name: string; readonly regex: RegExp }> = [
  { name: "random.seed", regex: /(?<!\.)random\.seed\(/ },
  { name: "np.random.seed", regex: /np\.random\.seed\(/ },
  { name: "torch.manual_seed", regex: /torch\.manual_seed\(/ },
  { name: "tf.random.set_seed", regex: /tf\.random\.set_seed\(/ }
]

export const detectFilesystemReads = (
  notebook: NotebookRaw
): ReadonlyArray<{ readonly cellIndex: number; readonly pattern: string }> => {
  const hits: Array<{ readonly cellIndex: number; readonly pattern: string }> = []
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]
    if (!cell || cell.cell_type !== "code") continue
    const source = cellSource(cell)
    for (const { pattern, regex } of FS_PATTERNS) {
      if (regex.test(source)) {
        hits.push({ cellIndex: i, pattern })
      }
    }
  }
  return hits
}

export const detectRandomSeeds = (
  notebook: NotebookRaw
): ReadonlyArray<{ readonly cellIndex: number; readonly name: string }> => {
  const hits: Array<{ readonly cellIndex: number; readonly name: string }> = []
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]
    if (!cell || cell.cell_type !== "code") continue
    const source = cellSource(cell)
    for (const { name, regex } of SEED_PATTERNS) {
      if (regex.test(source)) {
        hits.push({ cellIndex: i, name })
      }
    }
  }
  return hits
}

const formatEnvSection = (env: EnvReport | undefined): string[] => {
  if (!env) {
    return ["- Python not available"]
  }
  return [
    `- version: \`${env.pythonVersion}\``,
    `- executable: \`${env.pythonExecutable}\``,
    `- platform: \`${env.platform}\``
  ]
}

const formatKernelSection = (env: EnvReport | undefined): string[] => {
  if (!env) {
    return [
      "- name: (unknown — Python not available)",
      "- display_name: (unknown)",
      "- language: (unknown)"
    ]
  }
  return [
    `- name: ${env.kernelName ?? "(missing from kernelspec)"}`,
    `- display_name: ${env.kernelDisplayName ?? "(missing from kernelspec)"}`,
    `- language: ${env.language ?? "(missing from language_info)"}`
  ]
}

const formatPipFreeze = (env: EnvReport | undefined): string => {
  if (!env) {
    return "Python not available"
  }
  if (env.pipFreeze.length === 0) {
    return "(no packages reported by `pip freeze --local`)"
  }
  const sorted = [...env.pipFreeze].sort((a, b) => a.localeCompare(b))
  const top = sorted.slice(0, 50)
  const lines = top.map((p) => p)
  if (sorted.length > 50) {
    lines.push(`... (${sorted.length - 50} more, use ipynb_read or ipynb_run for full output)`)
  }
  return ["```", ...lines, "```"].join("\n")
}

const formatWarnings = (
  reproWarnings: ReadonlyArray<string>,
  missingPackageWarnings: ReadonlyArray<string>
): string => {
  const all = [...reproWarnings, ...missingPackageWarnings]
  if (all.length === 0) {
    return "(none)"
  }
  return all.map((w) => `- ${w}`).join("\n")
}

const formatFilesystemReads = (
  hits: ReadonlyArray<{ readonly cellIndex: number; readonly pattern: string }>
): string => {
  if (hits.length === 0) {
    return "(none)"
  }
  return hits.map((h) => `- cell ${h.cellIndex}: reads ${h.pattern}`).join("\n")
}

const formatSeeds = (
  hits: ReadonlyArray<{ readonly cellIndex: number; readonly name: string }>
): string => {
  if (hits.length === 0) {
    return "(none)"
  }
  return hits.map((h) => `- cell ${h.cellIndex}: sets ${h.name}`).join("\n")
}

const run = (
  services: ReturnType<typeof buildServices>,
  input: z.infer<z.ZodObject<typeof args>>
): Effect.Effect<
  {
    readonly output: string
    readonly metadata: {
      readonly filePath: string
      readonly displayPath: string
      readonly envAvailable: boolean
      readonly envError: string | undefined
      readonly pipFreezeCount: number
      readonly reproWarningCount: number
      readonly missingPackageWarningCount: number
      readonly filesystemReadCount: number
      readonly seedCount: number
    }
  },
  | NotebookNotFoundError
  | NotebookParseError
  | NotebookValidationError
  | PathOutsideWorktreeError
  | NotebookNotImplementedError
  | PythonRunnerError
> =>
  Effect.gen(function* () {
    const abs = yield* services.path.resolve(input.filePath)
    yield* services.path.ensureInsideWorktree(abs)
    yield* services.path.ensureExists(abs)
    const notebook = yield* services.file.read(abs)
    const displayPath = services.path.toDisplay(abs)

    let env: EnvReport | undefined
    let envError: string | undefined
    const probe = yield* services.python.probe()
    if (probe.from !== "none") {
      const exit = yield* Effect.exit(services.execution.reportEnv(abs))
      if (exit._tag === "Success") {
        env = exit.value
      } else {
        const failureOpt = Cause.failureOption(exit.cause)
        if (failureOpt._tag === "Some") {
          envError = errorToMessage(failureOpt.value)
        } else {
          envError = "python helper failed without a structured error"
        }
      }
    }

    const reproWarnings = analyzeReproducibility(notebook)
    let missingPackageWarnings: ReadonlyArray<string> = []
    if (env) {
      missingPackageWarnings = yield* analyzeMissingPackagesForPython(
        notebook,
        env.pythonExecutable,
        services.python.checkImport
      )
    }

    const fsHits = detectFilesystemReads(notebook)
    const seedHits = detectRandomSeeds(notebook)

    const lines: string[] = []
    lines.push(`# Reproducibility report — ${displayPath}`)
    lines.push("")
    lines.push("## Kernel")
    lines.push(...formatKernelSection(env))
    lines.push("")
    lines.push("## Python")
    lines.push(...formatEnvSection(env))
    lines.push("")
    lines.push("## Installed packages")
    lines.push(formatPipFreeze(env))
    lines.push("")
    lines.push("## Reproducibility warnings")
    lines.push(formatWarnings(reproWarnings, missingPackageWarnings))
    lines.push("")
    lines.push("## Filesystem reads")
    lines.push(formatFilesystemReads(fsHits))
    lines.push("")
    lines.push("## Random seeds")
    lines.push(formatSeeds(seedHits))
    lines.push("")

    return {
      output: lines.join("\n"),
      metadata: {
        filePath: abs,
        displayPath,
        envAvailable: env !== undefined,
        envError,
        pipFreezeCount: env?.pipFreeze.length ?? 0,
        reproWarningCount: reproWarnings.length,
        missingPackageWarningCount: missingPackageWarnings.length,
        filesystemReadCount: fsHits.length,
        seedCount: seedHits.length
      }
    }
  })

export { run as runRepro }

export const ipynbReproTool = tool({
  description:
    "Reproducibility report for a Jupyter Notebook: kernel + language (from kernelspec / language_info), Python interpreter version + executable + platform, top 50 lines of `pip freeze --local`, and a static analysis of the notebook for things that hurt reproducibility (long source, non-deterministic patterns, missing packages, filesystem reads, random seeds). Does NOT execute notebook cells. Falls back to a partial report (warnings only) if Python is not on PATH.",
  args,
  async execute(input: z.infer<z.ZodObject<typeof args>>, context: ToolContext) {
    const services = buildServices(context)
    try {
      const result = await Effect.runPromise(run(services, input))
      return {
        title: `ipynb_repro ${input.filePath}`,
        output: result.output,
        metadata: result.metadata
      }
    } catch (err) {
      const message = errorToMessage(err)
      return {
        title: `ipynb_repro ${input.filePath} (error)`,
        output: `Error: ${message}`,
        metadata: { error: true, message }
      }
    }
  }
})
