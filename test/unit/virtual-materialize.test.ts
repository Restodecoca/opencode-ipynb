import { describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildNotebookVirtualDocument } from "../../src/lsp.js"
import {
  cleanupVirtualDocuments,
  hasMaterializedDocument,
  materializeVirtualDocument,
  materializedPath,
  refreshMaterializedDocument
} from "../../src/virtual-materialize.js"

const notebook = {
  metadata: {
    kernelspec: { name: "python3", language: "python" },
    language_info: { name: "python", file_extension: ".py" }
  },
  cells: [
    { cell_type: "code", source: "def add(a: int, b: int) -> int:\n    return a + b" },
    { cell_type: "code", source: "result = add(1, 2)" }
  ]
}

describe("virtual notebook materialization", () => {
  it("writes the virtual document inside the worktree and maps lines to cells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const materialized = await materializeVirtualDocument(document, dir)
      expect(path.dirname(materialized.path)).toBe(dir)
      expect(path.basename(materialized.path)).toMatch(/^opencode-ipynb-lsp-[0-9a-f]{16}\.py$/)
      expect(fs.readFileSync(materialized.path, "utf8")).toBe(document.text)
      expect(materialized.cells).toEqual([
        { cellIndex: 0, cellType: "code", startLine: 1, endLine: 2 },
        { cellIndex: 1, cellType: "code", startLine: 3, endLine: 3 }
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })


  it("forces 0600 even when the sidecar path pre-exists with 0644", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-mode-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const target = materializedPath(file, dir)
    fs.writeFileSync(target, "OLD")
    fs.chmodSync(target, 0o644)
    try {
      const materialized = await materializeVirtualDocument(document, dir)
      expect(fs.statSync(materialized.path).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(materialized.path, "utf8")).toBe(document.text)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("removes only the materialized sidecar", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const materialized = await materializeVirtualDocument(document, dir)
      expect(fs.existsSync(materialized.path)).toBe(true)
      await cleanupVirtualDocuments(dir)
      expect(fs.existsSync(materialized.path)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("replaces a symlink at the target instead of writing through it", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-out-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    const outsideFile = path.join(outside, "keep.py")
    fs.writeFileSync(outsideFile, "outside")
    const target = materializedPath(file)
    fs.symlinkSync(outsideFile, target)
    try {
      await materializeVirtualDocument(document, dir)
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside")
      expect(fs.readFileSync(target, "utf8")).toBe(document.text)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("refreshes an existing sidecar after the notebook changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const materialized = await materializeVirtualDocument(document, dir)
      const changed = {
        ...notebook,
        cells: [
          { cell_type: "code", source: "def fresh(): pass" },
          { cell_type: "code", source: "result = fresh()" }
        ]
      }
      const next = buildNotebookVirtualDocument(changed, { filePath: file })
      await expect(refreshMaterializedDocument(next, dir)).resolves.toBe(true)
      expect(fs.readFileSync(materialized.path, "utf8")).toBe(next.text)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does nothing when the notebook was never materialized", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      await expect(refreshMaterializedDocument(document, dir)).resolves.toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("does not rewrite a sidecar whose content is already current", async () => {    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const first = await materializeVirtualDocument(document, dir)
      const inode = fs.statSync(first.path).ino
      const original = fs.promises.rename
      let renames = 0
      const spy = spyOn(fs.promises, "rename").mockImplementation(((
        from: fs.PathLike,
        to: fs.PathLike
      ) => {
        renames += 1
        return original(from, to)
      }) as unknown as typeof fs.promises.rename)
      try {
        await materializeVirtualDocument(document, dir)
        expect(renames).toBe(0)
        expect(fs.statSync(first.path).ino).toBe(inode)
        expect(fs.readFileSync(first.path, "utf8")).toBe(document.text)
      } finally {
        spy.mockRestore()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("skips the rewrite when a refresh produces identical text", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const first = await materializeVirtualDocument(document, dir)
      const inode = fs.statSync(first.path).ino
      const original = fs.promises.rename
      let renames = 0
      const spy = spyOn(fs.promises, "rename").mockImplementation(((
        from: fs.PathLike,
        to: fs.PathLike
      ) => {
        renames += 1
        return original(from, to)
      }) as unknown as typeof fs.promises.rename)
      try {
        await expect(refreshMaterializedDocument(document, dir)).resolves.toBe(true)
        expect(renames).toBe(0)
        expect(fs.statSync(first.path).ino).toBe(inode)
      } finally {
        spy.mockRestore()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a directory at the sidecar path without creating a temp file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-"))
    const file = path.join(dir, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    fs.mkdirSync(materializedPath(file, dir))
    try {
      await expect(materializeVirtualDocument(document, dir)).rejects.toThrow(
        "Refusing to replace a directory"
      )
      expect(fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("uses the real notebook identity for symlink aliases", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-alias-"))
    const real = path.join(dir, "real.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: real })
    fs.writeFileSync(real, "{}")
    fs.symlinkSync(real, alias)
    try {
      const first = await materializeVirtualDocument(document, dir)
      const aliased = buildNotebookVirtualDocument(notebook, { filePath: alias })
      const second = await materializeVirtualDocument(aliased, dir)
      expect(second.path).toBe(first.path)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("cleans sidecars per project instead of untracking other projects", async () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-a-"))
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-b-"))
    const fileA = path.join(a, "a.ipynb")
    const fileB = path.join(b, "b.ipynb")
    try {
      const first = await materializeVirtualDocument(
        buildNotebookVirtualDocument(notebook, { filePath: fileA }),
        a
      )
      const second = await materializeVirtualDocument(
        buildNotebookVirtualDocument(notebook, { filePath: fileB }),
        b
      )
      await cleanupVirtualDocuments(a)
      expect(fs.existsSync(first.path)).toBe(false)
      expect(fs.existsSync(second.path)).toBe(true)
      await cleanupVirtualDocuments(b)
      expect(fs.existsSync(second.path)).toBe(false)
    } finally {
      fs.rmSync(a, { recursive: true, force: true })
      fs.rmSync(b, { recursive: true, force: true })
    }
  })

  it("does not follow a replaced notebook directory during cleanup", async () => {
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-cleanup-race-"))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-cleanup-out-"))
    const sub = path.join(root, "sub")
    fs.mkdirSync(sub)
    const file = path.join(sub, "nb.ipynb")
    const materialized = await materializeVirtualDocument(
      buildNotebookVirtualDocument(notebook, { filePath: file }),
      root
    )
    const sidecarName = path.basename(materialized.path)
    fs.rmSync(sub, { recursive: true, force: true })
    fs.symlinkSync(outside, sub)
    const victim = path.join(outside, sidecarName)
    fs.writeFileSync(victim, "keep")
    try {
      await cleanupVirtualDocuments(root)
      expect(fs.readFileSync(victim, "utf8")).toBe("keep")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it("returns a lexical path when the session root itself is a symlink", async () => {
    if (process.platform === "win32") return
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-real-"))
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-link-"))
    const link = path.join(linkParent, "root")
    fs.symlinkSync(real, link)
    const file = path.join(link, "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: file })
    try {
      const materialized = await materializeVirtualDocument(document, link)
      expect(materialized.path.startsWith(link + path.sep)).toBe(true)
      expect(fs.existsSync(materialized.path)).toBe(true)
      await expect(hasMaterializedDocument(link, file)).resolves.toBe(true)
    } finally {
      fs.rmSync(real, { recursive: true, force: true })
      fs.rmSync(linkParent, { recursive: true, force: true })
    }
  })

  it("maps an absolute real notebook path back under a symlinked session root", async () => {
    if (process.platform === "win32") return
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-abs-real-"))
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-materialize-abs-link-"))
    const link = path.join(linkParent, "root")
    fs.mkdirSync(path.join(real, "notebooks"))
    fs.symlinkSync(real, link)
    const realFile = path.join(real, "notebooks", "nav.ipynb")
    const document = buildNotebookVirtualDocument(notebook, { filePath: realFile })
    try {
      const materialized = await materializeVirtualDocument(document, link)
      expect(materialized.path.startsWith(link + path.sep)).toBe(true)
      expect(fs.existsSync(materialized.path)).toBe(true)
    } finally {
      fs.rmSync(real, { recursive: true, force: true })
      fs.rmSync(linkParent, { recursive: true, force: true })
    }
  })

})
