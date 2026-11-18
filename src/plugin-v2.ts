import { z } from "zod"
import {
  makeWarningSink,
  type Warning,
  type WarningSink
} from "./utils/warnings.js"
import type { Plugin } from "@opencode/plugin"
import type {
  AnyToolDefinition,
  ToolAttachment,
  ToolContext,
  ToolResult
} from "./tool.js"

type V2ToolEditor = Parameters<Plugin.Context["tool"]["transform"]>[0] extends (
  editor: infer Editor
) => void
  ? Editor
  : never

export type V2ToolInfo = Parameters<V2ToolEditor["add"]>[0]
export type V2ToolContext = Parameters<V2ToolInfo["execute"]>[1]
type PermissionAssertInput = Parameters<Plugin.Context["permission"]["assert"]>[0]

export interface V2ToolRegistration {
  readonly name: string
  readonly definition: AnyToolDefinition
  readonly permission?: string
}

export interface V2FileContent {
  readonly type: "file"
  readonly uri: string
  readonly mime: string
  readonly name?: string
}

export type V2Content =
  | { readonly type: "text"; readonly text: string }
  | V2FileContent

export interface V2ToolResult {
  readonly content: string | ReadonlyArray<V2Content>
  readonly metadata?: Record<string, unknown>
}

const jsonSchemaFor = (definition: AnyToolDefinition): V2ToolInfo["input"] =>
  z.toJSONSchema(z.object(definition.args), {
    io: "input"
  }) as unknown as V2ToolInfo["input"]

const toFileContent = (attachment: ToolAttachment): V2FileContent => {
  const base: V2FileContent = {
    type: "file",
    uri: attachment.url,
    mime: attachment.mime
  }
  return attachment.filename === undefined
    ? base
    : { ...base, name: attachment.filename }
}

const withoutUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => withoutUndefined(item))
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefined(item)])
    )
  }
  return value
}

export const toV2Result = (result: ToolResult): V2ToolResult => {
  if (typeof result === "string") {
    return { content: result }
  }
  const content: string | ReadonlyArray<V2Content> =
    result.attachments && result.attachments.length > 0
      ? [
          { type: "text", text: result.output },
          ...result.attachments.map(toFileContent)
        ]
      : result.output
  const metadata = withoutUndefined({
    ...(result.metadata ?? {}),
    ...(result.title === undefined || result.title.length === 0
      ? {}
      : { title: result.title })
  }) as Record<string, unknown>

  return Object.keys(metadata).length > 0 ? { content, metadata } : { content }
}

export const toToolContext = (
  pluginContext: Plugin.Context,
  context: V2ToolContext,
  pluginOptions: unknown,
  warningSink?: WarningSink
): ToolContext => ({
  sessionID: context.sessionID,
  messageID: context.messageID,
  agent: context.agent,
  directory: pluginContext.location.directory,
  worktree: pluginContext.location.project.directory,
  abort: context.signal,
  pluginOptions,
  pluginScope: pluginContext,
  warningSink,
  metadata: (input) => {
    void context
      .progress({
        ...(input.metadata ?? {}),
        ...(input.title === undefined ? {} : { title: input.title })
      })
      .catch(() => {})
  },
  ask: async (input) => {
    const action = input.permission === "bash" ? "shell" : input.permission
    await pluginContext.permission.assert({
      sessionID: context.sessionID as PermissionAssertInput["sessionID"],
      agent: context.agent as PermissionAssertInput["agent"],
      source: {
        type: "tool",
        messageID: context.messageID,
        id: context.id
      },
      action,
      resources: [...input.patterns],
      save: [...input.always],
      metadata: input.metadata
    })
  }
})

const appendWarnings = (result: unknown, warnings: ReadonlyArray<Warning>) => {
  const rendered = warnings
    .map(
      (warning) =>
        `warning [${warning.source}]: ${warning.message}` +
        (warning.detail === undefined ? "" : ` (${warning.detail})`)
    )
    .join("\n")
  if (typeof result === "string") return `${result}\n\n${rendered}`
  if (result !== null && typeof result === "object") {
    const record = result as { output?: unknown; metadata?: Record<string, unknown> }
    const output =
      typeof record.output === "string"
        ? `${record.output}\n\n${rendered}`
        : rendered
    return {
      ...record,
      output,
      metadata: { ...(record.metadata ?? {}), warnings }
    }
  }
  return result
}

export const toV2Tool = (
  pluginContext: Plugin.Context,
  registration: V2ToolRegistration,
  pluginOptions: unknown = pluginContext.options,
  warningSink?: WarningSink
): V2ToolInfo => {
  const argsSchema = z.object(registration.definition.args)
  return {
    name: registration.name,
    description: registration.definition.description,
    input: jsonSchemaFor(registration.definition),
    options: {
      codemode: false,
      ...(registration.permission === undefined
        ? {}
        : { permission: registration.permission })
    },
    async execute(rawInput, context) {
      if (context.signal?.aborted) {
        const message = "the request was cancelled; nothing was changed"
        return { content: `Error: ${message}`, metadata: { error: true, message } }
      }
      const parsed = argsSchema.safeParse(rawInput ?? {})
      if (!parsed.success) {
        const message = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")
        return { content: `Error: ${message}`, metadata: { error: true, message } }
      }
      const sink = warningSink ?? makeWarningSink()
      const result = await registration.definition.execute(
        parsed.data as never,
        toToolContext(pluginContext, context, pluginOptions, sink)
      )
      const warnings = sink.drain()
      if (warnings.length === 0) return toV2Result(result)
      return toV2Result(appendWarnings(result, warnings) as never)
    }
  }
}

export const registerV2Tools = async (
  context: Plugin.Context,
  registrations: ReadonlyArray<V2ToolRegistration>,
  pluginOptions: unknown = context.options
) =>
  context.tool.transform((editor) => {
    for (const registration of registrations) {
      editor.add(toV2Tool(context, registration, pluginOptions))
    }
  })

export type V2Registration = Awaited<ReturnType<typeof registerV2Tools>>
