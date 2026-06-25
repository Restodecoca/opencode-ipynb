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
  it("returns the imported name for 'from X import Y'", () => {
    expect(extractImportNames("from pandas import DataFrame")).toEqual(["DataFrame"])
  })

  it("returns each name for 'from X import A, B as C' (alias dropped)", () => {
    expect(extractImportNames("from foo import a, b as c")).toEqual(["a", "b"])
  })

  it("preserves a dotted name in 'from X import y.z'", () => {
    expect(extractImportNames("from x import y.z")).toEqual(["y.z"])
  })

  it("returns only the imported name (not the source module)", () => {
    expect(extractImportNames("from pandas import DataFrame")).not.toContain("pandas")
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
    expect(extractImportNames(src).sort()).toEqual(["numpy", "pandas", "svm"])
  })

  it("handles a mix of 'import' and 'from' on separate lines", () => {
    const src = "import os, sys\nfrom collections import OrderedDict"
    expect(extractImportNames(src).sort()).toEqual(["OrderedDict", "os", "sys"])
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
