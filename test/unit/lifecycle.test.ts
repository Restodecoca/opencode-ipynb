import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  buildServices,
  disposeSharedKernelManager
} from "../../src/services/index.js"
import type { ToolContext } from "../../src/tool.js"

const base = {
  sessionID: "test",
  messageID: "test",
  agent: "test",
  directory: process.cwd(),
  worktree: process.cwd(),
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {}
}

const contextFor = (scope: object): ToolContext =>
  ({ ...base, pluginScope: scope }) as unknown as ToolContext

describe("kernel manager lifecycle", () => {
  it("disposes the managers of a scope and hands out fresh ones afterwards", async () => {
    const scopeA = {}
    const scopeB = {}
    const ctxA = contextFor(scopeA)
    const ctxB = contextFor(scopeB)
    const managerA = buildServices(ctxA).kernel
    const managerB = buildServices(ctxB).kernel
    expect(buildServices(ctxA).kernel).toBe(managerA)
    expect(managerB).not.toBe(managerA)

    let disposedA = 0
    ;(managerA as unknown as { disposeAll: () => Effect.Effect<void> }).disposeAll =
      () => {
        disposedA += 1
        return Effect.void
      }

    await disposeSharedKernelManager(scopeA)
    expect(disposedA).toBe(1)
    const freshA = buildServices(ctxA).kernel
    expect(freshA).not.toBe(managerA)
    expect(buildServices(ctxB).kernel).toBe(managerB)

    await disposeSharedKernelManager()
    expect(buildServices(ctxB).kernel).not.toBe(managerB)
  })

  it("disposing an unknown scope is a no-op", async () => {
    const manager = buildServices(contextFor({})).kernel
    await disposeSharedKernelManager({})
    expect(buildServices(contextFor({})).kernel).not.toBe(manager)
  })
})
