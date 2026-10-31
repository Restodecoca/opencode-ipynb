import { describe, expect, it } from "bun:test"
import { extractImportNames, isRelativeImport, isStdlibModule } from "../../src/utils/imports.js"

describe("extractImportNames > multi-import lines", () => {
  it("captures every module in 'import X, Y'", () => {
    expect(extractImportNames("import os, sys")).toEqual(["os", "sys"])
  })

  it("captures every module in 'import X, Y, Z'", () => {
    expect(extractImportNames("import a, b, c")).toEqual(["a", "b", "c"])
  })

  it("drops the alias from 'import X as A'", () => {
    expect(extractImportNames("import numpy as np")).toEqual(["numpy"])
  })

  it("drops the alias from each piece of 'import X as A, Y as B'", () => {
    expect(extractImportNames("import numpy as np, pandas as pd")).toEqual(["numpy", "pandas"])
  })

  it("preserves a dotted name in 'import x.y.z'", () => {
    expect(extractImportNames("import x.y.z")).toEqual(["x.y.z"])
  })

  it("preserves a dotted name and drops the alias in 'import x.y.z as w'", () => {
    expect(extractImportNames("import x.y.z as w")).toEqual(["x.y.z"])
  })
})

describe("extractImportNames > from-import lines", () => {
  it("returns the source module for 'from X import Y'", () => {
    expect(extractImportNames("from pandas import DataFrame")).toEqual(["pandas"])
  })

  it("returns one source module for 'from X import A, B as C'", () => {
    expect(extractImportNames("from foo import a, b as c")).toEqual(["foo"])
  })

  it("returns the source module for a dotted from-import", () => {
    expect(extractImportNames("from x.y import z")).toEqual(["x"])
  })

  it("returns the source package, not the imported symbol", () => {
    expect(extractImportNames("from sklearn.datasets import load_iris")).toEqual([
      "sklearn"
    ])
  })
})

describe("extractImportNames > edge cases", () => {
  it("returns an empty array for source with no imports", () => {
    expect(extractImportNames("x = 1\nprint(x)")).toEqual([])
  })

  it("skips comment-only lines", () => {
    expect(extractImportNames("# import numpy\nimport pandas")).toEqual(["pandas"])
  })

  it("handles multiple import lines in one cell", () => {
    const src = "import numpy\nimport pandas as pd\nfrom sklearn import svm"
    expect(extractImportNames(src).sort()).toEqual(["numpy", "pandas", "sklearn"])
  })

  it("handles comments, parentheses, relative imports, and __future__", () => {
    const src = [
      "import numpy as np  # comment",
      "from pandas import (",
      "  DataFrame,",
      "  Series",
      ")",
      "from .local import thing",
      "from __future__ import annotations"
    ].join("\n")
    expect(extractImportNames(src).sort()).toEqual(["numpy", "pandas"])
  })

  it("handles a mix of 'import' and 'from' on separate lines", () => {
    const src = "import os, sys\nfrom collections import OrderedDict"
    expect(extractImportNames(src).sort()).toEqual(["collections", "os", "sys"])
  })
})


describe("extractImportNames > string bodies and statements", () => {
  it("ignores import lines inside triple-quoted strings", () => {
    const src = [
      'doc = """',
      "import fake_package",
      "from another_fake import thing",
      '"""',
      "import real_package"
    ].join("\n")
    expect(extractImportNames(src)).toEqual(["real_package"])
  })

  it("stops at a semicolon-separated statement", () => {
    expect(extractImportNames("import os; import fake")).toEqual(["os"])
  })
})


describe("extractImportNames > linear parsing", () => {
  it("handles 200k blank lines without quadratic scanning", () => {
    const started = Date.now()
    expect(extractImportNames("\n".repeat(200_000))).toEqual([])
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it("handles thousands of unclosed parenthesized imports", () => {
    const started = Date.now()
    const result = extractImportNames("from a import (\n".repeat(20_000))
    expect(result).toEqual(["a"])
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe("isRelativeImport", () => {
  it("returns true for dotted names", () => {
    expect(isRelativeImport(".")).toBe(true)
    expect(isRelativeImport("..")).toBe(true)
    expect(isRelativeImport("./helpers")).toBe(true)
  })

  it("returns false for absolute names", () => {
    expect(isRelativeImport("numpy")).toBe(false)
    expect(isRelativeImport("os")).toBe(false)
  })
})

describe("isStdlibModule", () => {
  it("returns true for stdlib names", () => {
    expect(isStdlibModule("os")).toBe(true)
    expect(isStdlibModule("json")).toBe(true)
  })

  it("returns false for third-party names", () => {
    expect(isStdlibModule("numpy")).toBe(false)
  })
})

describe("extractImportNames > comment edge cases", () => {

  it("ignores triple quotes inside comments and comment line continuations", () => {
    expect(extractImportNames('# use """ in docs\nimport real\nx = """doc"""')).toEqual(["real"])
    expect(extractImportNames('# trailing \\\nimport real')).toEqual(["real"])
  })
})
