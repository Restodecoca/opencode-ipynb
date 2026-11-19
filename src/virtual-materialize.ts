import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import { replaceFile } from "./utils/atomic-replace.js"
import * as path from "node:path"
import type { NotebookVirtualDocument } from "./lsp.js"
import { sanitizeNotebookText } from "./notebook-diagnostics.js"
import { pathInside } from "./utils/paths.js"
import { beforeRenameHook } from "./utils/rename-hook.js"
import {
  type Warning,
  type WarningSink,
  makeWarningSink,
  warningFrom
} from "./utils/warnings.js"

export interface MaterializedCell {
  readonly cellIndex: number
  readonly cellType: string
  readonly startLine: number
  readonly endLine: number
}

export interface MaterializedDocument {
  readonly path: string
  readonly text: string
  readonly cells: ReadonlyArray<MaterializedCell>
  readonly warnings?: ReadonlyArray<Warning>
}

export interface MaterializeOptions {
  readonly warningSink?: WarningSink | undefined
}

export interface CleanupOptions {
  readonly warningSink?: WarningSink
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

const SIDECAR_PREFIX = "opencode-ipynb-lsp-"
const LEGACY_DIRECTORY = ".opencode/ipynb-lsp"
const LEGACY_FILE = /\.[0-9a-f]{16}\.py$/
const MAX_AGE_MS = 60 * 60 * 1000

// realpath only resolves what already exists. A virtual document can name a
// notebook that does not exist on disk yet, and on macOS the temp dir itself is
// a symlink (/tmp -> /private/tmp): returning the lexical spelling for a
// missing file made the root-containment check compare two spellings of one
// directory, so the sidecar fell back outside the session root. Resolve the
// deepest existing ancestor and keep the missing tail lexical.
const realPath = (filePath: string): string => {
  try {
    return fs.realpathSync(filePath)
  } catch {
    const parent = path.dirname(filePath)
    if (parent === filePath) return filePath
    return path.join(realPath(parent), path.basename(filePath))
  }
}

const hashFor = (filePath: string): string =>
  createHash("sha256").update(realPath(filePath)).digest("hex").slice(0, 16)

const fileNameFor = (filePath: string): string =>
  `${SIDECAR_PREFIX}${hashFor(filePath)}.py`

export const materializedPath = (filePath: string, root?: string): string => {
  const realFile = realPath(filePath)
  if (root !== undefined) {
    const rootReal = realPath(root)
    if (pathInside(rootReal, realFile)) {
      const lexicalRoot = path.resolve(root)
      const relative = path.relative(rootReal, realFile)
      return path.join(lexicalRoot, path.dirname(relative), fileNameFor(filePath))
    }
  }
  const lexicalDir = path.dirname(path.resolve(filePath))
  const realDir = path.dirname(realFile)
  try {
    if (fs.realpathSync(lexicalDir) === realDir) {
      return path.join(lexicalDir, fileNameFor(filePath))
    }
  } catch {
  }
  return path.join(realDir, fileNameFor(filePath))
}

const activeSidecars = new Map<string, Set<string>>()

const trackSidecar = (
  rootReal: string,
  safeTarget: string,
  target: string
): string => {
  const tracked = activeSidecars.get(rootReal) ?? new Set<string>()
  tracked.add(safeTarget)
  activeSidecars.set(rootReal, tracked)
  return target
}

const writeSidecar = async (
  worktree: string,
  filePath: string,
  text: string,
  sink: WarningSink | undefined
): Promise<string> => {
  const rootReal = await fsp.realpath(worktree)
  const target = materializedPath(filePath, worktree)
  const directoryReal = await fsp.realpath(path.dirname(target))
  if (!pathInside(rootReal, directoryReal)) {
    throw new Error(`Refusing to write outside the session directory: ${target}`)
  }
  const safeTarget = path.join(directoryReal, path.basename(target))
  const existing = await fsp.lstat(safeTarget).catch((error: unknown) => {
    if (!isMissing(error)) {
      sink?.add(warningFrom("sidecar-cleanup", error, `inspecting ${safeTarget}`))
    }
    return undefined
  })
  if (existing?.isDirectory()) {
    throw new Error(`Refusing to replace a directory: ${safeTarget}`)
  }
  if (existing?.isFile()) {
    const current = await fsp.readFile(safeTarget, "utf8").catch((error: unknown) => {
      if (!isMissing(error)) {
        sink?.add(warningFrom("sidecar-cleanup", error, `reading ${safeTarget}`))
      }
      return undefined
    })
    if (current === text) {
      return trackSidecar(rootReal, safeTarget, target)
    }
  }
  const temp = path.join(
    directoryReal,
    `${SIDECAR_PREFIX}${randomBytes(6).toString("hex")}.tmp`
  )
  try {
    await fsp.writeFile(temp, text, { encoding: "utf8", flag: "wx", mode: 0o600 })
    await beforeRenameHook(safeTarget)
    const freshDir = await fsp.realpath(path.dirname(safeTarget))
    if (!pathInside(rootReal, freshDir)) {
      throw new Error(`Refusing to write outside the session directory: ${freshDir}`)
    }
    const freshTarget = path.join(freshDir, path.basename(safeTarget))
    if (freshTarget !== safeTarget) {
      const moved = path.join(freshDir, path.basename(temp))
      await fsp.rename(temp, moved)
      await replaceFile(moved, freshTarget, sink)
      return trackSidecar(rootReal, freshTarget, target)
    }
    await replaceFile(temp, safeTarget, sink)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch((cleanupError: unknown) => {
      sink?.add(warningFrom("temp-unlink", cleanupError, `left ${temp}`))
    })
    throw error
  }
  return trackSidecar(rootReal, safeTarget, target)
}

const cleanupLegacyDirectory = async (
  rootReal: string,
  sink: WarningSink | undefined
): Promise<void> => {
  const directory = path.join(rootReal, LEGACY_DIRECTORY)
  const stat = await fsp.lstat(directory).catch((error: unknown) => {
    if (!isMissing(error)) {
      sink?.add(warningFrom("sidecar-cleanup", error, `inspecting ${directory}`))
    }
    return undefined
  })
  if (stat === undefined) return
  if (stat.isSymbolicLink()) {
    await fsp.rm(directory, { force: true })
    return
  }
  const real = await fsp.realpath(directory).catch((error: unknown) => {
    if (!isMissing(error)) {
      sink?.add(warningFrom("sidecar-cleanup", error, `resolving ${directory}`))
    }
    return undefined
  })
  if (real === undefined || !pathInside(rootReal, real)) {
    throw new Error(`Refusing to clean a materialized directory outside the worktree`)
  }
  const now = Date.now()
  const entries = await fsp.readdir(real, { withFileTypes: true }).catch((error: unknown) => {
    sink?.add(warningFrom("sidecar-cleanup", error, `listing ${real}`))
    return []
  })
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (LEGACY_FILE.test(entry.name) || entry.name.endsWith(".tmp"))
      )
      .map(async (entry) => {
        const file = path.join(real, entry.name)
        const info = await fsp.stat(file).catch((error: unknown) => {
          if (!isMissing(error)) {
            sink?.add(warningFrom("sidecar-cleanup", error, `inspecting ${file}`))
          }
          return undefined
        })
        if (info !== undefined && now - info.mtimeMs > MAX_AGE_MS) {
          await fsp.rm(file, { force: true }).catch((error: unknown) => {
            sink?.add(warningFrom("sidecar-cleanup", error, `removing ${file}`))
          })
        }
      })
  )
  await fsp.rmdir(real).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
      sink?.add(warningFrom("sidecar-cleanup", error, `removing ${real}`))
    }
  })
  await fsp.rmdir(path.dirname(real)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
      sink?.add(
        warningFrom("sidecar-cleanup", error, `removing ${path.dirname(real)}`)
      )
    }
  })
}

