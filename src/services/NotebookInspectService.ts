import { Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import type { NotebookFileServiceShape } from "./NotebookFileService.js"
import type { PathServiceShape } from "./PathService.js"
import { inspectCell, type CellInspection } from "../format/diagnostics.js"
import { formatNotebookDiagnostics } from "../format/outputs.js"
import {
  DEFAULT_MAX_INSPECT_CELLS,
  MAX_INSPECT_CELLS,
  MAX_ANALYSIS_WARNINGS,
  MAX_METADATA_CHARS,
  MAX_READ_RESPONSE_CHARS
} from "../utils/limits.js"
import { sanitizeInline, truncateMarkdown } from "../utils/markdown-safe.js"
import { cellSource } from "../domain/notebook.js"
import { extractImportNames, isRelativeImport, isStdlibModule } from "../utils/imports.js"
import type { CellRaw } from "../domain/cell.js"
import type { NotebookRaw } from "../domain/notebook.js"
import {
  analyzeExecutionOrder,
  type ExecutionOrderEntry
} from "../utils/execution-order.js"

export interface InspectSummary {
  readonly filePath: string
  readonly displayPath: string
  readonly notebook: NotebookRaw
  readonly cells: ReadonlyArray<CellInspection>
  readonly totalCells: number
  readonly truncated: boolean
  readonly includeMetadata: boolean
  readonly includeOutputsSummary: boolean
  readonly reproducibilityWarnings?: ReadonlyArray<string> | undefined
  readonly executionOrderWarnings?: ReadonlyArray<string> | undefined
  readonly missingPackageWarnings?: ReadonlyArray<string> | undefined
}

export interface InspectOptions {
  readonly includeMetadata: boolean
  readonly includeOutputsSummary: boolean
  readonly maxCells: number
}

export interface NotebookInspectServiceShape {
  readonly inspect: (
    filePath: string,
    options?: Partial<InspectOptions>
  ) => Effect.Effect<
    InspectSummary,
    | NotebookNotFoundError
    | NotebookParseError
    | NotebookValidationError
    | PathOutsideWorktreeError
  >
}

const LONG_SOURCE_LINE_THRESHOLD = 500

export interface AnalyzeMissingPackagesOptions {
  readonly pythonPath: string
  readonly checkImport: (
    pythonPath: string,
    module: string
  ) => Effect.Effect<{ name: string; available: boolean; detail: string }, never>
  readonly checkImports?: (
    pythonPath: string,
    modules: ReadonlyArray<string>,
    signal?: AbortSignal
  ) => Effect.Effect<
    ReadonlyArray<{ name: string; available: boolean; detail: string }>,
    never
  >
  readonly signal?: AbortSignal | undefined
}

const MISSING_PACKAGES_CONCURRENCY = 4
export const MAX_MISSING_PACKAGE_CHECKS = 500

export const analyzeMissingPackages = (
  notebook: NotebookRaw,
  options: AnalyzeMissingPackagesOptions
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    if (options.signal?.aborted) return []
    type Pending = { cellIndex: number; name: string }
    const seen = new Set<string>()
    const pending: Pending[] = []
    let skipped = 0
    for (let i = 0; i < notebook.cells.length; i++) {
      const cell = notebook.cells[i]
      if (!cell || cell.cell_type !== "code") continue
      const source = cellSource(cell)
      const imports = extractImportNames(source)
      for (const name of imports) {
        if (isStdlibModule(name)) continue
        if (isRelativeImport(name)) continue
        const root = name.split(".")[0]!
        if (seen.has(root)) continue
        seen.add(root)
        if (pending.length >= MAX_MISSING_PACKAGE_CHECKS) {
          skipped++
          continue
        }
        pending.push({ cellIndex: i, name: root })
      }
    }
    if (options.signal?.aborted) return []
    if (pending.length === 0) {
      return skipped > 0
        ? [
            `imports beyond the first ${MAX_MISSING_PACKAGE_CHECKS} were not checked`
          ]
        : []
    }
    const checks = yield* (options.checkImports === undefined
      ? Effect.all(
          pending.map((p) =>
            options
              .checkImport(options.pythonPath, p.name)
              .pipe(Effect.map((result) => ({ ...p, result })))
          ),
          { concurrency: MISSING_PACKAGES_CONCURRENCY }
        )
      : options
          .checkImports(
            options.pythonPath,
            pending.map((p) => p.name),
            options.signal
          )
          .pipe(
            Effect.map((results) =>
              pending.map((p, index) => ({
                ...p,
                result:
                  results[index] ??
                  ({
                    name: p.name,
                    available: false,
                    detail: "batch check returned no result"
                  } as const)
              }))
            )
          ))
    if (options.signal?.aborted) return []
    const warnings: string[] = []
    for (const { cellIndex, name, result } of checks) {
      if (result.detail === "aborted" || result.detail === "not checked") {
        continue
      }
      if (!result.available) {
        warnings.push(
          `cell ${cellIndex}: imports '${name}' which is not importable (${result.detail})`
        )
      }
    }
    if (skipped > 0) {
      warnings.push(
        `imports beyond the first ${MAX_MISSING_PACKAGE_CHECKS} were not checked`
      )
    }
    return warnings
  })

