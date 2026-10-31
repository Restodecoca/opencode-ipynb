import type { Rpc } from "@opencode/plugin/rpc"

const cellSchema = {
  type: "object",
  properties: {
    cellIndex: { type: "integer", minimum: 0 },
    cellType: { type: "string", enum: ["code", "markdown", "raw"] },
    languageId: { type: "string" },
    text: { type: "string" },
    uri: { type: "string" },
    startLine: { type: "integer", minimum: 0 },
    endLine: { type: "integer", minimum: 0 },
    lineCount: { type: "integer", minimum: 0 }
  },
  required: ["cellIndex", "cellType", "languageId", "text", "startLine", "endLine", "lineCount"],
  additionalProperties: false
} as const

const documentSchema = {
  type: "object",
  properties: {
    filePath: { type: "string" },
    notebookUri: { type: "string" },
    languageId: { type: "string" },
    fileExtension: { type: "string" },
    kernelName: { type: "string" },
    pythonPath: { type: "string" },
    text: { type: "string" },
    sanitizedText: { type: "string" },
    cells: { type: "array", items: cellSchema }
  },
  required: ["filePath", "languageId", "text", "cells"],
  additionalProperties: false
} as const

/**
 * Public RPC contract for notebook/LSP integration.
 *
 * Other plugins can import this contract from `opencode-ipynb/rpc`, call
 * `document` to get a provider-agnostic virtual document, and subscribe to
 * `changed` to refresh diagnostics after the plugin edits a notebook.
 */
export const NotebookRpc = {
  id: "opencode-ipynb",
  methods: {
    document: {
      input: {
        type: "object",
        properties: {
          filePath: { type: "string" }
        },
        required: ["filePath"],
        additionalProperties: false
      },
      output: documentSchema,
      errors: {
        outside_worktree: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        },
        not_found: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        },
        invalid_notebook: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        }
      }
    }
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          filePath: { type: "string" }
        },
        required: ["filePath"],
        additionalProperties: false
      }
    }
  }
} as const satisfies Rpc.PortableDefinition

export type NotebookRpc = typeof NotebookRpc
