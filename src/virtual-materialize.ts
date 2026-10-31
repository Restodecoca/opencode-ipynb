import { createHash, randomBytes } from "node:crypto"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import { replaceFile } from "./utils/atomic-replace.js"
import * as path from "node:path"
import type { NotebookVirtualDocument } from "./lsp.js"
import { sanitizeNotebookText } from "./notebook-diagnostics.js"

export interface MaterializedCell {
  readonly cellIndex: number
  readonly cellType: string
  /** First line in the materialized file, 1-based and inclusive. */
  readonly startLine: number
  /** Last line in the materialized file, 1-based and inclusive. */
  readonly endLine: number
}

export interface MaterializedDocument {
  readonly path: string
  readonly text: string
  readonly cells: ReadonlyArray<MaterializedCell>
}

// The sidecar lives next to the notebook, not in a session-level cache:
// pyright resolves sibling imports relative to the analyzed file's directory.
// A visible (non-dot) filename is required because pyright excludes dotfiles
// by default.
const SIDECAR_PREFIX = "opencode-ipynb-lsp-"
const LEGACY_DIRECTORY = ".opencode/ipynb-lsp"
const LEGACY_FILE = /\.[0-9a-f]{16}\.py$/
const MAX_AGE_MS = 60 * 60 * 1000

const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

const realPath = (filePath: string): string => {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return filePath
  }
}

const hashFor = (filePath: string): string =>
  createHash("sha256").update(realPath(filePath)).digest("hex").slice(0, 16)

const fileNameFor = (filePath: string): string =>
  `${SIDECAR_PREFIX}${hashFor(filePath)}.py`

/** Path of the materialized sidecar for a notebook. */
export const materializedPath = (filePath: string, root?: string): string => {
  const realFile = realPath(filePath)
  if (root !== undefined) {
    const rootReal = realPath(root)
    if (inside(rootReal, realFile)) {
      const lexicalRoot = path.resolve(root)
      const relative = path.relative(rootReal, realFile)
      return path.join(lexicalRoot, path.dirname(relative), fileNameFor(filePath))
    }
  }
  const lexicalDir = path.dirname(path.resolve(filePath))
  const realDir = path.dirname(realFile)
  // If the lexical directory is a symlinked session root, keep the lexical
  // path: the external lsp tool checks `within(root, file)` lexically before
  // resolving. Otherwise (a symlinked notebook file) use the real directory
  // so pyright can resolve sibling imports.
  try {
    if (fs.realpathSync(lexicalDir) === realDir) {
      return path.join(lexicalDir, fileNameFor(filePath))
    }
  } catch {
    // fall through to the real directory
  }
  return path.join(realDir, fileNameFor(filePath))
}

// Files created by this process, scoped by the worktree used to materialize
// them. Unloading one project must not untrack another project's sidecar; old
// files from a crashed process are overwritten by the next materialize.
const activeSidecars = new Map<string, Set<string>>()

const writeSidecar = async (
  worktree: string,
  filePath: string,
  text: string
): Promise<string> => {
  const rootReal = await fsp.realpath(worktree)
  const target = materializedPath(filePath, worktree)
  const directoryReal = await fsp.realpath(path.dirname(target))
  if (!inside(rootReal, directoryReal)) {
    throw new Error(`Refusing to write outside the session directory: ${target}`)
  }
  const safeTarget = path.join(directoryReal, path.basename(target))
  const temp = path.join(
    directoryReal,
    `${SIDECAR_PREFIX}${randomBytes(6).toString("hex")}.tmp`
  )
  try {
    await fsp.writeFile(temp, text, { encoding: "utf8", flag: "wx", mode: 0o600 })
    const existing = await fsp.lstat(safeTarget).catch(() => undefined)
    if (existing?.isDirectory()) {
      throw new Error(`Refusing to replace a directory: ${safeTarget}`)
    }
    // Rename is atomic on POSIX and replaces the target. A pre-existing
    // symlink is replaced, never followed. The Windows fallback keeps a
    // backup instead of deleting the original first.
    await replaceFile(temp, safeTarget)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw error
  }
  const tracked = activeSidecars.get(rootReal) ?? new Set<string>()
  tracked.add(safeTarget)
  activeSidecars.set(rootReal, tracked)
  return target
}

