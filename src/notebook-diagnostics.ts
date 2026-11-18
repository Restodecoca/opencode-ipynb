import { spawn } from "node:child_process"
import { killWindowsTree } from "./utils/windows.js"
import { StringDecoder } from "node:string_decoder"
import { sanitizeInline } from "./utils/markdown-safe.js"
import { createHash } from "node:crypto"
import { constants as fsConstants, realpathSync } from "node:fs"
import * as os from "node:os"
import * as fs from "node:fs"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import {
  cellsAroundIndex,
  toCellPosition,
  type NotebookVirtualDocument
} from "./lsp.js"
import { PermissionDeniedError } from "./domain/errors.js"
import { type Warning, type WarningSink, warningFrom } from "./utils/warnings.js"

const MAX_ERRORS = 20

export interface NotebookDiagnostic {
  readonly cellIndex: number
  readonly line: number
  readonly character: number
  readonly endLine: number
  readonly endCharacter: number
  readonly severity: "error"
  readonly message: string
  readonly rule?: string
}

export interface NotebookDiagnosticsOptions {
  readonly filePath: string
  readonly document: NotebookVirtualDocument
  readonly displayPath?: string
  readonly where?: string
  readonly tempFilePath?: string
  readonly ownedTempFile?: boolean
  readonly requestFallbackPermission?: () => Promise<void>
  readonly pythonPath?: string
  readonly pyrightPath?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly warningSink?: WarningSink
}

export interface NotebookDiagnosticsResult {
  readonly filePath: string
  readonly diagnostics: ReadonlyArray<NotebookDiagnostic>
  readonly text: string
  readonly warnings?: ReadonlyArray<Warning>
  readonly skipped?:
    | "pyright-not-found"
    | "timeout"
    | "aborted"
    | "invalid-output"
    | "not-analyzed"
    | "temp-unwritable"
    | "pyright-not-executable"
}

class TempFileError extends Error {}

const isMissingPath = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

interface PyrightDiagnostic {
  readonly file: string
  readonly severity?: string
  readonly message: string
  readonly rule?: string
  readonly range: {
    readonly start: { readonly line: number; readonly character: number }
    readonly end?: { readonly line: number; readonly character: number }
  }
}

interface PyrightOutput {
  readonly generalDiagnostics?: ReadonlyArray<PyrightDiagnostic>
  readonly summary?: {
    readonly filesAnalyzed?: number
    readonly errorCount?: number
  }
}

const PYTHON_CELL_MAGICS = new Set([
  "time",
  "capture",
  "prun",
  "timeit",
  "debug",
  "python",
  "python3",
  "py"
])