export const materializeVirtualDocument = async (
  document: NotebookVirtualDocument,
  worktree: string,
  options?: MaterializeOptions
): Promise<MaterializedDocument> => {
  const sink = makeWarningSink()
  const forward = (): ReadonlyArray<Warning> => {
    const warnings = sink.drain()
    for (const warning of warnings) options?.warningSink?.add(warning)
    return warnings
  }
  try {
    const text = sanitizeNotebookText(document)
    const file = await writeSidecar(worktree, document.filePath, text, sink)
    const warnings = forward()
    return {
      path: file,
      text,
      cells: document.cells.map((cell) => ({
        cellIndex: cell.cellIndex,
        cellType: cell.cellType,
        startLine: cell.startLine + 1,
        endLine: Math.max(cell.startLine + 1, cell.endLine)
      })),
      ...(warnings.length === 0 ? {} : { warnings })
    }
  } catch (error) {
    forward()
    throw error
  }
}

export const refreshMaterializedDocument = async (
  document: NotebookVirtualDocument,
  worktree: string,
  options?: MaterializeOptions
): Promise<boolean> => {
  const existing = await fsp
    .lstat(materializedPath(document.filePath, worktree))
    .catch((error: unknown) => {
      if (!isMissing(error)) {
        options?.warningSink?.add(
          warningFrom(
            "sidecar-cleanup",
            error,
            `inspecting ${materializedPath(document.filePath, worktree)}`
          )
        )
      }
      return undefined
    })
  if (existing === undefined) return false
  await writeSidecar(
    worktree,
    document.filePath,
    sanitizeNotebookText(document),
    options?.warningSink
  )
  return true
}

