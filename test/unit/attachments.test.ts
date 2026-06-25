import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  makePathService,
  makeNotebookFileService
} from "../../src/services/index.js"
import {
  saveBase64Image,
  formatAttachment,
  pickExtensionForMime
} from "../../src/utils/attachments.js"
import {
  formatOutputs,
  formatOutputsDetailed
} from "../../src/format/outputs.js"
import { formatCellMarkdownDetailed } from "../../src/format/markdown.js"
import type { CodeCellRaw } from "../../src/domain/cell.js"

const FIXTURES = path.resolve(__dirname, "..", "fixtures")

const makeFakeContext = (directory: string, worktree: string): ToolContext =>
  ({
    sessionID: "test",
    messageID: "test",
    agent: "test",
    directory,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {}
  }) as unknown as ToolContext

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

describe("saveBase64Image", () => {
  it("decodes a valid base64 PNG, writes it to a temp directory, and returns the saved metadata", async () => {
    const saved = await saveBase64Image("image/png", TINY_PNG_BASE64, "test-png")

    expect(saved.mime).toBe("image/png")
    expect(saved.filename).toBe("test-png.png")
    expect(saved.bytes).toBeGreaterThan(0)
    expect(saved.path).toContain(path.join(os.tmpdir(), "opencode-ipynb"))
    expect(saved.path.endsWith("test-png.png")).toBe(true)
    expect(fs.existsSync(saved.path)).toBe(true)
    const onDisk = fs.readFileSync(saved.path)
    const expected = Buffer.from(TINY_PNG_BASE64, "base64")
    expect(onDisk.equals(expected)).toBe(true)
    expect(onDisk.length).toBe(saved.bytes)

    fs.rmSync(path.dirname(saved.path), { recursive: true, force: true })
  })

  it("picks the right extension for each supported mime type", () => {
    expect(pickExtensionForMime("image/png")).toBe("png")
    expect(pickExtensionForMime("image/jpeg")).toBe("jpg")
    expect(pickExtensionForMime("image/jpg")).toBe("jpg")
    expect(pickExtensionForMime("image/gif")).toBe("gif")
    expect(pickExtensionForMime("image/svg+xml")).toBe("svg")
    expect(pickExtensionForMime("image/webp")).toBe("webp")
    expect(pickExtensionForMime("image/bmp")).toBe("bmp")
    expect(pickExtensionForMime("IMAGE/PNG")).toBe("png")
    expect(pickExtensionForMime("text/plain")).toBeUndefined()
  })

  it("creates a unique directory per call under the opencode-ipynb tmp root", async () => {
    const a = await saveBase64Image("image/png", TINY_PNG_BASE64, "a")
    const b = await saveBase64Image("image/png", TINY_PNG_BASE64, "b")
    expect(a.path).not.toBe(b.path)
    expect(path.dirname(a.path)).not.toBe(path.dirname(b.path))
    fs.rmSync(path.dirname(a.path), { recursive: true, force: true })
    fs.rmSync(path.dirname(b.path), { recursive: true, force: true })
  })
})

describe("formatAttachment", () => {
  it("builds a file:// ToolAttachment with the right mime, url, and filename", () => {
    const saved = {
      path: path.join(os.tmpdir(), "opencode-ipynb", "fake", "img.png"),
      mime: "image/png",
      bytes: 100,
      filename: "img.png"
    }
    const att = formatAttachment(saved)
    expect(att.type).toBe("file")
    expect(att.mime).toBe("image/png")
    expect(att.filename).toBe("img.png")
    expect(att.url.startsWith("file://")).toBe(true)
    expect(att.url).toContain("img.png")
  })
})

