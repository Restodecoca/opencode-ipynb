import { describe, expect, it } from "bun:test"
import { toolDefinitions } from "../../src/registrations.js"
import { toV2Tool } from "../../src/plugin-v2.js"
import type { Plugin } from "@opencode/plugin"

interface JsonSchema {
  readonly anyOf?: ReadonlyArray<Record<string, unknown>>
  readonly required?: ReadonlyArray<string>
  readonly properties?: Record<string, { readonly enum?: ReadonlyArray<string> }>
}

const schemaFor = (name: string): JsonSchema => {
  const registration = {
    name,
    definition: toolDefinitions[name]!,
    permission: undefined
  } as never
  const info = toV2Tool(
    { options: {}, location: { directory: "/tmp", project: { directory: "/tmp" } } } as unknown as Plugin.Context,
    registration
  )
  return info.input as unknown as JsonSchema
}

const validates = (
  schema: JsonSchema,
  value: Record<string, unknown>
): boolean => {
  const branches = schema.anyOf
  if (branches === undefined) return true
  return branches.some((branch) => {
    const required = (branch.required ?? []) as ReadonlyArray<string>
    for (const key of required) {
      if (!(key in value)) return false
    }
    const not = branch.not as { anyOf?: ReadonlyArray<{ required?: ReadonlyArray<string> }> } | undefined
    if (not?.anyOf !== undefined) {
      const excluded = not.anyOf.some((inner) =>
        (inner.required ?? []).every((key) => key in value)
      )
      if (excluded) return false
    }
    const properties = branch.properties as
      | Record<string, { enum?: ReadonlyArray<string> }>
      | undefined
    if (properties !== undefined) {
      for (const [key, constraint] of Object.entries(properties)) {
        if (constraint.enum !== undefined && key in value) {
          if (!constraint.enum.includes(String(value[key]))) return false
        }
      }
    }
    return true
  })
}

describe("generated schema expresses the runtime requirements", () => {
  it("rejects an ipynb_read call that only names the file", () => {
    const schema = schemaFor("ipynb_read")
    expect(validates(schema, { filePath: "n.ipynb" })).toBe(false)
    expect(validates(schema, { filePath: "n.ipynb", cellIndex: 0 })).toBe(true)
    expect(validates(schema, { filePath: "n.ipynb", start: 0, end: 3 })).toBe(true)
    expect(validates(schema, { filePath: "n.ipynb", cellIndex: 0, start: 0 })).toBe(false)
    expect(validates(schema, { filePath: "n.ipynb", start: 0 })).toBe(false)
  })

  it("rejects an ipynb_outputs read without a cell index", () => {
    const schema = schemaFor("ipynb_outputs")
    expect(validates(schema, { filePath: "n.ipynb", operation: "read" })).toBe(false)
    expect(
      validates(schema, { filePath: "n.ipynb", operation: "read", cellIndex: 0 })
    ).toBe(true)
    expect(validates(schema, { filePath: "n.ipynb", operation: "list" })).toBe(true)
    expect(validates(schema, { filePath: "n.ipynb", operation: "clear_all" })).toBe(true)
    expect(
      validates(schema, { filePath: "n.ipynb", operation: "clear_cell" })
    ).toBe(false)
  })

  it("leaves tools without conditional requirements unchanged", () => {
    const schema = schemaFor("ipynb_inspect")
    expect(schema.anyOf).toBeUndefined()
  })
})
