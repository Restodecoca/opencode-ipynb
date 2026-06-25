import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import * as path from "node:path"
import * as os from "node:os"
import type { ToolContext } from "@opencode-ai/plugin"
import { makePathService, makeNotebookFileService } from "../../src/services/index.js"
import {
  formatAttachment,
  pickExtensionForMime
} from "../../src/utils/attachments.js"
import { formatOutputs, formatOutputsDetailed } from "../../src/format/outputs.js"
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

describe("pickExtensionForMime", () => {
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
})

describe("formatAttachment", () => {
  it("builds a data: ToolAttachment with the right mime, url, and default filename", () => {
    const att = formatAttachment("image/png", TINY_PNG_BASE64)
    expect(att.type).toBe("file")
    expect(att.mime).toBe("image/png")
    expect(att.filename).toBe("image.png")
    expect(att.url.startsWith("data:image/png;base64,")).toBe(true)
    const payload = att.url.slice("data:image/png;base64,".length)
    const decoded = Buffer.from(payload, "base64")
    expect(decoded.equals(Buffer.from(TINY_PNG_BASE64, "base64"))).toBe(true)
  })

  it("honors a caller-provided filename", () => {
    const att = formatAttachment("image/png", TINY_PNG_BASE64, "plot.png")
    expect(att.filename).toBe("plot.png")
  })

  it("falls back to a generic filename for unknown mime types", () => {
    const att = formatAttachment("image/x-foo", TINY_PNG_BASE64)
    expect(att.filename).toBe("image")
  })
})

describe("formatOutputs > image omission", () => {
  it("keeps the 'omitted by default' notice when no save option is set", () => {
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

  it("returns a data: attachment when saveImages=true (no temp file written)", async () => {
    const before = listIpynbTmpDirs()
    const result = await formatOutputsDetailed(codeCellWithImage, { saveImages: true })

    expect(result.attachments).toHaveLength(1)
    const att = result.attachments[0]
    expect(att).toBeDefined()
    if (!att) throw new Error("expected one attachment")
    expect(att.type).toBe("file")
    expect(att.mime).toBe("image/png")
    expect(att.url.startsWith("data:image/png;base64,")).toBe(true)

    expect(result.rendered).toContain("image/png")
    expect(result.rendered).toContain("attached as image")
    // The full data URL is huge; the rendered text should NOT inline the base64.
    expect(result.rendered).not.toContain(";base64,")
    expect(result.rendered).not.toContain("omitted by default")

    // The plugin must not write anything to disk for the image anymore.
    const after = listIpynbTmpDirs()
    expect(after.length).toBe(before.length)
  })

  it("saves images when includeImages=true (legacy flag) regardless of saveImages", async () => {
    const result = await formatOutputsDetailed(codeCellWithImage, { includeImages: true })
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.mime).toBe("image/png")
  })

  it("does not save when neither flag is set (no includeImages, no saveImages)", async () => {
    const result = await formatOutputsDetailed(codeCellWithImage, {})
    expect(result.attachments).toHaveLength(0)
    expect(result.rendered).toContain("omitted by default")
  })
})

const listIpynbTmpDirs = (): string[] => {
  const root = path.join(os.tmpdir(), "opencode-ipynb")
  if (!require("node:fs").existsSync(root)) return []
  return require("node:fs").readdirSync(root) as string[]
}

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

  it("attaches images and reports the 'attached as image' notice when saveImages is true", async () => {
    const result = await formatCellMarkdownDetailed(codeCellWithImage, 3, {
      includeOutputs: true,
      saveImages: true
    })
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.mime).toBe("image/png")
    expect(result.rendered).toContain("attached as image")
  })

  it("omits images by default (no includeOutputs, no saveImages)", async () => {
    const result = await formatCellMarkdownDetailed(codeCellWithImage, 0, {})
    expect(result.attachments).toHaveLength(0)
    expect(result.rendered).not.toContain("attached as image")
  })
})

