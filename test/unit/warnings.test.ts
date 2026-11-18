import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  bestEffort,
  ignoreExpectedFailure,
  makeWarningSink,
  warningFrom
} from "../../src/utils/warnings.js"

describe("warning sink", () => {
  it("collects warnings until drained", () => {
    const sink = makeWarningSink()
    sink.add({ source: "lock", message: "boom" })
    expect(sink.drain()).toEqual([{ source: "lock", message: "boom" }])
    expect(sink.drain()).toEqual([])
  })

  it("drain returns a copy, not the live buffer", () => {
    const sink = makeWarningSink()
    sink.add({ source: "lock", message: "a" })
    const first = sink.drain()
    sink.add({ source: "lock", message: "b" })
    expect(first.length).toBe(1)
  })
})

describe("warningFrom", () => {
  it("uses the Error message", () => {
    expect(warningFrom("lock", new Error("nope"))).toEqual({
      source: "lock",
      message: "nope"
    })
  })

  it("stringifies non-Errors", () => {
    expect(warningFrom("lock", 42)).toEqual({ source: "lock", message: "42" })
  })

  it("keeps the errno code and the context", () => {
    const error = new Error("gone") as NodeJS.ErrnoException
    error.code = "ENOENT"
    expect(warningFrom("temp-unlink", error, "removing tmp")).toEqual({
      source: "temp-unlink",
      message: "gone",
      detail: "removing tmp: ENOENT"
    })
  })
})

describe("ignoreExpectedFailure", () => {
  it("passes the value through on success", async () => {
    const sink = makeWarningSink()
    const value = await Effect.runPromise(
      ignoreExpectedFailure(sink, "path-resolution", "probe", Effect.succeed(7))
    )
    expect(value).toBe(7)
    expect(sink.drain()).toEqual([])
  })

  it("records the failure and returns undefined", async () => {
    const sink = makeWarningSink()
    const value = await Effect.runPromise(
      ignoreExpectedFailure(
        sink,
        "path-resolution",
        "probe",
        Effect.fail(new Error("denied"))
      )
    )
    expect(value).toBeUndefined()
    expect(sink.drain()).toEqual([
      { source: "path-resolution", message: "denied", detail: "probe: denied" }
    ])
  })

  it("works without a sink", async () => {
    const value = await Effect.runPromise(
      ignoreExpectedFailure(
        undefined,
        "path-resolution",
        "probe",
        Effect.fail(new Error("denied"))
      )
    )
    expect(value).toBeUndefined()
  })
})

describe("bestEffort", () => {
  it("records a rejected promise instead of swallowing it", async () => {
    const sink = makeWarningSink()
    await bestEffort(sink, "cleanup", "dispose", () => Promise.reject(new Error("late")))
    expect(sink.drain()).toEqual([
      { source: "cleanup", message: "late", detail: "dispose: late" }
    ])
  })

  it("stays quiet on success", async () => {
    const sink = makeWarningSink()
    await bestEffort(sink, "cleanup", "dispose", () => Promise.resolve())
    expect(sink.drain()).toEqual([])
  })
})
