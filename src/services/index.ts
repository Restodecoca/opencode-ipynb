import type { ToolContext } from "@opencode-ai/plugin"
import { Effect } from "effect"
import {
  PluginOptionsSchema,
  parsePluginOptions,
  type PluginOptions
} from "../plugin-options.js"
import { makePathService, type PathServiceShape } from "./PathService.js"
import { makePermissionService, type PermissionServiceShape } from "./PermissionService.js"
import { makeNotebookFileService, type NotebookFileServiceShape } from "./NotebookFileService.js"
import { makeDiffService, type DiffServiceShape } from "./DiffService.js"
import { makeInspectImpl } from "./NotebookInspectService.js"
import { makeReadImpl, type NotebookReadServiceShape } from "./NotebookReadService.js"
import { makeEditImpl, type NotebookEditServiceShape } from "./NotebookEditService.js"
import { makeCleanImpl, type NotebookCleanServiceShape } from "./NotebookCleanService.js"
import { makeOutputImpl, type NotebookOutputServiceShape } from "./NotebookOutputService.js"
import { makeExportImpl, type NotebookExportServiceShape } from "./NotebookExportService.js"
import { makeExecutionImpl, type NotebookExecutionServiceShape } from "./NotebookExecutionService.js"
import { makePythonService, makeKernelManager, type PythonServiceShape, type KernelManagerShape } from "./PythonService.js"

export { PathService, type PathServiceShape, type PathEnv, makePathService } from "./PathService.js"
export { PermissionService, type PermissionServiceShape, type PermissionRequest, type PermissionKind, makePermissionService } from "./PermissionService.js"
export { NotebookFileService, type NotebookFileServiceShape, makeNotebookFileService } from "./NotebookFileService.js"
export { DiffService, type DiffServiceShape, makeDiffService } from "./DiffService.js"
export { NotebookInspectService, makeInspectImpl } from "./NotebookInspectService.js"
export { NotebookReadService, type NotebookReadServiceShape, makeReadImpl } from "./NotebookReadService.js"
export { NotebookEditService, type NotebookEditServiceShape, makeEditImpl } from "./NotebookEditService.js"
export { NotebookCleanService, type NotebookCleanServiceShape, makeCleanImpl } from "./NotebookCleanService.js"
export { NotebookOutputService, type NotebookOutputServiceShape, makeOutputImpl } from "./NotebookOutputService.js"
export { NotebookExportService, type NotebookExportServiceShape, makeExportImpl } from "./NotebookExportService.js"
export { NotebookExecutionService, type NotebookExecutionServiceShape, makeExecutionImpl } from "./NotebookExecutionService.js"
export {
  PythonService,
  type PythonServiceShape,
  type PythonDoctor,
  type PythonProbeResult,
  type DependencyCheck,
  type PythonServiceOptions,
  type KernelManagerShape,
  type KernelInfo,
  type KernelManagerStats,
  type KernelManagerOptions,
  type KernelRuntimeOptions,
  makePythonService,
  makeKernelManager
} from "./PythonService.js"
export { KernelManager } from "./PythonService.js"

export interface NotebookServices {
  readonly path: PathServiceShape
  readonly permission: PermissionServiceShape
  readonly file: NotebookFileServiceShape
  readonly diff: DiffServiceShape
  readonly python: PythonServiceShape
  readonly kernel: KernelManagerShape
  readonly inspect: ReturnType<typeof makeInspectImpl>
  readonly read: NotebookReadServiceShape
  readonly edit: NotebookEditServiceShape
  readonly clean: NotebookCleanServiceShape
  readonly output: NotebookOutputServiceShape
  readonly export: NotebookExportServiceShape
  readonly execution: NotebookExecutionServiceShape
}

export interface BuildServicesOptions {
  readonly pythonPath?: string | undefined
  readonly preferUv: boolean
  readonly helperRelativePath: string
  readonly warmKernel: boolean
  readonly defaultTimeoutMs: number
  readonly directory: string
}

