import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { extractImportNames, isRelativeImport, isStdlibModule } from "../../src/utils/imports.js"
import { analyzeMissingPackages } from "../../src/services/NotebookInspectService.js"
import { NotebookSchema } from "../../src/domain/notebook.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"

const makeNotebook = (sources: ReadonlyArray<string>): NotebookRaw => {
  return NotebookSchema.parse({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" }
    },
    cells: sources.map((source) => ({
      cell_type: "code",
      metadata: {},
      execution_count: null,
      outputs: [],
      source
    }))
  }) as NotebookRaw
}

describe("isStdlibModule", () => {
  it("returns true for stdlib names", () => {
    expect(isStdlibModule("os")).toBe(true)
    expect(isStdlibModule("json")).toBe(true)
    expect(isStdlibModule("pathlib")).toBe(true)
    expect(isStdlibModule("collections")).toBe(true)
  })

  it("returns false for third-party names", () => {
    expect(isStdlibModule("numpy")).toBe(false)
    expect(isStdlibModule("pandas")).toBe(false)
    expect(isStdlibModule("sklearn")).toBe(false)
  })
})

describe("isRelativeImport", () => {
  it("returns true for dotted imports", () => {
    expect(isRelativeImport(".")).toBe(true)
    expect(isRelativeImport("..")).toBe(true)
    expect(isRelativeImport("./helpers")).toBe(true)
  })

  it("returns false for absolute imports", () => {
    expect(isRelativeImport("numpy")).toBe(false)
    expect(isRelativeImport("os")).toBe(false)
  })
})

describe("extractImportNames", () => {
  it("extracts a single 'import X' line", () => {
    expect(extractImportNames("import numpy as np")).toEqual(["numpy"])
  })

  it("extracts a 'from X import Y' line", () => {
    expect(extractImportNames("from pandas import DataFrame")).toEqual(["DataFrame"])
  })

  it("preserves a dotted name after 'from X import Y.Z'", () => {
    expect(extractImportNames("from sklearn.linear_model import LinearRegression")).toEqual(["LinearRegression"])
  })

  it("skips comment lines", () => {
    expect(extractImportNames("# import numpy\nimport pandas")).toEqual(["pandas"])
  })

  it("returns an empty array when no imports are present", () => {
    expect(extractImportNames("x = 1\nprint(x)")).toEqual([])
  })

  it("handles multiple imports in one cell", () => {
    const src = "import numpy\nimport pandas as pd\nfrom sklearn import svm"
    expect(extractImportNames(src).sort()).toEqual(["numpy", "pandas", "svm"])
  })
})

describe("analyzeMissingPackages", () => {
  const fakeCheckImport = (
    map: Record<string, boolean>
  ): ((pythonPath: string, module: string) => Effect.Effect<{ name: string; available: boolean; detail: string }, never>) =>
  (_p: string, module: string) =>
    Effect.succeed({
      name: module,
      available: map[module] ?? false,
      detail: map[module] ? "ok" : "ModuleNotFoundError"
    })

  it("returns no warnings when all imports are stdlib", async () => {
    const nb = makeNotebook(["import os\nimport json"])
    const warnings = await Effect.runPromise(
      analyzeMissingPackages(nb, { pythonPath: "python", checkImport: fakeCheckImport({}) })
    )
    expect(warnings).toEqual([])
  })

  it("flags a third-party import that is not importable", async () => {
    const nb = makeNotebook(["import totally_missing_package"])
    const warnings = await Effect.runPromise(
      analyzeMissingPackages(nb, { pythonPath: "python", checkImport: fakeCheckImport({}) })
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("totally_missing_package")
    expect(warnings[0]).toContain("not importable")
  })

  it("does not flag a third-party import that IS importable", async () => {
    const nb = makeNotebook(["import numpy"])
    const warnings = await Effect.runPromise(
      analyzeMissingPackages(nb, { pythonPath: "python", checkImport: fakeCheckImport({ numpy: true }) })
    )
    expect(warnings).toEqual([])
  })

  it("deduplicates imports across cells (one check per package name)", async () => {
    const nb = makeNotebook([
      "import numpy",
      "import numpy as np"
    ])
    let calls = 0
    const tracker = (_p: string, _m: string) => {
      calls++
      return Effect.succeed({ name: "numpy", available: true, detail: "ok" })
    }
    const warnings = await Effect.runPromise(
      analyzeMissingPackages(nb, { pythonPath: "python", checkImport: tracker })
    )
    expect(calls).toBe(1)
    expect(warnings).toEqual([])
  })

  it("reports the cell index where the missing import appears", async () => {
    const nb = makeNotebook([
      "import os",
      "import definitely_not_here"
    ])
    const warnings = await Effect.runPromise(
      analyzeMissingPackages(nb, { pythonPath: "python", checkImport: fakeCheckImport({}) })
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^cell 1:/)
  })

  it("ignores markdown and raw cells when scanning imports", async () => {
    const nb = NotebookSchema.parse({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
        language_info: { name: "python" }
      },
      cells: [
        { cell_type: "markdown", metadata: {}, source: "import numpy" },
        { cell_type: "raw", metadata: {}, source: "import pandas" }
      ]
    }) as NotebookRaw
    const warnings = await Effect.runPromise(
      analyzeMissingPackages(nb, { pythonPath: "python", checkImport: fakeCheckImport({}) })
    )
    expect(warnings).toEqual([])
  })

  it("runs import checks in parallel (4 concurrent) instead of serially", async () => {
    const sources = [
      "import alpha",
      "import bravo",
      "import charlie",
      "import delta",
      "import echo"
    ]
    const nb = makeNotebook(sources)
    const perCallMs = 200
    const slowCheck = (
      _p: string,
      _m: string
    ): Effect.Effect<{ name: string; available: boolean; detail: string }, never> =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ name: _m, available: true, detail: "ok" })
            }, perCallMs)
          })
      )
    const start = Date.now()
    const warnings = await Effect.runPromise(
      analyzeMissingPackages(nb, { pythonPath: "python", checkImport: slowCheck })
    )
    const elapsed = Date.now() - start
    // 5 checks * 200ms serially = 1000ms. With concurrency=4 the wall time
    // is ~400ms (one batch of 4 + one leftover). Give ourselves generous
    // slack (550ms) so the test is stable on slow CI.
    expect(warnings).toEqual([])
    expect(elapsed).toBeLessThan(550)
  })
})