export const sanitizeNotebookText = (document: NotebookVirtualDocument): string => {
  const lines = document.text.split("\n")
  for (const cell of document.cells) {
    const first = lines[cell.startLine] ?? ""
    const magic = /^\s*%%([A-Za-z_][\w-]*)/.exec(first)?.[1]?.toLowerCase()
    const blankWhole = magic !== undefined && !PYTHON_CELL_MAGICS.has(magic)
    const replaceWithPass = (current: string): string => {
      const indent = /^\s*/.exec(current)?.[0] ?? ""
      return (indent + "pass").padEnd(current.length, " ")
    }
    for (let line = cell.startLine; line < cell.endLine; line++) {
      const current = lines[line]
      if (current === undefined) continue
      if (
        blankWhole ||
        /^\s*[%!]/.test(current) ||
        /^\s*[^=#]+=\s*[%!]/.test(current)
      ) {
        lines[line] = blankWhole
          ? "pass".padEnd(current.length, " ")
          : replaceWithPass(current)
        continue
      }
      const code = stripPythonComment(current)
      if (
        /^(\s*)\?{1,2}/.test(code) ||
        /\?{1,2}\s*$/.test(code.trimEnd())
      ) {
        lines[line] = replaceWithPass(current)
      }
    }
  }
  return lines.join("\n")
}

const runPyright = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  shell = false
): Promise<{
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  aborted: boolean
}> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", code: null, timedOut: false, aborted: true })
      return
    }
    const detached = process.platform !== "win32"
    let spawnCommand = command
    let spawnArgs: string[] = [...args]
    let useShell = shell
    let verbatim = false
    if (shell && process.platform === "win32") {
      const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`
      spawnCommand = process.env.ComSpec ?? "cmd.exe"
      spawnArgs = [
        "/d",
        "/s",
        "/c",
        `"${[command, ...args].map(quote).join(" ")}"`
      ]
      useShell = false
      verbatim = true
    }
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      windowsHide: true,
      detached,
      shell: useShell,
      windowsVerbatimArguments: verbatim,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    let stdoutBytes = 0
    let stderrBytes = 0
    const decoder = new StringDecoder("utf8")
    const stderrDecoder = new StringDecoder("utf8")
    let timedOut = false
    let aborted = false
    let settled = false
    let exitCode: number | null = null
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      resolve({
        stdout: stdout + decoder.end(),
        stderr: stderr + stderrDecoder.end(),
        code: exitCode,
        timedOut,
        aborted
      })
    }
    const killTree = () => {
      if (child.pid === undefined) return
      if (process.platform === "win32") {
        killWindowsTree(child.pid)
      } else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {
          child.kill("SIGKILL")
        }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    const onAbort = () => {
      aborted = true
      killTree()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= 8 * 1024 * 1024) return
      const take = chunk.subarray(0, 8 * 1024 * 1024 - stdoutBytes)
      stdoutBytes += take.length
      stdout += decoder.write(take)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 4_000) return
      const take = chunk.subarray(0, 4_000 - stderrBytes)
      stderrBytes += take.length
      stderr += stderrDecoder.write(take)
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(error)
    })
    child.on("exit", (code) => {
      exitCode = code
      setTimeout(finish, 50)
    })
    child.on("close", (code) => {
      exitCode = code
      finish()
    })
  })

const formatDiagnostics = (
  diagnostics: ReadonlyArray<NotebookDiagnostic>,
  where: string,
  file: string
): string => {
  if (diagnostics.length === 0) return ""
  const lines = diagnostics.slice(0, MAX_ERRORS).map((diagnostic) => {
    const message =
      diagnostic.message.length > 2_000
        ? `${diagnostic.message.slice(0, 2_000)}... (truncated)`
        : diagnostic.message
    const safe = message
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
    return `ERROR [cell ${diagnostic.cellIndex}, line ${diagnostic.line + 1}:${diagnostic.character + 1}] ${safe}`
  })
  const more = diagnostics.length - MAX_ERRORS
  if (more > 0) lines.push(`... and ${more} more`)
  const escapedFile = sanitizeInline(file)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
  return `LSP errors detected in ${sanitizeInline(where)}, please fix:\n<diagnostics file="${escapedFile}">\n${lines.join("\n")}\n</diagnostics>`
}



const findOnPath = (name: string): string | undefined => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const names =
    process.platform === "win32" && !/\.[a-z0-9]+$/i.test(name)
      ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
      : [name]
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) continue
    const dirAbs = dir
    for (const candidateName of names) {
      const candidate = path.join(dirAbs, candidateName)
      try {
        if (!fs.statSync(candidate).isFile()) continue
        if (process.platform !== "win32") {
          fs.accessSync(candidate, fsConstants.X_OK)
        }
        return candidate
      } catch {
      }
    }
  }
  return undefined
}

export const resolvePyrightCommand = (
  configured: string | undefined
): { readonly command: string; readonly shell: boolean } => {
  const defaultName = configured === undefined || configured === "pyright"
  const requested = defaultName
    ? process.platform === "win32"
      ? "pyright.cmd"
      : "pyright"
    : configured
  if (!path.isAbsolute(requested) && /[\\/]/.test(requested)) {
    throw new Error(
      "pyrightPath must be absolute or a bare command name resolved through PATH"
    )
  }
  const resolved = path.isAbsolute(requested)
    ? requested
    : findOnPath(defaultName ? "pyright" : requested)
  if (resolved === undefined) {
    throw new Error(
      `pyright executable "${requested}" was not found on an absolute PATH entry`
    )
  }
  const command = resolved
  return {
    command,
    shell:
      process.platform === "win32" &&
      resolved !== undefined &&
      /\.(cmd|bat)$/i.test(command)
  }
}

const pyrightAvailability = new Map<string, { at: number; ok: boolean }>()
const PYRIGHT_AVAILABILITY_TTL_MS = 60_000

export interface PyrightAvailabilityOptions {
  readonly warningSink?: WarningSink | undefined
}

export const isPyrightAvailable = async (
  configured: string | undefined,
  timeoutMs = 5_000,
  signal?: AbortSignal,
  options?: PyrightAvailabilityOptions
): Promise<boolean> => {
  const sink = options?.warningSink
  if (configured !== undefined && path.isAbsolute(configured)) {
    try {
      if (!fs.statSync(configured).isFile()) {
        sink?.add(
          warningFrom(
            "python-probe",
            new Error("the configured pyright path is not a file"),
            `pyrightPath=${configured}`
          )
        )
        return false
      }
      if (process.platform !== "win32") {
        fs.accessSync(configured, fsConstants.X_OK)
      }
      return true
    } catch (error) {
      sink?.add(
        warningFrom("python-probe", error, `pyrightPath=${configured}`)
      )
      return false
    }
  }
  let command: string
  let shell: boolean
  try {
    const resolved = resolvePyrightCommand(configured)
    command = resolved.command
    shell = resolved.shell
  } catch (error) {
    if (configured !== undefined && configured !== "pyright") {
      sink?.add(
        warningFrom("python-probe", error, `pyrightPath=${configured}`)
      )
    }
    return false
  }
  const key = `${command}:${shell ? "shell" : "direct"}`
  const cached = pyrightAvailability.get(key)
  if (cached !== undefined && Date.now() - cached.at < PYRIGHT_AVAILABILITY_TTL_MS) {
    return cached.ok
  }
  let ok = false
  let cacheable = true
  try {
    const outcome = await runPyright(
      command,
      ["--version"],
      process.cwd(),
      timeoutMs,
      signal,
      shell
    )
    ok = outcome.code === 0 && !outcome.timedOut && !outcome.aborted
    if (outcome.timedOut || outcome.aborted) cacheable = false
  } catch {
    ok = false
  }
  if (cacheable) pyrightAvailability.set(key, { at: Date.now(), ok })
  return ok
}

const diagnosticHash = (filePath: string): string => {
  let real = path.resolve(filePath)
  try {
    real = realpathSync(filePath)
  } catch {
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 16)
}

const realFilePath = (filePath: string): string => {
  try {
    return realpathSync(filePath)
  } catch {
    return filePath
  }
}

export const diagnosticTempPath = (filePath: string): string =>
  path.join(
    path.dirname(realFilePath(filePath)),
    `opencode-ipynb-diag-${diagnosticHash(filePath)}.py`
  )

export const diagnosticFallbackTempPath = (filePath: string): string =>
  path.join(
    os.tmpdir(),
    `opencode-ipynb-diag-${diagnosticHash(filePath)}.py`
  )

const diagnosticLocks = new Map<string, Promise<void>>()

const withDiagnosticLock = async <T>(
  key: string,
  task: () => Promise<T>
): Promise<T> => {
  const previous = diagnosticLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(
    () => gate,
    () => gate
  )
  diagnosticLocks.set(key, tail)
  await previous.catch(() => {})
  try {
    return await task()
  } finally {
    release()
    const cleanup = (): void => {
      if (diagnosticLocks.get(key) === tail) diagnosticLocks.delete(key)
    }
    void tail.then(cleanup, cleanup)
  }
}

const stripPythonComment = (line: string): string => {
  let quote: string | undefined
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "#") return line.slice(0, i)
  }
  return line
}

const lastSignificantLine = (
  source: string
): { readonly text: string; readonly index: number } | undefined => {
  const lines = source.split("\n")
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = stripPythonComment(lines[index]!).trimEnd()
    if (text.trim().length > 0) return { text, index }
  }
  return undefined
}

const endsWithOpenConstruct = (source: string): boolean => {
  const last = lastSignificantLine(source)?.text ?? ""
  return last.endsWith(":") || last.endsWith("\\") || /[([{]$/.test(last)
}

const remapCellBoundary = (
  document: NotebookVirtualDocument,
  position: { cellIndex: number; line: number; character: number },
  rule?: string
): { cellIndex: number; line: number; character: number } => {
  if (rule !== undefined) return position
  if (
    position.line !== 0 ||
    position.character !== 0 ||
    position.cellIndex === 0
  ) {
    return position
  }
  const around = cellsAroundIndex(document, position.cellIndex)
  if (around === undefined) return position
  const previous = around.previous
  if (previous === undefined || previous.endLine !== around.current.startLine) {
    return position
  }
  if (endsWithOpenConstruct(previous.text)) {
    const last = lastSignificantLine(previous.text)
    return {
      cellIndex: previous.cellIndex,
      line: last?.index ?? 0,
      character: 0
    }
  }
  return position
}

export const diagnoseNotebook = async (
  options: NotebookDiagnosticsOptions
): Promise<NotebookDiagnosticsResult> => {
  const { filePath, document } = options
  if (options.signal?.aborted) {
    return { filePath, diagnostics: [], text: "", skipped: "aborted" }
  }
  const collected: Warning[] = []
  const record = (warning: Warning): void => {
    collected.push(warning)
    options.warningSink?.add(warning)
  }
  let resolvedFile = filePath
  try {
    resolvedFile = realpathSync(filePath)
  } catch (error) {
    record(warningFrom("path-resolution", error, `resolving ${filePath}`))
  }
  const directory = path.dirname(resolvedFile)
  const explicitTemp = options.tempFilePath
  const owned = options.ownedTempFile === true || explicitTemp === undefined
  let tempFile = explicitTemp ?? diagnosticTempPath(filePath)
  const result: NotebookDiagnosticsResult = await withDiagnosticLock(tempFile, async () => {
    if (options.signal?.aborted) {
      return { filePath, diagnostics: [], text: "", skipped: "aborted" as const }
    }
    const closeHandle = async (
      handle: Awaited<ReturnType<typeof fsp.open>>,
      file: string
    ): Promise<void> => {
      await handle.close().catch((error: unknown) => {
        record(warningFrom("temp-unlink", error, `closing ${file}`))
      })
    }
    const openTemp = async (file: string): Promise<void> => {
      if (!owned) {
        const existing = await fsp.lstat(file).catch((error: unknown) => {
          if (!isMissingPath(error)) {
            record(warningFrom("path-resolution", error, `inspecting ${file}`))
          }
          return undefined
        })
        if (existing !== undefined) {
          throw new Error(`refusing to overwrite caller-supplied temp file: ${file}`)
        }
        try {
          await fsp.writeFile(file, text, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600
          })
        } catch (error) {
          await fsp.rm(file, { force: true }).catch((cleanupError: unknown) => {
            record(warningFrom("temp-unlink", cleanupError, `left ${file}`))
          })
          throw error
        }
        return
      }
      const existing = await fsp.lstat(file).catch((error: unknown) => {
        if (!isMissingPath(error)) {
          record(warningFrom("path-resolution", error, `inspecting ${file}`))
        }
        return undefined
      })
      if (existing?.isSymbolicLink()) {
        throw new TempFileError(`refusing to follow a symlink at ${file}`)
      }
      if (existing !== undefined && !existing.isFile()) {
        throw new TempFileError(`refusing to open a non-regular temp file at ${file}`)
      }
      if (existing !== undefined && existing.nlink > 1) {
        throw new TempFileError(`refusing to open a hardlinked temp file at ${file}`)
      }
      if (existing !== undefined) {
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined
        if (uid !== undefined && existing.uid !== uid) {
          throw new TempFileError(`refusing a temp file owned by another user: ${file}`)
        }
        if (process.platform !== "win32" && (existing.mode & 0o077) !== 0) {
          throw new TempFileError(`refusing a group/world-readable temp file: ${file}`)
        }
      }
      const noFollow =
        process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW
      const nonBlock =
        process.platform === "win32" ? 0 : fsConstants.O_NONBLOCK
      const handle = await fsp.open(
        file,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          noFollow |
          nonBlock,
        0o600
      )
      try {
        const opened = await handle.stat()
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined
        if (!opened.isFile() || opened.nlink > 1) {
          await closeHandle(handle, file)
          throw new TempFileError(`refusing to write a linked/non-regular temp file at ${file}`)
        }
        if (
          (uid !== undefined && opened.uid !== uid) ||
          (process.platform !== "win32" &&
            existing !== undefined &&
            (opened.mode & 0o077) !== 0)
        ) {
          await closeHandle(handle, file)
          throw new TempFileError(`refusing a temp file with unsafe ownership/mode: ${file}`)
        }
        await handle.truncate(0)
        await handle.writeFile(text, "utf8")
      } catch (error) {
        await closeHandle(handle, file)
        await fsp.rm(file, { force: true }).catch((cleanupError: unknown) => {
          record(warningFrom("temp-unlink", cleanupError, `left ${file}`))
        })
        throw error
      }
      await handle.close()
    }

    const text = sanitizeNotebookText(document)
    let wroteTemp = false
    try {
      try {
        await openTemp(tempFile)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const recoverable =
          owned &&
          (code === "EACCES" || code === "EPERM" || code === "EROFS" || code === "ENOENT")
        if (!recoverable) {
          throw new TempFileError(
            error instanceof Error ? error.message : String(error)
          )
        }
        if (options.requestFallbackPermission !== undefined) {
          await options.requestFallbackPermission()
        }
        tempFile = diagnosticFallbackTempPath(filePath)
        try {
          await openTemp(tempFile)
        } catch (fallbackError) {
          throw fallbackError instanceof TempFileError
            ? fallbackError
            : new TempFileError(
                fallbackError instanceof Error
                  ? fallbackError.message
                  : String(fallbackError)
              )
        }
      }
      wroteTemp = true
      let command: string
      let shell: boolean
      try {
        const resolved = resolvePyrightCommand(options.pyrightPath)
        command = resolved.command
        shell = resolved.shell
      } catch {
        return {
          filePath,
          diagnostics: [],
          text: "",
          skipped: "pyright-not-found"
        }
      }
      const args = ["--outputjson"]
      const pythonPath = options.pythonPath
      if (pythonPath !== undefined && pythonPath.length > 0) {
        args.push("--pythonpath", pythonPath)
      }
      args.push(tempFile)
      const outcome = await runPyright(
        command,
        args,
        directory,
        options.timeoutMs ?? 15_000,
        options.signal,
        shell
      )
      if (outcome.aborted) {
        return { filePath, diagnostics: [], text: "", skipped: "aborted" }
      }
      if (outcome.timedOut) {
        return { filePath, diagnostics: [], text: "", skipped: "timeout" }
      }
      if (outcome.code !== null && outcome.code > 1) {
        return { filePath, diagnostics: [], text: "", skipped: "invalid-output" }
      }
      let parsed: PyrightOutput
      try {
        parsed = JSON.parse(outcome.stdout) as PyrightOutput
      } catch {
        return { filePath, diagnostics: [], text: "", skipped: "invalid-output" }
      }
      const analyzed = parsed.summary?.filesAnalyzed
      if (typeof analyzed === "number" && analyzed === 0) {
        return { filePath, diagnostics: [], text: "", skipped: "not-analyzed" }
      }
      if (process.env.OPENCODE_IPYNB_DIAG_DEBUG === "1") {
        console.error("[opencode-ipynb] pyright output", outcome.stdout.slice(0, 4_000))
        console.error("[opencode-ipynb] pyright stderr", outcome.stderr.slice(0, 4_000))
        console.error("[opencode-ipynb] pyright temp file", tempFile)
      }
      const diagnostics: NotebookDiagnostic[] = []
      for (const item of parsed.generalDiagnostics ?? []) {
        if (item.severity !== undefined && item.severity !== "error") continue
        const itemPath = path.isAbsolute(item.file)
          ? item.file
          : path.resolve(directory, item.file)
        if (itemPath !== path.resolve(tempFile)) continue
        const rawMapped = toCellPosition(
          document,
          item.range.start.line,
          item.range.start.character
        )
        if (!rawMapped) continue
        const mapped = remapCellBoundary(document, rawMapped, item.rule)
        const mappedEnd =
          item.range.end === undefined
            ? undefined
            : toCellPosition(
                document,
                item.range.end.line,
                item.range.end.character
              )
        const end =
          mappedEnd !== undefined && mappedEnd.cellIndex === mapped.cellIndex
            ? mappedEnd
            : { line: mapped.line, character: mapped.character + 1 }
        diagnostics.push({
          cellIndex: mapped.cellIndex,
          line: mapped.line,
          character: mapped.character,
          endLine: end.line,
          endCharacter: end.character,
          severity: "error",
          message:
            item.message.length > 2_000
              ? `${item.message.slice(0, 2_000)}... (truncated)`
              : item.message,
          ...(item.rule === undefined ? {} : { rule: item.rule.slice(0, 200) })
        })
      }
      if (
        diagnostics.length === 0 &&
        /config[\s\S]{0,120}(error|must|invalid|unrecognized|unsupported)/i.test(
          outcome.stderr
        )
      ) {
        return { filePath, diagnostics: [], text: "", skipped: "invalid-output" }
      }
      const displayPath = options.displayPath ?? filePath
      return {
        filePath,
        diagnostics,
        text: formatDiagnostics(diagnostics, options.where ?? displayPath, filePath)
      }
    } catch (error) {
      if (error instanceof PermissionDeniedError) throw error
      const code = (error as NodeJS.ErrnoException).code
      return {
        filePath,
        diagnostics: [],
        text: "",
        skipped:
          error instanceof TempFileError
            ? "temp-unwritable"
            : code === "ENOENT"
              ? "pyright-not-found"
              : code === "EACCES" || code === "EPERM" || code === "EROFS"
                ? "pyright-not-executable"
                : "invalid-output"
      }
    } finally {
      if (wroteTemp) {
        await fsp.rm(tempFile, { force: true }).catch((error: unknown) => {
          record(warningFrom("temp-unlink", error, `left ${tempFile}`))
        })
      }
    }
  })
  return collected.length === 0 ? result : { ...result, warnings: collected }
}