const cleanupLegacyDirectory = async (rootReal: string): Promise<void> => {
  const directory = path.join(rootReal, LEGACY_DIRECTORY)
  const stat = await fsp.lstat(directory).catch(() => undefined)
  if (stat === undefined) return
  if (stat.isSymbolicLink()) {
    await fsp.rm(directory, { force: true })
    return
  }
  const real = await fsp.realpath(directory).catch(() => undefined)
  if (real === undefined || !inside(rootReal, real)) {
    throw new Error(`Refusing to clean a materialized directory outside the worktree`)
  }
  const now = Date.now()
  const entries = await fsp.readdir(real, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          (LEGACY_FILE.test(entry.name) || entry.name.endsWith(".tmp"))
      )
      .map(async (entry) => {
        const file = path.join(real, entry.name)
        const info = await fsp.stat(file).catch(() => undefined)
        if (info !== undefined && now - info.mtimeMs > MAX_AGE_MS) {
          await fsp.rm(file, { force: true }).catch(() => {})
        }
      })
  )
  await fsp.rmdir(real).catch(() => {})
  await fsp.rmdir(path.dirname(real)).catch(() => {})
}

/**
 * Write the notebook's virtual Python document beside the notebook so an
 * external LSP plugin can open it with its own `lsp` tool. The path must stay
 * inside the session/worktree (opencode-v2-lsp-support rejects paths outside
 * its root), and living next to the notebook lets pyright resolve sibling
 * imports exactly like the notebook itself.
 *
 * IPython magics are blanked exactly like the diagnostics path, preserving
 * line/column positions so hover and definitions still map to cells.
 */
export const materializeVirtualDocument = async (
  document: NotebookVirtualDocument,
  worktree: string
): Promise<MaterializedDocument> => {
  const text = sanitizeNotebookText(document)
  const file = await writeSidecar(worktree, document.filePath, text)
  return {
    path: file,
    text,
    cells: document.cells.map((cell) => ({
      cellIndex: cell.cellIndex,
      cellType: cell.cellType,
      startLine: cell.startLine + 1,
      endLine: Math.max(cell.startLine + 1, cell.endLine)
    }))
  }
}

/**
 * Refresh an already materialized document after an edit. Does nothing until
 * the notebook has been materialized at least once.
 */
export const refreshMaterializedDocument = async (
  document: NotebookVirtualDocument,
  worktree: string
): Promise<boolean> => {
  const existing = await fsp
    .lstat(materializedPath(document.filePath, worktree))
    .catch(() => undefined)
  if (existing === undefined) return false
  await writeSidecar(worktree, document.filePath, sanitizeNotebookText(document))
  return true
}

/** True when this notebook already has a materialized sidecar. */
export const hasMaterializedDocument = async (
  worktree: string,
  filePath: string
): Promise<boolean> => {
  const rootReal = await fsp.realpath(worktree).catch(() => undefined)
  if (rootReal === undefined) return false
  const target = materializedPath(filePath, worktree)
  const targetDirReal = await fsp
    .realpath(path.dirname(target))
    .catch(() => undefined)
  if (targetDirReal === undefined || !inside(rootReal, targetDirReal)) return false
  const stat = await fsp.lstat(target).catch(() => undefined)
  return stat !== undefined
}

/** Remove only this plugin's materialized documents. */
export const cleanupVirtualDocuments = async (worktree: string): Promise<void> => {
  const rootReal = await fsp.realpath(worktree).catch(() => undefined)
  if (rootReal === undefined) return
  const tracked = activeSidecars.get(rootReal)
  if (tracked !== undefined) {
    await Promise.all(
      [...tracked].map(async (file) => {
        // Resolve the parent immediately before removing: a directory can be
        // replaced by a symlink after materialization, and rm would follow it.
        const parentReal = await fsp
          .realpath(path.dirname(file))
          .catch(() => undefined)
        if (parentReal === undefined || !inside(rootReal, parentReal)) return
        const target = path.join(parentReal, path.basename(file))
        const stat = await fsp.lstat(target).catch(() => undefined)
        if (stat !== undefined && !stat.isDirectory()) {
          await fsp.rm(target, { force: true }).catch(() => {})
        }
      })
    )
    activeSidecars.delete(rootReal)
  }
  await cleanupLegacyDirectory(rootReal)
}
