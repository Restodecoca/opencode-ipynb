import { describe, expect, it } from "bun:test"
import { patchJsonTextDetailed } from "../../src/utils/json-patch.js"
import type { JsonTextStyle } from "../../src/utils/json-patch.js"

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rnd: () => number, items: ReadonlyArray<T>): T =>
  items[Math.floor(rnd() * items.length)]!

const STRING_POOL = [
  "",
  "plain",
  "with \"quotes\"",
  "back\\slash",
  "line\nbreak",
  "tab\there",
  "\u0001\u001f",
  "unicodé",
  "日本語",
  "astral \u{1F680}",
  "emoji \u{1F9EA}\u{1F52C}",
  "$dollar {brace} [bracket]"
]

const randomValue = (rnd: () => number, depth: number): unknown => {
  const kind = depth > 3 ? Math.floor(rnd() * 4) : Math.floor(rnd() * 6)
  switch (kind) {
    case 0:
      return null
    case 1:
      return rnd() < 0.5
    case 2: {
      const roll = rnd()
      if (roll < 0.4) return Math.floor(rnd() * 2000) - 1000
      if (roll < 0.8) return Math.round((rnd() * 200 - 100) * 1000) / 1000
      return rnd() * 1e6
    }
    case 3:
      return pick(rnd, STRING_POOL)
    case 4: {
      const length = Math.floor(rnd() * 4)
      return Array.from({ length }, () => randomValue(rnd, depth + 1))
    }
    default: {
      const length = Math.floor(rnd() * 4)
      const keys = ["a", "b", "cells", "z", "metadata", "é", "\u{1F680}k"]
      const value: Record<string, unknown> = {}
      for (let index = 0; index < length; index += 1) {
        value[pick(rnd, keys) + (rnd() < 0.3 ? String(Math.floor(rnd() * 3)) : "")] =
          randomValue(rnd, depth + 1)
      }
      return value
    }
  }
}

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (typeof left !== typeof right) return false
  if (left === null || right === null) return left === right
  if (Array.isArray(left) !== Array.isArray(right)) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    )
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left as object)
    const rightKeys = Object.keys(right as object)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        deepEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key]
        )
    )
  }
  return false
}

const encodeString = (
  value: string,
  ensureAscii: boolean
): string => {
  const encoded = JSON.stringify(value)
  if (!ensureAscii) return encoded
  return encoded.replace(/[\u007f-\uffff]/g, (char) =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  )
}