// Module-level singleton for the kernel manager. The plugin needs the
// same instance across all tool invocations to share the running kernels,
// and the dispose hook kills them all at session end.
let sharedKernelManager: KernelManagerShape | undefined

const getOrCreateSharedKernelManager = (opts: {
  readonly pythonPath: string | undefined
  readonly helperPath: string
  readonly workingDirectory: string
  readonly defaultTimeoutMs: number
}): KernelManagerShape => {
  if (!sharedKernelManager) {
    sharedKernelManager = makeKernelManager({
      pythonPath: opts.pythonPath ?? "python",
      helperPath: opts.helperPath,
      workingDirectory: opts.workingDirectory,
      defaultTimeoutMs: opts.defaultTimeoutMs
    })
  }
  return sharedKernelManager
}

export const disposeSharedKernelManager = async (): Promise<void> => {
  if (!sharedKernelManager) return
  const svc = sharedKernelManager
  sharedKernelManager = undefined
  await Effect.runPromise(svc.disposeAll())
}

export const buildServices = (
  ctx: ToolContext,
  options?: Partial<BuildServicesOptions>
): NotebookServices => {
  const resolved = resolveOptionsFromEnv()
  const pathSvc: PathServiceShape = makePathService({
    directory: ctx.directory,
    worktree: ctx.worktree,
    platform: process.platform,
    allowOutsideWorktree: resolved.allowOutsideWorktree
  })
  const permissionSvc: PermissionServiceShape = makePermissionService(ctx)
  const fileSvc: NotebookFileServiceShape = makeNotebookFileService()
  const diffSvc: DiffServiceShape = makeDiffService()
  const pythonPath = process.env.OPENCODE_IPYNB_PYTHON ?? resolved.pythonPath
  const pythonSvc: PythonServiceShape = makePythonService({
    pythonPath,
    preferUv: resolved.preferUv,
    helperRelativePath: resolved.helperRelativePath
  })
  const kernelMgr: KernelManagerShape = getOrCreateSharedKernelManager({
    pythonPath,
    helperPath: resolved.helperRelativePath,
    workingDirectory: ctx.directory,
    defaultTimeoutMs: resolved.defaultTimeoutMs
  })
  const inspectSvc = makeInspectImpl(pathSvc, fileSvc)
  const readSvc = makeReadImpl(pathSvc, fileSvc)
  const editSvc = makeEditImpl(pathSvc, fileSvc, diffSvc, permissionSvc)
  const cleanSvc = makeCleanImpl(pathSvc, fileSvc, permissionSvc)
  const outputSvc = makeOutputImpl(pathSvc, fileSvc, permissionSvc)
  const exportSvc = makeExportImpl(pathSvc, fileSvc, permissionSvc)
  const executionSvc = makeExecutionImpl(pathSvc, fileSvc, permissionSvc, pythonSvc, {
    kernelManager: kernelMgr,
    warmKernel: resolved.warmKernel,
    defaultTimeoutMs: resolved.defaultTimeoutMs
  })
  return {
    path: pathSvc,
    permission: permissionSvc,
    file: fileSvc,
    diff: diffSvc,
    python: pythonSvc,
    kernel: kernelMgr,
    inspect: inspectSvc,
    read: readSvc,
    edit: editSvc,
    clean: cleanSvc,
    output: outputSvc,
    export: exportSvc,
    execution: executionSvc
  }
}

const resolveOptionsFromEnv = (): PluginOptions => {
  const raw = process.env.OPENCODE_IPYNB_OPTIONS
  if (!raw) {
    return parsePluginOptions({})
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    const safe = PluginOptionsSchema.safeParse(parsed)
    if (!safe.success) {
      return parsePluginOptions({})
    }
    return safe.data
  } catch {
    return parsePluginOptions({})
  }
}

export { resolveOptionsFromEnv }
