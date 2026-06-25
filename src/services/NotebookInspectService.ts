import { Context, Effect } from "effect"
import {
  NotebookNotFoundError,
  NotebookParseError,
  NotebookValidationError,
  PathOutsideWorktreeError
} from "../domain/errors.js"
import { NotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { PathService, type PathServiceShape } from "./PathService.js"
import { inspectCell, type CellInspection } from "../format/diagnostics.js"
import { formatNotebookDiagnostics } from "../format/outputs.js"
import { DEFAULT_MAX_INSPECT_CELLS } from "../utils/limits.js"
import { cellSource } from "../domain/notebook.js"
import { extractImportNames, isRelativeImport, isStdlibModule } from "../utils/imports.js"
import type { CellRaw } from "../domain/cell.js"
import type { NotebookRaw } from "../domain/notebook.js"

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

export class NotebookInspectService extends Context.Tag("@ipynb/NotebookInspectService")<
  NotebookInspectService,
  NotebookInspectServiceShape
>() {}

const LONG_SOURCE_LINE_THRESHOLD = 500

export interface AnalyzeMissingPackagesOptions {
  readonly pythonPath: string
  readonly checkImport: (
    pythonPath: string,
    module: string
  ) => Effect.Effect<{ name: string; available: boolean; detail: string }, never>
}

const MISSING_PACKAGES_CONCURRENCY = 4

export const analyzeMissingPackages = (
  notebook: NotebookRaw,
  options: AnalyzeMissingPackagesOptions
): Effect.Effect<ReadonlyArray<string>, never> =>
  Effect.gen(function* () {
    type Pending = { cellIndex: number; name: string }
    const seen = new Set<string>()
    const pending: Pending[] = []
    for (let i = 0; i < notebook.cells.length; i++) {
      const cell = notebook.cells[i]
      if (!cell || cell.cell_type !== "code") continue
      const source = cellSource(cell)
      const imports = extractImportNames(source)
      for (const name of imports) {
        if (isStdlibModule(name)) continue
        if (isRelativeImport(name)) continue
        if (seen.has(name)) continue
        seen.add(name)
        pending.push({ cellIndex: i, name })
      }
    }
    if (pending.length === 0) {
      return []
    }
    const checks = yield* Effect.all(
      pending.map((p) =>
        options
          .checkImport(options.pythonPath, p.name)
          .pipe(Effect.map((result) => ({ ...p, result })))
      ),
      { concurrency: MISSING_PACKAGES_CONCURRENCY }
    )
    const warnings: string[] = []
    for (const { cellIndex, name, result } of checks) {
      if (!result.available) {
        warnings.push(
          `cell ${cellIndex}: imports '${name}' which is not importable (${result.detail})`
        )
      }
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
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]
    if (!cell || cell.cell_type !== "code") continue
    const source = cellSource(cell)
    const lineCount = source.split("\n").length
    if (lineCount > LONG_SOURCE_LINE_THRESHOLD) {
      warnings.push(`cell ${i}: source is ${lineCount} lines (consider splitting)`)
    }
    for (const rule of NON_DETERMINISTIC_RULES) {
      if (source.includes(rule.pattern)) {
        warnings.push(`cell ${i}: ${rule.warning}`)
      }
    }
  }
  return warnings
}

export interface ExecutionOrderEntry {
  readonly cellIndex: number
  readonly executionCount: number
  readonly previousCount: number
}

export const analyzeExecutionOrder = (
  notebook: NotebookRaw
): ReadonlyArray<ExecutionOrderEntry> => {
  const outOfOrder: ExecutionOrderEntry[] = []
  let lastCount: number | null = null
  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]
    if (!cell || cell.cell_type !== "code") continue
    const ec = cell.execution_count
    if (ec === null || ec === undefined) {
      // When execution_count is null, treat as a "fresh run" boundary —
      // subsequent cells are evaluated against the new starting count, not the
      // last non-null count.
      lastCount = null
      continue
    }
    if (lastCount !== null && ec < lastCount) {
      outOfOrder.push({
        cellIndex: i,
        executionCount: ec,
        previousCount: lastCount
      })
    }
    lastCount = ec
  }
  return outOfOrder
}

const formatExecutionOrderWarning = (entry: ExecutionOrderEntry): string =>
  `cell ${entry.cellIndex}: execution_count ${entry.executionCount} < previous ${entry.previousCount} (notebook was not executed top-to-bottom)`

export const analyzeExecutionOrderWarnings = (
  notebook: NotebookRaw
): ReadonlyArray<string> => analyzeExecutionOrder(notebook).map(formatExecutionOrderWarning)

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
      const maxCells = options?.maxCells ?? DEFAULT_MAX_INSPECT_CELLS
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
  ) => Effect.Effect<{ name: string; available: boolean; detail: string }, never>
): Effect.Effect<ReadonlyArray<string>, never> =>
  analyzeMissingPackages(notebook, { pythonPath, checkImport })

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
    const out = includeOutputsSummary ? c.outputSummary : "-"
    lines.push(`| ${c.index} | ${c.cellType} | ${exec} | ${c.sourceLines} | ${out} | ${c.firstLine.replace(/\|/g, "\\|")} |`)
  }
  lines.push("")
  if (includeMetadata && Object.keys(summary.notebook.metadata).length > 0) {
    lines.push("## Metadata")
    lines.push("```json")
    lines.push(JSON.stringify(summary.notebook.metadata, null, 2))
    lines.push("```")
    lines.push("")
  }
  lines.push("## Reproducibility warnings")
  const warnings = summary.reproducibilityWarnings ?? []
  if (warnings.length === 0) {
    lines.push("(none)")
  } else {
    for (const w of warnings) {
      lines.push(`- ${w}`)
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
      lines.push(`- ${w}`)
    }
  }
  return lines.join("\n")
}

export type { CellInspection }