describe("formatOutputs > image omission", () => {
  it("keeps the legacy 'omitted by default' notice when no save option is set", () => {
    const cell: CodeCellRaw = {
      cell_type: "code",
      execution_count: 1,
      metadata: {},
      outputs: [
        {
          output_type: "display_data",
          data: { "image/png": TINY_PNG_BASE64 },
          metadata: {}
        }
      ],
      source: "x = 1"
    }
    const rendered = formatOutputs(cell)
    expect(rendered).toContain("image/png")
    expect(rendered).toContain("omitted by default")
  })

  it("does not save images when includeImages is explicitly false (the read-tool default)", async () => {
    const cell: CodeCellRaw = {
      cell_type: "code",
      execution_count: 1,
      metadata: {},
      outputs: [
        {
          output_type: "display_data",
          data: { "image/png": TINY_PNG_BASE64 },
          metadata: {}
        }
      ],
      source: "x = 1"
    }
    const result = await formatOutputsDetailed(cell, { includeImages: false })
    expect(result.attachments).toHaveLength(0)
    expect(result.rendered).toContain("omitted by default")
  })
})

describe("formatOutputsDetailed > image attachments", () => {
  const codeCellWithImage: CodeCellRaw = {
    cell_type: "code",
    execution_count: 1,
    metadata: {},
    outputs: [
      {
        output_type: "display_data",
        data: { "image/png": TINY_PNG_BASE64 },
        metadata: {}
      }
    ],
    source: "x = 1"
  }

  const cleanup = (paths: ReadonlyArray<string>): void => {
    for (const p of paths) {
      try {
        fs.rmSync(path.dirname(p), { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  }

  it("saves the image to a temp file and returns a file:// attachment when saveImages=true", async () => {
    const result = await formatOutputsDetailed(codeCellWithImage, { saveImages: true })

    expect(result.attachments).toHaveLength(1)
    const att = result.attachments[0]
    expect(att).toBeDefined()
    if (!att) throw new Error("expected one attachment")
    expect(att.type).toBe("file")
    expect(att.mime).toBe("image/png")
    expect(att.filename).toBe("img.png")
    expect(att.url.startsWith("file://")).toBe(true)
    expect(att.url).toContain("img.png")
    expect(fs.existsSync(result.savedAttachments[0]?.path ?? "")).toBe(true)

    expect(result.rendered).toContain("image/png")
    expect(result.rendered).toContain("saved")
    expect(result.rendered).toContain(att.url)
    expect(result.rendered).not.toContain("omitted by default")

    cleanup(result.savedAttachments.map((s) => s.path))
  })

  it("saves images when includeImages=true (legacy flag) regardless of saveImages", async () => {
    const result = await formatOutputsDetailed(codeCellWithImage, { includeImages: true })
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.mime).toBe("image/png")
    cleanup(result.savedAttachments.map((s) => s.path))
  })

  it("does not save when neither flag is set (no includeImages, no saveImages)", async () => {
    const result = await formatOutputsDetailed(codeCellWithImage, {})
    expect(result.attachments).toHaveLength(0)
    expect(result.rendered).toContain("omitted by default")
  })

  it("uses a custom prefix in the filename and temp directory", async () => {
    const result = await formatOutputsDetailed(codeCellWithImage, { saveImages: true })
    // The first call used default prefix; this test focuses on the prefix being applied per call.
    const saved = await saveBase64Image("image/png", TINY_PNG_BASE64, "cell-3")
    expect(saved.filename).toBe("cell-3.png")
    expect(path.dirname(saved.path)).toContain("cell-3-")
    fs.rmSync(path.dirname(saved.path), { recursive: true, force: true })
    cleanup(result.savedAttachments.map((s) => s.path))
  })
})

describe("formatCellMarkdownDetailed > plumbing saveImages", () => {
  const codeCellWithImage: CodeCellRaw = {
    cell_type: "code",
    execution_count: 1,
    metadata: {},
    outputs: [
      {
        output_type: "display_data",
        data: { "image/png": TINY_PNG_BASE64 },
        metadata: {}
      }
    ],
    source: "x = 1"
  }

  const cleanup = (paths: ReadonlyArray<string>): void => {
    for (const p of paths) {
      try {
        fs.rmSync(path.dirname(p), { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  }

  it("saves images and returns attachments when saveImages is true and includeOutputs is true", async () => {
    const result = await formatCellMarkdownDetailed(codeCellWithImage, 3, {
      includeOutputs: true,
      saveImages: true
    })
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.mime).toBe("image/png")
    expect(result.rendered).toContain("saved")
    cleanup(result.savedAttachments.map((s) => s.path))
  })

  it("omits images by default (no includeOutputs, no saveImages)", async () => {
    const result = await formatCellMarkdownDetailed(codeCellWithImage, 0, {})
    expect(result.attachments).toHaveLength(0)
    expect(result.rendered).not.toContain("saved")
  })
})

describe("ipynbReadTool > image attachments via includeImages", () => {
  let tempDir: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-attach-read-"))
    fs.copyFileSync(path.join(FIXTURES, "images.ipynb"), path.join(tempDir, "images.ipynb"))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const importTool = async () => {
    const mod = await import("../../src/tools/read.js")
    return mod.ipynbReadTool
  }

  it("omits attachments when includeImages is false (default)", async () => {
    const ipynbReadTool = await importTool()
    const result = (await ipynbReadTool.execute(
      {
        filePath: path.join(tempDir, "images.ipynb"),
        cellIndex: 0,
        start: undefined,
        end: undefined,
        includeOutputs: true,
        includeErrors: true,
        includeMetadata: false,
        includeImages: false,
        maxSourceChars: 12_000,
        maxOutputChars: 6_000
      },
      makeFakeContext(tempDir, tempDir)
    )) as { output: string; attachments?: ReadonlyArray<{ mime: string }> }
    expect(result.attachments).toBeUndefined()
    expect(result.output).toContain("omitted by default")
  })

  it("returns a file:// attachment for the image when includeImages is true", async () => {
    const ipynbReadTool = await importTool()
    const result = (await ipynbReadTool.execute(
      {
        filePath: path.join(tempDir, "images.ipynb"),
        cellIndex: 0,
        start: undefined,
        end: undefined,
        includeOutputs: true,
        includeErrors: true,
        includeMetadata: false,
        includeImages: true,
        maxSourceChars: 12_000,
        maxOutputChars: 6_000
      },
      makeFakeContext(tempDir, tempDir)
    )) as {
      output: string
      attachments?: ReadonlyArray<{ mime: string; url: string; filename: string }>
    }
    expect(result.attachments).toBeDefined()
    expect(result.attachments?.length).toBe(1)
    const att = result.attachments?.[0]
    expect(att?.mime).toBe("image/png")
    expect(att?.url.startsWith("file://")).toBe(true)
    expect(att?.filename).toBe("img.png")
    expect(result.output).toContain("saved")
    expect(result.output).toContain(att?.url ?? "")

    if (att) {
      try {
        const url = new URL(att.url)
        fs.rmSync(path.dirname(url.pathname.replace(/^\//, "")), { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  })
})

describe("notebook file > makeReadImpl returns attachments for includeImages=true", () => {
  it("returns attachments and a 'saved' notice through the read service", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-attach-svc-"))
    try {
      const file = path.join(tempDir, "images.ipynb")
      fs.copyFileSync(path.join(FIXTURES, "images.ipynb"), file)
      const pathSvc = makePathService({
        directory: tempDir,
        worktree: tempDir,
        platform: process.platform
      })
      const fileSvc = makeNotebookFileService()
      const { makeReadImpl } = await import("../../src/services/NotebookReadService.js")
      const read = makeReadImpl(pathSvc, fileSvc)
      const result = await Effect.runPromise(
        read.readCell(file, 0, { includeOutputs: true, includeImages: true, saveImages: true })
      )
      expect(result.attachments.length).toBe(1)
      expect(result.attachments[0]?.mime).toBe("image/png")
      expect(result.attachments[0]?.url.startsWith("file://")).toBe(true)
      expect(result.rendered).toContain("saved")

      for (const att of result.attachments) {
        try {
          const url = new URL(att.url)
          fs.rmSync(path.dirname(url.pathname.replace(/^\//, "")), { recursive: true, force: true })
        } catch {
          // best-effort cleanup
        }
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