const serialize = (
  value: unknown,
  rnd: () => number,
  style: JsonTextStyle,
  depth: number,
  multiline: boolean,
  indent: string
): string => {
  if (value === null) return "null"
  if (typeof value === "boolean") return String(value)
  if (typeof value === "number") return JSON.stringify(value)
  if (typeof value === "string") return encodeString(value, style.ensureAscii)
  const childIndent = `${indent}${style.unit}`
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    if (!multiline) {
      return `[${value
        .map((item) => serialize(item, rnd, style, depth + 1, false, childIndent))
        .join(style.itemSeparator)}]`
    }
    return `[${style.newline}${value
      .map(
        (item) =>
          `${childIndent}${serialize(item, rnd, style, depth + 1, true, childIndent)}`
      )
      .join(`,${style.newline}`)}${style.newline}${indent}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return "{}"
  const render = (key: string): string =>
    `${encodeString(key, style.ensureAscii)}${style.keySeparator}${serialize(
      record[key],
      rnd,
      style,
      depth + 1,
      multiline,
      childIndent
    )}`
  if (!multiline) {
    return `{${keys.map(render).join(style.itemSeparator)}}`
  }
  return `{${style.newline}${keys
    .map((key) => `${childIndent}${render(key)}`)
    .join(`,${style.newline}`)}${style.newline}${indent}}`
}

const styleFor = (rnd: () => number): JsonTextStyle => ({
  unit: pick(rnd, [" ", "  ", "\t"]),
  newline: pick(rnd, ["\n", "\r\n"] as const),
  itemSeparator: pick(rnd, [",", ", "]),
  keySeparator: pick(rnd, [":", ": "]),
  ensureAscii: rnd() < 0.3
})

const mutate = (rnd: () => number, value: unknown, depth: number): unknown => {
  if (depth > 3 || rnd() < 0.35) return randomValue(rnd, depth)
  if (Array.isArray(value)) {
    const next = value.map((item) => mutate(rnd, item, depth + 1))
    if (rnd() < 0.3) next.push(randomValue(rnd, depth + 1))
    if (next.length > 0 && rnd() < 0.25) next.pop()
    return next
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    const next: Record<string, unknown> = {}
    for (const key of Object.keys(record)) {
      if (rnd() < 0.15) continue
      next[key] = mutate(rnd, record[key], depth + 1)
    }
    if (rnd() < 0.4) {
      next[`k${Math.floor(rnd() * 100)}`] = randomValue(rnd, depth + 1)
    }
    return next
  }
  return randomValue(rnd, depth)
}

const REASONS = new Set([
  "parse-failed",
  "patch-threw",
  "overlapping-edits",
  "not-representable",
  "verification-failed"
])

describe("patchJsonTextDetailed property fuzz", () => {
  it("never throws, always parses back to the target, and is idempotent", () => {
    const rnd = mulberry32(20261118)
    let patched = 0
    let fellBack = 0
    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const style = styleFor(rnd)
      const source = randomValue(rnd, 0)
      const multiline = rnd() < 0.5
      const text =
        serialize(source, rnd, style, 0, multiline, "") +
        (rnd() < 0.5 ? style.newline : "")
      const target = mutate(rnd, source, 0)
      let result: ReturnType<typeof patchJsonTextDetailed>
      try {
        result = patchJsonTextDetailed(text, target, { style })
      } catch (error) {
        throw new Error(
          `iteration ${iteration}: patcher threw on ${JSON.stringify(text)} -> ${JSON.stringify(target)}: ${String(error)}`
        )
      }
      if (result.text !== undefined) {
        patched += 1
        const reparsed = JSON.parse(result.text) as unknown
        if (!deepEqual(reparsed, target)) {
          throw new Error(
            `iteration ${iteration}: patched text diverges from target\nsource: ${JSON.stringify(text)}\ntarget: ${JSON.stringify(target)}\npatched: ${JSON.stringify(result.text)}`
          )
        }
        const again = patchJsonTextDetailed(result.text, target, { style })
        if (again.text !== result.text) {
          throw new Error(
            `iteration ${iteration}: patch is not idempotent\nfirst: ${JSON.stringify(result.text)}\nsecond: ${JSON.stringify(again.text)}`
          )
        }
        continue
      }
      fellBack += 1
      expect(result.reason).toBeDefined()
      expect(REASONS.has(result.reason!)).toBe(true)
    }
    expect(patched + fellBack).toBe(2000)
    expect(patched).toBeGreaterThan(0)
  })

  it("returns the stored text untouched when the value already matches", () => {
    const rnd = mulberry32(777)
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const style = styleFor(rnd)
      const value = randomValue(rnd, 0)
      const text =
        serialize(value, rnd, style, 0, rnd() < 0.5, "") +
        (rnd() < 0.5 ? style.newline : "")
      const result = patchJsonTextDetailed(text, JSON.parse(text), { style })
      if (result.text !== undefined) {
        expect(result.text).toBe(text)
      }
    }
  })

  it("never emits unverifiable text when the source text has duplicate keys", () => {
    const style: JsonTextStyle = {
      unit: " ",
      newline: "\n",
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false
    }
    const text = `{"a": 1, "b": 2, "a": 3}`
    const result = patchJsonTextDetailed(text, { a: 4, b: 2 }, { style })
    if (result.text !== undefined) {
      expect(deepEqual(JSON.parse(result.text), { a: 4, b: 2 })).toBe(true)
    } else {
      expect(REASONS.has(result.reason!)).toBe(true)
    }
    const identity = patchJsonTextDetailed(text, JSON.parse(text), { style })
    expect(identity.text).toBe(text)
  })
})

describe("object keys that use escape sequences", () => {
  it("keeps the stored escape when another key changes", () => {
    const style: JsonTextStyle = {
      unit: " ",
      newline: "\n",
      itemSeparator: ", ",
      keySeparator: ": ",
      ensureAscii: false
    }
    const text = `{"a\\u0041b": 1, "z": 2}`
    const result = patchJsonTextDetailed(text, { aAb: 1, z: 3 }, { style })
    expect(result.reason).toBeUndefined()
    expect(result.text).toBe(`{"a\\u0041b": 1, "z": 3}`)
  })
})
