import type { ToolAttachment } from "@opencode-ai/plugin"

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

export const formatAttachment = (
  mime: string,
  base64: string,
  filename?: string
): ToolAttachment => {
  const ext = pickExtensionForMime(mime)
  return {
    type: "file",
    mime,
    url: `data:${mime};base64,${base64}`,
    filename: filename ?? `image${ext ? `.${ext}` : ""}`
  }
}
