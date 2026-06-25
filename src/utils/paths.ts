import * as path from "node:path"

const isWindowsPath = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")

export interface NormalizeOptions {
  readonly platform?: NodeJS.Platform
  readonly resolveAbsolute?: (p: string) => string
}

const defaultResolve = (p: string): string => path.resolve(p)

export const normalizeSlashes = (p: string, platform: NodeJS.Platform = process.platform): string => {
  if (platform === "win32") {
    return p.replace(/\//g, "\\")
  }
  return p.replace(/\\/g, "/")
}

export const isAbsolutePath = (p: string): boolean => {
  if (!p) {
    return false
  }
  if (isWindowsPath(p)) {
    return true
  }
  return p.startsWith("/")
}

export const hasIpynbExtension = (p: string): boolean => {
  if (!p) {
    return false
  }
  const lower = p.toLowerCase()
  return lower.endsWith(".ipynb")
}

export const ensureIpynbExtension = (p: string): string => {
  if (hasIpynbExtension(p)) {
    return p
  }
  return `${p}.ipynb`
}

export interface ResolveInput {
  readonly inputPath: string
  readonly base: string
  readonly platform?: NodeJS.Platform
  readonly resolveAbsolute?: (p: string) => string
}

export const resolveAgainstBase = (opts: ResolveInput): string => {
  const { inputPath, base } = opts
  const platform = opts.platform ?? process.platform
  const resolve = opts.resolveAbsolute ?? defaultResolve

  if (isAbsolutePath(inputPath)) {
    return resolve(inputPath)
  }
  if (!base) {
    return resolve(inputPath)
  }
  const sep = platform === "win32" ? "\\" : "/"
  const trimmed = base.endsWith(sep) ? base.slice(0, -1) : base
  return resolve(`${trimmed}${sep}${inputPath}`)
}

export interface RelativeOptions {
  readonly platform?: NodeJS.Platform
  readonly relativeFn?: (from: string, to: string) => string
}

export const makeRelative = (
  from: string,
  to: string,
  opts: RelativeOptions = {}
): string => {
  const relative = opts.relativeFn ?? ((a: string, b: string) => b)
  return relative(from, to)
}

export const toForwardSlashes = (p: string): string => p.replace(/\\/g, "/")
