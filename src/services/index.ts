import type { ToolContext } from "../tool.js"
import { Effect } from "effect"
import {
  PluginOptionsSchema,
  parsePluginOptions,
  resolvePythonPath,
  type PluginOptions
} from "../plugin-options.js"
import { makePathService, type PathServiceShape } from "./PathService.js"
import { makePermissionService, type PermissionServiceShape } from "./PermissionService.js"
import { makeNotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { makeInspectImpl } from "./NotebookInspectService.js"
import { makeReadImpl, type NotebookReadServiceShape } from "./NotebookReadService.js"
import { makeEditImpl, type NotebookEditServiceShape } from "./NotebookEditService.js"
import { makeCleanImpl, type NotebookCleanServiceShape } from "./NotebookCleanService.js"
import { makeOutputImpl, type NotebookOutputServiceShape } from "./NotebookOutputService.js"
import { makeExportImpl, type NotebookExportServiceShape } from "./NotebookExportService.js"
import { makeExecutionImpl, type NotebookExecutionServiceShape } from "./NotebookExecutionService.js"
import { makePythonService, type PythonServiceShape } from "./PythonService.js"
import { makeKernelManager, type KernelManagerShape } from "./KernelManager.js"
import type { WarningSink } from "../utils/warnings.js"

export { type PathServiceShape, type PathEnv, makePathService } from "./PathService.js"
export { type PermissionServiceShape, type PermissionRequest, type PermissionKind, makePermissionService } from "./PermissionService.js"
export { type NotebookFileServiceShape, makeNotebookFileService } from "./NotebookFileService.js"
export { makeInspectImpl } from "./NotebookInspectService.js"
export { type NotebookReadServiceShape, makeReadImpl } from "./NotebookReadService.js"
export { type NotebookEditServiceShape, makeEditImpl } from "./NotebookEditService.js"
export { type NotebookCleanServiceShape, makeCleanImpl } from "./NotebookCleanService.js"
export { type NotebookOutputServiceShape, makeOutputImpl } from "./NotebookOutputService.js"
export { type NotebookExportServiceShape, makeExportImpl } from "./NotebookExportService.js"
export { type NotebookExecutionServiceShape, makeExecutionImpl } from "./NotebookExecutionService.js"
export {
  type PythonServiceShape,
  type PythonDoctor,
  type PythonProbeResult,
  type DependencyCheck,
  type PythonServiceOptions,
  makePythonService
} from "./PythonService.js"
export {
  type KernelManagerShape,
  type KernelInfo,
  type KernelManagerStats,
  type KernelManagerOptions,
  type KernelRuntimeOptions,
  makeKernelManager
} from "./KernelManager.js"

export interface NotebookServices {
  readonly path: PathServiceShape
  readonly permission: PermissionServiceShape
  readonly file: NotebookFileServiceShape
  readonly python: PythonServiceShape
  readonly kernel: KernelManagerShape
  readonly pythonPath: string | undefined
  readonly pythonPathError: string | undefined
  readonly envOptionsError: string | undefined
  readonly inspect: ReturnType<typeof makeInspectImpl>
  readonly read: NotebookReadServiceShape
  readonly edit: NotebookEditServiceShape
  readonly clean: NotebookCleanServiceShape
  readonly output: NotebookOutputServiceShape
  readonly export: NotebookExportServiceShape
  readonly execution: NotebookExecutionServiceShape
}

const sharedPythonServices = new Map<string, PythonServiceShape>()

const getOrCreatePythonService = (opts: {
  readonly pythonPath: string | undefined
  readonly preferUv: boolean
  readonly helperRelativePath: string
  readonly pythonSource?: "options" | "env" | undefined
}): PythonServiceShape => {
  const key = JSON.stringify([
    opts.pythonPath ?? "",
    opts.preferUv,
    opts.helperRelativePath,
    opts.pythonSource ?? ""
  ])
  const existing = sharedPythonServices.get(key)
  if (existing) return existing
  const service = makePythonService(opts)
  sharedPythonServices.set(key, service)
  return service
}

const defaultKernelScope = {}
const sharedKernelManagers = new Map<object, Map<string, KernelManagerShape>>()

const getOrCreateSharedKernelManager = (
  opts: {
    readonly pythonPath: string | undefined
    readonly helperPath: string
    readonly workingDirectory: string
    readonly defaultTimeoutMs: number
    readonly warningSink?: WarningSink | undefined
  },
  scope?: object
): KernelManagerShape => {
  const owner = scope ?? defaultKernelScope
  let managers = sharedKernelManagers.get(owner)
  if (!managers) {
    managers = new Map()
    sharedKernelManagers.set(owner, managers)
  }
  const key = JSON.stringify([
    opts.pythonPath ?? "",
    opts.helperPath,
    opts.workingDirectory,
    opts.defaultTimeoutMs
  ])
  const existing = managers.get(key)
  if (existing) {
    if (opts.warningSink !== undefined) existing.setWarningSink?.(opts.warningSink)
    return existing
  }
  const sinkTarget: { sink?: WarningSink | undefined } = { sink: opts.warningSink }
  const manager = makeKernelManager({
    pythonPath: opts.pythonPath ?? "python",
    helperPath: opts.helperPath,
    workingDirectory: opts.workingDirectory,
    defaultTimeoutMs: opts.defaultTimeoutMs,
    sinkTarget
  })
  managers.set(key, manager)
  return manager
}

export const disposeSharedKernelManager = async (scope?: object): Promise<void> => {
  const owners =
    scope === undefined ? [...sharedKernelManagers.keys()] : [scope]
  const managers = owners.flatMap((owner) => {
    const owned = sharedKernelManagers.get(owner)
    if (!owned) return []
    sharedKernelManagers.delete(owner)
    return [...owned.values()]
  })
  await Promise.all(managers.map((manager) => Effect.runPromise(manager.disposeAll())))
}

export interface BuildServicesOptions {
  readonly warningSink?: WarningSink | undefined
}

export const buildServices = (
  ctx: ToolContext,
  options: BuildServicesOptions = {}
): NotebookServices => {
  const resolved = resolveOptionsFromEnv(ctx.pluginOptions)
  const envOptionsErrorMessage = envOptionsError
  const warningSink = options.warningSink
  const pathSvc: PathServiceShape = makePathService({
    directory: ctx.directory,
    worktree: ctx.worktree,
    platform: process.platform,
    allowOutsideWorktree: resolved.allowOutsideWorktree,
    warningSink
  })
  const permissionSvc: PermissionServiceShape = makePermissionService(ctx, {
    warningSink
  })
  const fileSvc: NotebookFileServiceShape = makeNotebookFileService({
    ...(resolved.allowOutsideWorktree ? {} : { worktree: ctx.worktree }),
    warningSink,
    signal: ctx.abort
  })
  let pythonPath: string | undefined
  let pythonPathError: string | undefined
  try {
    pythonPath = resolvePythonPath(resolved)
  } catch (error) {
    pythonPathError =
      error instanceof Error ? error.message : String(error)
    pythonPath = undefined
  }
  const envPython = process.env.OPENCODE_IPYNB_PYTHON
  const pythonSource =
    envPython !== undefined && envPython === pythonPath
      ? "env"
      : resolved.pythonPath !== undefined
        ? "options"
        : undefined
  const pythonSvc: PythonServiceShape = getOrCreatePythonService({
    pythonPath,
    preferUv: resolved.preferUv,
    helperRelativePath: resolved.helperRelativePath,
    pythonSource
  })
  const kernelMgr: KernelManagerShape = getOrCreateSharedKernelManager(
    {
      pythonPath,
      helperPath: resolved.helperRelativePath,
      workingDirectory: ctx.directory,
      defaultTimeoutMs: resolved.defaultTimeoutMs,
      warningSink
    },
    ctx.pluginScope
  )
  const inspectSvc = makeInspectImpl(pathSvc, fileSvc)
  const readSvc = makeReadImpl(pathSvc, fileSvc)
  const editSvc = makeEditImpl(pathSvc, fileSvc, permissionSvc)
  const cleanSvc = makeCleanImpl(pathSvc, fileSvc, permissionSvc)
  const outputSvc = makeOutputImpl(pathSvc, fileSvc, permissionSvc)
  const exportSvc = makeExportImpl(pathSvc, fileSvc, permissionSvc)
  const executionSvc = makeExecutionImpl(pathSvc, fileSvc, permissionSvc, pythonSvc, {
    kernelManager: kernelMgr,
    warmKernel: resolved.warmKernel,
    defaultTimeoutMs: resolved.defaultTimeoutMs,
    ...(pythonPath === undefined ? {} : { pythonPath })
  })
  return {
    path: pathSvc,
    permission: permissionSvc,
    file: fileSvc,
    python: pythonSvc,
    kernel: kernelMgr,
    pythonPath,
    pythonPathError,
    envOptionsError: envOptionsErrorMessage,
    inspect: inspectSvc,
    read: readSvc,
    edit: editSvc,
    clean: cleanSvc,
    output: outputSvc,
    export: exportSvc,
    execution: executionSvc
  }
}

const parseResolvedOptions = (value: unknown): PluginOptions => {
  const safe = PluginOptionsSchema.safeParse(value)
  return safe.success ? safe.data : parsePluginOptions({})
}

let cachedEnvOptions: { readonly raw: string; readonly value: PluginOptions } | undefined
const cachedInstanceOptions = new WeakMap<object, PluginOptions>()

let envOptionsError: string | undefined

export const resolveOptionsFromEnv = (instanceOptions?: unknown): PluginOptions => {
  const raw = process.env.OPENCODE_IPYNB_OPTIONS
  if (raw) {
    if (cachedEnvOptions?.raw === raw) {
      envOptionsError = undefined
      return cachedEnvOptions.value
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const safe = PluginOptionsSchema.safeParse(parsed)
      if (!safe.success) {
        const issue = safe.error.issues[0]
        throw new Error(
          issue === undefined
            ? "invalid plugin options"
            : `invalid plugin options: ${issue.path.join(".")} ${issue.message}`
        )
      }
      cachedEnvOptions = { raw, value: safe.data }
      envOptionsError = undefined
      return safe.data
    } catch (error) {
      envOptionsError = error instanceof Error ? error.message : String(error)
      return instanceOptions !== undefined && instanceOptions !== null
        ? parseResolvedOptions(instanceOptions)
        : parsePluginOptions({})
    }
  }
  envOptionsError = undefined
  if (instanceOptions !== undefined && instanceOptions !== null) {
    if (typeof instanceOptions === "object") {
      const cached = cachedInstanceOptions.get(instanceOptions)
      if (cached) return cached
      const value = parseResolvedOptions(instanceOptions)
      cachedInstanceOptions.set(instanceOptions, value)
      return value
    }
    return parseResolvedOptions(instanceOptions)
  }
  return parsePluginOptions({})
}

