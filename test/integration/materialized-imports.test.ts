import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildNotebookVirtualDocument } from "../../src/lsp.js"
import { materializeVirtualDocument } from "../../src/virtual-materialize.js"

const pyright =
  spawnSync("pyright", ["--version"], { encoding: "utf8" }).status === 0
    ? "pyright"
    : undefined

const describeIf = (cond: boolean, name: string, fn: () => void): void => {
  if (cond) describe(name, fn)
  else describe.skip(name, fn)
}

describeIf(pyright !== undefined, "materialized sidecar > sibling imports", () => {
  it("analyzes the sidecar next to the notebook so sibling modules resolve", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-sidecar-import-"))
    const notebooks = path.join(dir, "notebooks")
    fs.mkdirSync(notebooks)
    const file = path.join(notebooks, "eda.ipynb")
    fs.writeFileSync(
      path.join(notebooks, "helpers.py"),
      "def add(a: int, b: int) -> int:\n    return a + b\n"
    )
    const document = buildNotebookVirtualDocument(
      {
        metadata: {
          kernelspec: { name: "python3", language: "python" },
          language_info: { name: "python", file_extension: ".py" }
        },
        cells: [
          {
            cell_type: "code",
            source: "from helpers import add\nx: int = add(1, 2)"
          }
        ]
      },
      { filePath: file }
    )
    try {
      const materialized = await materializeVirtualDocument(document, dir)
      expect(path.dirname(materialized.path)).toBe(notebooks)
      const result = spawnSync(
        pyright!,
        ["--outputjson", materialized.path],
        { cwd: dir, encoding: "utf8" }
      )
      const parsed = JSON.parse(result.stdout) as {
        summary?: { filesAnalyzed?: number }
        generalDiagnostics?: Array<{ message: string }>
      }
      expect(parsed.summary?.filesAnalyzed).toBe(1)
      expect(
        (parsed.generalDiagnostics ?? []).some((d) =>
          /helpers.*(unknown|not defined)/i.test(d.message)
        )
      ).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
  it("turns IPython help markers into valid Python before materializing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-sidecar-help-"))
    const file = path.join(dir, "help.ipynb")
    const document = buildNotebookVirtualDocument(
      {
        metadata: {},
        cells: [
          { cell_type: "code", source: "df = None\n?df" },
          { cell_type: "code", source: "??df" },
          { cell_type: "code", source: "df?" },
          {
            cell_type: "code",
            source: "for i in range(2):\n    %time print(i)"
          },
          { cell_type: "code", source: "if True:\n    ?df" },
          { cell_type: "code", source: "files: list[str] = !ls" },
          { cell_type: "code", source: "other: list[str] | None = !ls" },
          { cell_type: "code", source: "d['k'] = !ls" },
          {
            cell_type: "code",
            source: "%%bash\nfor i in 1 2; do\n  echo $i\ndone"
          }
        ]
      },
      { filePath: file }
    )
    try {
      const materialized = await materializeVirtualDocument(document, dir)
      const result = spawnSync(pyright!, ["--outputjson", materialized.path], {
        cwd: dir,
        encoding: "utf8"
      })
      const parsed = JSON.parse(result.stdout) as {
        summary?: { filesAnalyzed?: number }
        generalDiagnostics?: Array<{ message: string }>
      }
      expect(parsed.summary?.filesAnalyzed).toBe(1)
      expect(parsed.generalDiagnostics ?? []).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

})