interface NonDeterministicRule {
  readonly pattern: string
  readonly warning: string
}

const NON_DETERMINISTIC_RULES: ReadonlyArray<NonDeterministicRule> = [
  {
    pattern: "random.seed(",
    warning:
      "random.seed is called inside the notebook (deterministic only when re-executed in order)"
  },
  {
    pattern: "np.random",
    warning: "uses np.random without an explicit seed"
  },
  {
    pattern: "numpy.random",
    warning: "uses numpy.random without an explicit seed"
  },
  {
    pattern: "time.time(",
    warning: "depends on wall-clock time"
  },
  {
    pattern: "time.sleep(",
    warning: "depends on wall-clock time"
  },
  {
    pattern: "datetime.now(",
    warning: "depends on wall-clock time"
  },
  {
    pattern: "datetime.today(",
    warning: "depends on wall-clock time"
  },
  {
    pattern: "os.environ[",
    warning: "reads environment variables (output may vary across machines)"
  },
  {
    pattern: "os.getenv(",
    warning: "reads environment variables (output may vary across machines)"
  }
]

export const analyzeReproducibility = (notebook: NotebookRaw): ReadonlyArray<string> => {
  const warnings: string[] = []
  let suppressed = 0
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]
    if (!cell || cell.cell_type !== "code") continue
    const source = cellSource(cell)
    const lineCount = source.split("\n").length
    if (lineCount > LONG_SOURCE_LINE_THRESHOLD) {
      if (warnings.length < MAX_ANALYSIS_WARNINGS) {
        warnings.push(`cell ${i}: source is ${lineCount} lines (consider splitting)`)
      } else {
        suppressed++
      }
    }
    const numpySeeded = /(?:np|numpy)\.random\.seed\s*\(/.test(source)
    for (const rule of NON_DETERMINISTIC_RULES) {
      if (!source.includes(rule.pattern)) continue
      if (
        rule.pattern === "random.seed(" &&
        /(?:np|numpy)\.random\.seed\s*\(/.test(source)
      ) {
        continue
      }
      if (
        (rule.pattern === "np.random" || rule.pattern === "numpy.random") &&
        numpySeeded
      ) {
        continue
      }
      if (warnings.length < MAX_ANALYSIS_WARNINGS) {
        warnings.push(`cell ${i}: ${rule.warning}`)
      } else {
        suppressed++
      }
    }
  }
  if (suppressed > 0) {
    warnings.push(`... ${suppressed} more warnings suppressed`)
  }
  return warnings
}

const formatExecutionOrderWarning = (entry: ExecutionOrderEntry): string =>
  `cell ${entry.cellIndex}: execution_count ${entry.executionCount} < previous ${entry.previousCount} (notebook was not executed top-to-bottom)`

export const analyzeExecutionOrderWarnings = (
  notebook: NotebookRaw
): ReadonlyArray<string> => {
  const entries = analyzeExecutionOrder(notebook)
  const out = entries
    .slice(0, MAX_ANALYSIS_WARNINGS)
    .map(formatExecutionOrderWarning)
  if (entries.length > MAX_ANALYSIS_WARNINGS) {
    out.push(`... ${entries.length - MAX_ANALYSIS_WARNINGS} more warnings suppressed`)
  }
  return out
}

const build = (
  pathSvc: PathServiceShape,
  fileSvc: NotebookFileServiceShape
): NotebookInspectServiceShape => ({
  inspect: (filePath, options) =>
    Effect.gen(function* () {
      const abs = yield* pathSvc.resolve(filePath)
      yield* pathSvc.ensureInsideWorktree(abs)
      yield* pathSvc.ensureExists(abs)
      const notebook = yield* fileSvc.read(abs)
      const maxCells = Math.min(
        options?.maxCells ?? DEFAULT_MAX_INSPECT_CELLS,
        MAX_INSPECT_CELLS
      )
      const includeMetadata = options?.includeMetadata ?? false
      const includeOutputsSummary = options?.includeOutputsSummary ?? true
      const limitedCells = notebook.cells.slice(0, maxCells)
      const cells: CellInspection[] = limitedCells.map((c: CellRaw, i: number) => inspectCell(c, i))
      const displayPath = pathSvc.toDisplay(abs)
      const reproducibilityWarnings = analyzeReproducibility(notebook)
      const executionOrderWarnings = analyzeExecutionOrderWarnings(notebook)
      return {
        filePath: abs,
        displayPath,
        notebook,
        cells,
        totalCells: notebook.cells.length,
        truncated: notebook.cells.length > maxCells,
        includeMetadata,
        includeOutputsSummary,
        reproducibilityWarnings,
        executionOrderWarnings
      }
    })
})

