import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { loadNotebookDocument } from "../../src/load-document.js"
import { parsePluginOptions } from "../../src/plugin-options.js"

const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: "x = 1"
    }
  ]
}

const context = (dir: string, options: unknown) => ({
  directory: dir,
  worktree: dir,
  options: parsePluginOptions(options)
})

describe("loadNotebookDocument pythonPath", () => {
  it("keeps a valid configured interpreter", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-loaddoc-ok-"))
    const file = path.join(dir, "n.ipynb")
    const python = path.join(dir, "fake-python")
    fs.writeFileSync(file, JSON.stringify(notebook))
    fs.writeFileSync(python, "")
    fs.chmodSync(python, 0o755)
    try {
      const doc = await loadNotebookDocument(
        context(dir, { pythonPath: python }),
        file
      )
      expect(doc.pythonPath).toBe(python)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("omits an invalid interpreter instead of failing the document", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-loaddoc-bad-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, JSON.stringify(notebook))
    try {
      const doc = await loadNotebookDocument(
        context(dir, { pythonPath: path.join(dir, "missing-python") }),
        file
      )
      expect(doc.pythonPath).toBeUndefined()
      expect(doc.text).toContain("x = 1")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