export const hasMaterializedDocument = async (
  worktree: string,
  filePath: string,
  options?: MaterializeOptions
): Promise<boolean> => {
  const sink = options?.warningSink
  const rootReal = await fsp.realpath(worktree).catch((error: unknown) => {
    if (!isMissing(error)) {
      sink?.add(warningFrom("sidecar-cleanup", error, `resolving ${worktree}`))
    }
    return undefined
  })
  if (rootReal === undefined) return false
  const target = materializedPath(filePath, worktree)
  const targetDirReal = await fsp
    .realpath(path.dirname(target))
    .catch((error: unknown) => {
      if (!isMissing(error)) {
        sink?.add(
          warningFrom(
            "sidecar-cleanup",
            error,
            `resolving ${path.dirname(target)}`
          )
        )
      }
      return undefined
    })
  if (targetDirReal === undefined || !pathInside(rootReal, targetDirReal)) return false
  const stat = await fsp.lstat(target).catch((error: unknown) => {
    if (!isMissing(error)) {
      sink?.add(warningFrom("sidecar-cleanup", error, `inspecting ${target}`))
    }
    return undefined
  })
  return stat !== undefined
}

export const cleanupVirtualDocuments = async (
  worktree: string,
  options?: CleanupOptions
): Promise<void> => {
  const sink = options?.warningSink
  const rootReal = await fsp.realpath(worktree).catch((error: unknown) => {
    if (!isMissing(error)) {
      sink?.add(warningFrom("sidecar-cleanup", error, `resolving ${worktree}`))
    }
    return undefined
  })
  if (rootReal === undefined) return
  const tracked = activeSidecars.get(rootReal)
  if (tracked !== undefined) {
    const snapshot = [...tracked]
    const failed = new Set<string>()
    await Promise.all(
      snapshot.map(async (file) => {
        const parentReal = await fsp
          .realpath(path.dirname(file))
          .catch((error: unknown) => {
            if (!isMissing(error)) {
              sink?.add(
                warningFrom("sidecar-cleanup", error, `resolving ${path.dirname(file)}`)
              )
            }
            return undefined
          })
        if (parentReal === undefined || !pathInside(rootReal, parentReal)) return
        const target = path.join(parentReal, path.basename(file))
        const stat = await fsp.lstat(target).catch((error: unknown) => {
          if (!isMissing(error)) {
            sink?.add(warningFrom("sidecar-cleanup", error, `inspecting ${target}`))
          }
          return undefined
        })
        if (stat === undefined || stat.isDirectory()) return
        const removed = await fsp.rm(target, { force: true }).then(
          () => true,
          (error: unknown) => {
            sink?.add(warningFrom("sidecar-cleanup", error, `removing ${target}`))
            return false
          }
        )
        if (!removed) failed.add(file)
      })
    )
    const latest = activeSidecars.get(rootReal) ?? tracked
    for (const file of snapshot) {
      if (!failed.has(file)) latest.delete(file)
    }
    if (latest.size === 0) activeSidecars.delete(rootReal)
  }
  await cleanupLegacyDirectory(rootReal, sink)
}