describe("ipynbReadTool > image attachments via includeImages", () => {
  let tempDir: string

  const importTool = async () => {
    const mod = await import("../../src/tools/read.js")
    return mod.ipynbReadTool
  }

  it("omits attachments when includeImages is false (default)", async () => {
    const tempDir = require("node:fs").mkdtempSync(
      path.join(os.tmpdir(), "ipynb-attach-read-omit-")
    )
    require("node:fs").copyFileSync(
      path.join(FIXTURES, "images.ipynb"),
      path.join(tempDir, "images.ipynb")
    )
    try {
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
    } finally {
      require("node:fs").rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it("returns a data: attachment for the image when includeImages is true", async () => {
    const tempDir = require("node:fs").mkdtempSync(
      path.join(os.tmpdir(), "ipynb-attach-read-data-")
    )
    require("node:fs").copyFileSync(
      path.join(FIXTURES, "images.ipynb"),
      path.join(tempDir, "images.ipynb")
    )
    try {
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
      expect(att?.url.startsWith("data:image/png;base64,")).toBe(true)
      expect(att?.filename).toBe("image.png")
      expect(result.output).toContain("attached as image")
      // The full data URL is huge; the rendered text should NOT inline the base64.
      expect(result.output).not.toContain(";base64,")
    } finally {
      require("node:fs").rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe("notebook file > makeReadImpl returns attachments for includeImages=true", () => {
  it("returns a data: attachment through the read service", async () => {
    const tempDir = require("node:fs").mkdtempSync(
      path.join(os.tmpdir(), "ipynb-attach-svc-")
    )
    try {
      const file = path.join(tempDir, "images.ipynb")
      require("node:fs").copyFileSync(path.join(FIXTURES, "images.ipynb"), file)
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
      expect(result.attachments[0]?.url.startsWith("data:image/png;base64,")).toBe(true)
      expect(result.rendered).toContain("attached as image")
    } finally {
      require("node:fs").rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe("regression: opencode image pipeline compatibility (gh#issue)", () => {
  // The opencode session processor (packages/opencode/src/session/processor.ts) runs every
  // image attachment through image.normalize (packages/opencode/src/image/image.ts), which
  // starts with:
  //   if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
  //     return yield* new InvalidDataUrlError({ url: input.url })
  // A file:// URL would hit InvalidDataUrlError, which the processor does NOT recover from
  // (only ResizerUnavailableError is caught), so the image is dropped from the tool result
  // and the user sees the misleading "could not be resized below the image size limit" line.
  //
  // These tests pin the contract: every image attachment emitted by the plugin MUST be a
  // base64 data URL so opencode's image pipeline can decode and resize it.

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

  it("formatAttachment returns a data: URL that passes opencode's InvalidDataUrlError check", () => {
    const att = formatAttachment("image/png", TINY_PNG_BASE64)
    // Mirror the two checks from opencode's image.normalize.
    const wouldBeInvalid = !att.url.startsWith("data:") || !att.url.includes(";base64,")
    expect(wouldBeInvalid).toBe(false)
    // Sanity: the data URL's payload must round-trip back to the original bytes.
    const base64 = att.url.slice(att.url.indexOf(";base64,") + ";base64,".length)
    const decoded = Buffer.from(base64, "base64")
    expect(decoded.equals(Buffer.from(TINY_PNG_BASE64, "base64"))).toBe(true)
  })

  it("formatOutputsDetailed never emits a file:// image attachment", async () => {
    const result = await formatOutputsDetailed(codeCellWithImage, { saveImages: true })
    for (const att of result.attachments) {
      expect(att.url.startsWith("file://")).toBe(false)
      expect(att.url.startsWith("data:")).toBe(true)
      expect(att.url.includes(";base64,")).toBe(true)
    }
  })

  it("formatCellMarkdownDetailed never emits a file:// image attachment", async () => {
    const result = await formatCellMarkdownDetailed(codeCellWithImage, 0, {
      includeOutputs: true,
      saveImages: true
    })
    for (const att of result.attachments) {
      expect(att.url.startsWith("file://")).toBe(false)
      expect(att.url.startsWith("data:")).toBe(true)
      expect(att.url.includes(";base64,")).toBe(true)
    }
  })

  it("read tool returns a data: attachment for the image (end-to-end through the read service)", async () => {
    const tempDir = require("node:fs").mkdtempSync(
      path.join(os.tmpdir(), "ipynb-attach-regression-")
    )
    try {
      require("node:fs").copyFileSync(
        path.join(FIXTURES, "images.ipynb"),
        path.join(tempDir, "images.ipynb")
      )
      const ipynbReadTool = (await import("../../src/tools/read.js")).ipynbReadTool
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
        attachments?: ReadonlyArray<{ mime: string; url: string }>
        output: string
      }
      expect(result.attachments).toBeDefined()
      for (const att of result.attachments ?? []) {
        // The bug we're guarding against: a file:// URL here gets dropped by opencode.
        expect(att.url.startsWith("file://")).toBe(false)
        expect(att.url.startsWith(`data:${att.mime};base64,`)).toBe(true)
      }
      // The text note should NOT echo the full base64 back into the rendered markdown.
      expect(result.output).not.toContain(";base64,")
    } finally {
      require("node:fs").rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