/**
 * Standalone Effect: detect imports that the user's Python cannot resolve.
 * Pass the result of `pythonSvc.probe()` for `pythonPath`; the analyzer skips
 * itself when the probe says "none" (no Python on PATH).
 */
export const analyzeMissingPackagesForPython = (
  notebook: NotebookRaw,
  pythonPath: string,
  checkImport: (
    pythonPath: string,
    module: string
  ) => Effect.Effect<{ name: string; available: boolean; detail: string }, never>,
  checkImports?: (
    pythonPath: string,
    modules: ReadonlyArray<string>,
    signal?: AbortSignal
  ) => Effect.Effect<
    ReadonlyArray<{ name: string; available: boolean; detail: string }>,
    never
  >,
  signal?: AbortSignal
): Effect.Effect<ReadonlyArray<string>, never> =>
  analyzeMissingPackages(notebook, {
    pythonPath,
    checkImport,
    ...(checkImports === undefined ? {} : { checkImports }),
    ...(signal === undefined ? {} : { signal })
  })

export { build as makeInspectImpl }

export const formatInspectSummary = (summary: InspectSummary): string => {
  const includeMetadata = summary.includeMetadata ?? false
  const includeOutputsSummary = summary.includeOutputsSummary ?? true
  const lines: string[] = []
  lines.push(formatNotebookDiagnostics(summary.notebook, summary.displayPath))
  lines.push(`cells shown: ${summary.cells.length} / ${summary.totalCells}${summary.truncated ? " (truncated)" : ""}`)
  lines.push("")
  lines.push("| index | type | exec | lines | output summary | first line |")
  lines.push("| --- | --- | --- | --- | --- | --- |")
  for (const c of summary.cells) {
    const exec = c.executionCount === null ? "not run" : String(c.executionCount)
    const out = includeOutputsSummary
      ? sanitizeInline(c.outputSummary).replace(/\|/g, "\\|")
      : "-"
    lines.push(
      `| ${c.index} | ${c.cellType} | ${exec} | ${c.sourceLines} | ${out} | ${sanitizeInline(c.firstLine).replace(/\|/g, "\\|")} |`
    )
  }
  lines.push("")
  if (includeMetadata && Object.keys(summary.notebook.metadata).length > 0) {
    lines.push("## Metadata")
    const metadataJson = JSON.stringify(summary.notebook.metadata, null, 2)
    const metadataText =
      metadataJson.length > MAX_METADATA_CHARS
        ? `${metadataJson.slice(0, MAX_METADATA_CHARS)}\n... (metadata truncated)`
        : metadataJson
    const fence = "`".repeat(
      Math.max(3, ...((metadataText.match(/`+/g) ?? []).map((r) => r.length + 1)))
    )
    lines.push(`${fence}json`)
    lines.push(metadataText)
    lines.push(fence)
    lines.push("")
  }
  lines.push("## Reproducibility warnings")
  const warnings = summary.reproducibilityWarnings ?? []
  if (warnings.length === 0) {
    lines.push("(none)")
  } else {
    for (const w of warnings) {
      lines.push(`- ${sanitizeInline(w)}`)
    }
  }
  lines.push("")
  lines.push("## Execution order")
  const orderWarnings = summary.executionOrderWarnings ?? []
  if (orderWarnings.length === 0) {
    lines.push("(monotonic, top-to-bottom)")
  } else {
    for (const w of orderWarnings) {
      lines.push(`- ${w}`)
    }
  }
  lines.push("")
  lines.push("## Missing packages")
  const missing = summary.missingPackageWarnings ?? []
  if (missing.length === 0) {
    lines.push("(none — or not requested)")
  } else {
    for (const w of missing) {
      lines.push(`- ${sanitizeInline(w)}`)
    }
  }
  return truncateMarkdown(
    lines.join("\n"),
    MAX_READ_RESPONSE_CHARS,
    "\n... (truncated: hard response limit reached)"
  )
}

export type { CellInspection }
