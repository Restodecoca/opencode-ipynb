const ATTACHABLE_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp"
])

export const isImageMime = (mime: string): boolean =>
  mime.toLowerCase().startsWith("image/")

export const estimateBase64Bytes = (data: string): number => {
  if (!data) {
    return 0
  }
  const len = data.length
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

export const humanBytes = (n: number): string => {
  if (n < 1024) {
    return `${n} B`
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`
  }
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export const isAttachableImageMime = (mime: string): boolean =>
  ATTACHABLE_IMAGE_MIMES.has(mime.toLowerCase())
