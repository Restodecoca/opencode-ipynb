import { describe, expect, it } from "bun:test"
import {
  buildNotebookVirtualDocument,
  makePositionMapper,
  toCellPosition,
  toVirtualPosition
} from "../../src/lsp.js"
import type { NotebookRaw } from "../../src/domain/notebook.js"

const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python", file_extension: ".py" }
  },
  cells: [
    { cell_type: "markdown", metadata: {}, source: "# Title" },
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: ["x = 1\n", "print(x)"]
    },
    {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: "y = 2"
    }
  ]
} as unknown as NotebookRaw

describe("notebook virtual document", () => {
  it("concatenates code cells and tracks their line ranges", () => {
    const document = buildNotebookVirtualDocument(notebook, {
      filePath: "/tmp/notebook.ipynb"
    })

    expect(document.filePath).toBe("/tmp/notebook.ipynb")
    expect(document.languageId).toBe("python")
    expect(document.kernelName).toBe("python3")
    expect(document.fileExtension).toBe(".py")
    expect(document.text).toBe("x = 1\nprint(x)\ny = 2")
    expect(document.cells).toEqual([
      {
        cellIndex: 1,
        cellType: "code",
        languageId: "python",
        text: "x = 1\nprint(x)",
        startLine: 0,
        endLine: 2,
        lineCount: 2
      },
      {
        cellIndex: 2,
        cellType: "code",
        languageId: "python",
        text: "y = 2",
        startLine: 2,
        endLine: 3,
        lineCount: 1
      }
    ])
  })

  it("can include markdown cells", () => {
    const document = buildNotebookVirtualDocument(notebook, {
      includeMarkdown: true
    })

    expect(document.text).toBe("# Title\nx = 1\nprint(x)\ny = 2")
    expect(document.cells[0]).toEqual({
      cellIndex: 0,
      cellType: "markdown",
      languageId: "markdown",
      text: "# Title",
      startLine: 0,
      endLine: 1,
      lineCount: 1
    })
  })

  it("exposes URIs and the configured environment for LSP clients", () => {
    const document = buildNotebookVirtualDocument(notebook, {
      filePath: "/tmp/notebook.ipynb",
      notebookUri: "file:///tmp/notebook.ipynb",
      cellUri: (cellIndex) => `file:///tmp/notebook.ipynb#cell=${cellIndex}`,
      pythonPath: "/opt/python"
    })

    expect(document.notebookUri).toBe("file:///tmp/notebook.ipynb")
    expect(document.pythonPath).toBe("/opt/python")
    expect(document.cells[0]?.uri).toBe("file:///tmp/notebook.ipynb#cell=1")
  })

  it("maps positions in both directions", () => {
    const document = buildNotebookVirtualDocument(notebook)

    expect(toCellPosition(document, 2, 4)).toEqual({
      cellIndex: 2,
      line: 0,
      character: 4
    })
    expect(toCellPosition(document, 99, 0)).toBeUndefined()
    expect(toVirtualPosition(document, 1, 1, 3)).toEqual({
      line: 1,
      character: 3
    })
    expect(toVirtualPosition(document, 2, 1, 0)).toBeUndefined()
  })

  it("binds the mapper to a document", () => {
    const document = buildNotebookVirtualDocument(notebook)
    const mapper = makePositionMapper(document)

    expect(mapper.toVirtualPosition(2, 0, 2)).toEqual({ line: 2, character: 2 })
    expect(mapper.toCellPosition(2, 2)).toEqual({
      cellIndex: 2,
      line: 0,
      character: 2
    })
  })

  it("normalizes CRLF and common language ids", () => {
    const document = buildNotebookVirtualDocument({
      metadata: {
        kernelspec: { name: "python3", language: "python" },
        language_info: { name: "python3" }
      },
      cells: [{ cell_type: "code", source: "a = 1\r\nb = 2" }]
    })

    expect(document.languageId).toBe("python")
    expect(document.fileExtension).toBe(".py")
    expect(document.text).toBe("a = 1\nb = 2")
    expect(toCellPosition(document, 1, 0)).toEqual({
      cellIndex: 0,
      line: 1,
      character: 0
    })
  })

  it("falls back to python when metadata has no language", () => {
    const document = buildNotebookVirtualDocument({
      ...notebook,
      metadata: {}
    } as NotebookRaw)
    expect(document.languageId).toBe("python")
  })
})
