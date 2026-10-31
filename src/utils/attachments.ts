import type { ToolAttachment } from "../tool.js"

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
  payload: string,
  filename?: string
): ToolAttachment => {
  const ext = pickExtensionForMime(mime)
  // Jupyter stores image/svg+xml as raw XML, unlike base64 raster formats.
  const isRawSvg =
    mime.toLowerCase() === "image/svg+xml" &&
    (payload.includes("<svg") || payload.includes("<?xml"))
  const base64 = isRawSvg
    ? Buffer.from(payload, "utf8").toString("base64")
    : payload
  return {
    type: "file",
    mime,
    url: `data:${mime};base64,${base64}`,
    filename: filename ?? `image${ext ? `.${ext}` : ""}`
  }
}
