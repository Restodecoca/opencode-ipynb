import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import type { ToolAttachment } from "@opencode-ai/plugin"

export interface SavedAttachment {
  readonly path: string
  readonly mime: string
  readonly bytes: number
  readonly filename: string
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/bmp": "bmp"
}

export const pickExtensionForMime = (mime: string): string | undefined => {
  return EXTENSION_BY_MIME[mime.toLowerCase()]
}

export const saveBase64Image = async (
  mime: string,
  base64: string,
  prefix: string = "img"
): Promise<SavedAttachment> => {
  const ext = pickExtensionForMime(mime) ?? "bin"
  const dir = path.join(
    os.tmpdir(),
    "opencode-ipynb",
    `${prefix}-${process.pid}-${randomBytes(4).toString("hex")}`
  )
  await fs.promises.mkdir(dir, { recursive: true })
  const buffer = Buffer.from(base64, "base64")
  const filename = `${prefix}.${ext}`
  const filePath = path.join(dir, filename)
  await fs.promises.writeFile(filePath, buffer)
  return { path: filePath, mime, bytes: buffer.length, filename }
}

export const formatAttachment = async (a: SavedAttachment): Promise<ToolAttachment> => {
  const buffer = await fs.promises.readFile(a.path)
  const data = buffer.toString("base64")
  return {
    type: "file",
    mime: a.mime,
    url: `data:${a.mime};base64,${data}`,
    filename: a.filename
  }
}
