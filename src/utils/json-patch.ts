export interface JsonTextStyle {
  readonly newline: "\n" | "\r\n"
  readonly itemSeparator: string
  readonly keySeparator: string
  readonly ensureAscii: boolean
  readonly unit: string
}

interface LiteralNode {
  readonly kind: "literal"
  readonly start: number
  readonly end: number
  readonly value: unknown
}

interface ArrayNode {
  readonly kind: "array"
  readonly start: number
  readonly end: number
  readonly items: ReadonlyArray<JsonNode>
  readonly value: ReadonlyArray<unknown>
}

interface ObjectEntry {
  readonly key: string
  readonly keyStart: number
  readonly value: JsonNode
}

interface ObjectNode {
  readonly kind: "object"
  readonly start: number
  readonly end: number
  readonly entries: ReadonlyArray<ObjectEntry>
  readonly value: Record<string, unknown>
}

export type JsonNode = LiteralNode | ArrayNode | ObjectNode

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y

const isWhitespace = (code: number): boolean =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d

const skipWhitespace = (text: string, from: number): number => {
  let pos = from
  while (pos < text.length && isWhitespace(text.charCodeAt(pos))) pos += 1
  return pos
}

const parseStringSpan = (text: string, start: number): number => {
  let pos = start + 1
  while (pos < text.length) {
    const char = text[pos]
    if (char === "\\") {
      pos += 2
      continue
    }
    if (char === '"') return pos + 1
    pos += 1
  }
  throw new SyntaxError("unterminated string")
}

const parseNode = (text: string, from: number): JsonNode => {
  const start = skipWhitespace(text, from)
  const char = text[start]
  if (char === '"') {
    const end = parseStringSpan(text, start)
    return { kind: "literal", start, end, value: JSON.parse(text.slice(start, end)) }
  }
  if (char === "{") {
    const entries: ObjectEntry[] = []
    let pos = skipWhitespace(text, start + 1)
    if (text[pos] === "}") {
      return { kind: "object", start, end: pos + 1, entries, value: {} }
    }
    for (;;) {
      const keyStart = skipWhitespace(text, pos)
      const keyEnd = parseStringSpan(text, keyStart)
      const key = JSON.parse(text.slice(keyStart, keyEnd)) as string
      pos = skipWhitespace(text, keyEnd)
      pos = skipWhitespace(text, pos + 1)
      const value = parseNode(text, pos)
      entries.push({ key, keyStart, value })
      pos = skipWhitespace(text, value.end)
      if (text[pos] === ",") {
        pos += 1
        continue
      }
      if (text[pos] === "}") {
        const value: Record<string, unknown> = {}
        for (const entry of entries) value[entry.key] = entry.value.value
        return { kind: "object", start, end: pos + 1, entries, value }
      }
      throw new SyntaxError("expected , or } in object")
    }
  }
  if (char === "[") {
    const items: JsonNode[] = []
    let pos = skipWhitespace(text, start + 1)
    if (text[pos] === "]") {
      return { kind: "array", start, end: pos + 1, items, value: [] }
    }
    for (;;) {
      const value = parseNode(text, pos)
      items.push(value)
      pos = skipWhitespace(text, value.end)
      if (text[pos] === ",") {
        pos += 1
        continue
      }
      if (text[pos] === "]") {
        return {
          kind: "array",
          start,
          end: pos + 1,
          items,
          value: items.map((item) => item.value)
        }
      }
      throw new SyntaxError("expected , or ] in array")
    }
  }
  for (const literal of ["true", "false", "null"] as const) {
    if (text.startsWith(literal, start)) {
      return {
        kind: "literal",
        start,
        end: start + literal.length,
        value: literal === "true" ? true : literal === "false" ? false : null
      }
    }
  }
  NUMBER.lastIndex = start
  const match = NUMBER.exec(text)
  if (match !== null) {
    return {
      kind: "literal",
      start,
      end: start + match[0].length,
      value: JSON.parse(match[0])
    }
  }
  throw new SyntaxError(`unexpected token at ${start}`)
}

export const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== typeof right) return false
  const leftIsArray = Array.isArray(left)
  if (leftIsArray !== Array.isArray(right)) return false
  if (leftIsArray) {
    const a = left as ReadonlyArray<unknown>
    const b = right as ReadonlyArray<unknown>
    if (a.length !== b.length) return false
    return a.every((item, index) => jsonEqual(item, b[index]))
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left as object)
    const rightKeys = Object.keys(right as object)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonEqual(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key]
        )
    )
  }
  return false
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

const encodeString = (value: string, ensureAscii: boolean): string => {
  const json = JSON.stringify(value)
  if (!ensureAscii) return json
  return json.replace(/[\u007f-\uffff]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
}

const lineStart = (text: string, pos: number): number => {
  let index = pos
  while (index > 0 && text[index - 1] !== "\n") index -= 1
  return index
}

const indentAt = (text: string, pos: number): string => {
  const start = lineStart(text, pos)
  const prefix = text.slice(start, pos)
  return /^[ \t]*$/.test(prefix) ? prefix : ""
}

const isMultiline = (text: string, node: JsonNode): boolean => {
  const at = text.indexOf("\n", node.start)
  return at !== -1 && at < node.end
}

interface Layout {
  readonly text: string
  readonly style: JsonTextStyle
}

const childIndentForArray = (layout: Layout, node: ArrayNode): string => {
  const first = node.items[0]
  if (first === undefined || !isMultiline(layout.text, node)) return ""
  return indentAt(layout.text, first.start)
}

const childIndentForObject = (layout: Layout, node: ObjectNode): string => {
  const first = node.entries[0]
  if (first === undefined || !isMultiline(layout.text, node)) return ""
  return indentAt(layout.text, first.keyStart)
}

const formatValue = (
  value: unknown,
  indent: string,
  multiline: boolean,
  layout: Layout
): string => {
  const { style } = layout
  const childIndent = `${indent}${style.unit}`
  const separator = multiline ? `,${style.newline}` : style.itemSeparator
  if (value === null) return "null"
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null"
  }
  if (typeof value === "boolean") return String(value)
  if (typeof value === "string") return encodeString(value, style.ensureAscii)
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    if (!multiline) {
      return `[${value
        .map((item) => formatValue(item, childIndent, false, layout))
        .join(style.itemSeparator)}]`
    }
    return `[${style.newline}${value
      .map((item) => `${childIndent}${formatValue(item, childIndent, true, layout)}`)
      .join(separator)}${style.newline}${indent}]`
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0) return "{}"
  if (!multiline) {
    return `{${keys
      .map(
        (key) =>
          `${encodeString(key, style.ensureAscii)}${style.keySeparator}${formatValue(
            record[key],
            childIndent,
            false,
            layout
          )}`
      )
      .join(style.itemSeparator)}}`
  }
  return `{${style.newline}${keys
    .map(
      (key) =>
        `${childIndent}${encodeString(key, style.ensureAscii)}${
          style.keySeparator
        }${formatValue(record[key], childIndent, true, layout)}`
    )
    .join(separator)}${style.newline}${indent}}`
}

interface Edit {
  readonly start: number
  readonly end: number
  readonly text: string
}

const prefixLength = (
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>
): number => {
  let index = 0
  while (
    index < left.length &&
    index < right.length &&
    jsonEqual(left[index], right[index])
  ) {
    index += 1
  }
  return index
}

const suffixLength = (
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
  prefix: number
): number => {
  let count = 0
  while (
    count < left.length - prefix &&
    count < right.length - prefix &&
    jsonEqual(left[left.length - 1 - count], right[right.length - 1 - count])
  ) {
    count += 1
  }
  return count
}


const patchArray = (
  value: ReadonlyArray<unknown>,
  node: ArrayNode,
  edits: Edit[],
  layout: Layout,
  indent: string
): void => {
  const multiline = isMultiline(layout.text, node)
  const oldItems = node.items.map((item) => item.value)
  const prefix = prefixLength(oldItems, value)
  const suffix = suffixLength(oldItems, value, prefix)
  const oldMiddle = node.items.slice(prefix, node.items.length - suffix)
  const newMiddle = value.slice(prefix, value.length - suffix)
  const childIndent = childIndentForArray(layout, node) || `${indent}${layout.style.unit}`
  const fileMultiline = multiline || node.items.length === 0
  const separator = fileMultiline
    ? `,${layout.style.newline}${childIndent}`
    : layout.style.itemSeparator

  const rawByIdentity = new Map<unknown, string>()
  const rawByKey = new Map<string, string>()
  for (let index = 0; index < node.items.length; index += 1) {
    const item = oldItems[index]
    const source = node.items[index]!
    const raw = layout.text.slice(source.start, source.end)
    if (item !== null && typeof item === "object") rawByIdentity.set(item, raw)
    rawByKey.set(canonicalJson(item), raw)
  }
  const rawFor = (item: unknown): string | undefined => {
    const raw =
      (item !== null && typeof item === "object"
        ? rawByIdentity.get(item)
        : undefined) ?? rawByKey.get(canonicalJson(item))
    if (raw === undefined) return undefined
    return raw.includes("\n") && !fileMultiline ? undefined : raw
  }

  if (oldMiddle.length > 0 && newMiddle.length === oldMiddle.length) {
    const reordered =
      oldMiddle.length > 1 &&
      !oldMiddle.every((item, i) => jsonEqual(item, newMiddle[i]))
    if (reordered) {
      edits.push({
        start: oldMiddle[0]!.start,
        end: oldMiddle[oldMiddle.length - 1]!.end,
        text: newMiddle
          .map((item) => rawFor(item) ?? formatValue(item, childIndent, fileMultiline, layout))
          .join(separator)
      })
      return
    }
    for (let i = 0; i < oldMiddle.length; i += 1) {
      patchNode(
        newMiddle[i],
        oldItems[prefix + i],
        oldMiddle[i]!,
        edits,
        layout,
        childIndent
      )
    }
    return
  }
  const emitItem = (item: unknown): string =>
    rawFor(item) ?? formatValue(item, childIndent, fileMultiline, layout)

  if (oldMiddle.length > 0 && newMiddle.length > 0) {
    edits.push({
      start: oldMiddle[0]!.start,
      end: oldMiddle[oldMiddle.length - 1]!.end,
      text: newMiddle
        .map((item) => emitItem(item))
        .join(separator)
    })
    return
  }
  if (oldMiddle.length > 0) {
    if (newMiddle.length === 0 && prefix === 0 && suffix === 0) {
      edits.push({ start: node.start, end: node.end, text: "[]" })
      return
    }
    if (prefix > 0) {
      edits.push({
        start: node.items[prefix - 1]!.end,
        end: oldMiddle[oldMiddle.length - 1]!.end,
        text: ""
      })
    } else {
      edits.push({
        start: oldMiddle[0]!.start,
        end: node.items[oldMiddle.length]!.start,
        text: ""
      })
    }
    return
  }
  if (newMiddle.length > 0) {
    const text = newMiddle.map((item) => emitItem(item)).join(separator)
    if (prefix > 0) {
      edits.push({
        start: node.items[prefix - 1]!.end,
        end: node.items[prefix - 1]!.end,
        text: `${separator}${text}`
      })
    } else if (node.items.length > 0) {
      const at = node.items[0]!.start
      edits.push({ start: at, end: at, text: `${text}${separator}` })
    } else {
      const open = node.start + 1
      edits.push({
        start: open,
        end: open,
        text: fileMultiline
          ? `${layout.style.newline}${childIndent}${newMiddle
              .map((item) => formatValue(item, childIndent, true, layout))
              .join(separator)}${layout.style.newline}${indent}`
          : text
      })
    }
  }
}

const patchObject = (
  value: Record<string, unknown>,
  node: ObjectNode,
  edits: Edit[],
  layout: Layout,
  indent: string
): void => {
  const multiline = isMultiline(layout.text, node)
  const childIndent = childIndentForObject(layout, node) || `${indent}${layout.style.unit}`
  const separator = multiline
    ? `,${layout.style.newline}${childIndent}`
    : layout.style.itemSeparator
  const byKey = new Map(node.entries.map((entry) => [entry.key, entry]))

  const removedSet = new Set(
    node.entries.filter(
      (entry) => !Object.prototype.hasOwnProperty.call(value, entry.key)
    )
  )
  for (let index = 0; index < node.entries.length; ) {
    const entry = node.entries[index]!
    if (!removedSet.has(entry)) {
      index += 1
      continue
    }
    let lastIndex = index
    while (
      lastIndex + 1 < node.entries.length &&
      removedSet.has(node.entries[lastIndex + 1]!)
    ) {
      lastIndex += 1
    }
    if (index === 0 && lastIndex === node.entries.length - 1) {
      if (Object.keys(value).length === 0) {
        edits.push({ start: node.start, end: node.end, text: "{}" })
        return
      }
      edits.push({
        start: node.start,
        end: node.end,
        text: formatValue(value, indent, multiline || layout.text.includes("\n"), layout)
      })
      return
    }
    const next = node.entries[lastIndex + 1]
    if (next !== undefined) {
      edits.push({
        start: node.entries[index]!.keyStart,
        end: next.keyStart,
        text: ""
      })
    } else {
      const previous = node.entries[index - 1]
      edits.push({
        start: previous !== undefined ? previous.value.end : node.start + 1,
        end: node.entries[lastIndex]!.value.end,
        text: ""
      })
    }
    index = lastIndex + 1
  }

  const added = Object.keys(value).filter((key) => !byKey.has(key))
  if (added.length > 0) {
    const fileMultiline = multiline || layout.text.includes("\n")
    const render = (key: string): string =>
      `${encodeString(key, layout.style.ensureAscii)}${
        layout.style.keySeparator
      }${formatValue(value[key], childIndent, fileMultiline, layout)}`
    if (node.entries.length === 0) {
      edits.push({
        start: node.start,
        end: node.end,
        text: formatValue(value, indent, fileMultiline, layout)
      })
      return
    }
    const surviving = node.entries.filter((entry) => !removedSet.has(entry))
    const groups = new Map<string, string[]>()
    const appended: string[] = []
    let anchorPosition = 0
    for (const key of [...added].sort()) {
      while (
        anchorPosition < surviving.length &&
        surviving[anchorPosition]!.key <= key
      ) {
        anchorPosition += 1
      }
      const anchor =
        anchorPosition < surviving.length ? surviving[anchorPosition] : undefined
      if (anchor === undefined) {
        appended.push(key)
      } else {
        const bucket = groups.get(anchor.key) ?? []
        bucket.push(key)
        groups.set(anchor.key, bucket)
      }
    }
    for (const [anchorKey, keys] of groups) {
      const anchor = surviving.find((entry) => entry.key === anchorKey)!
      const text = keys.map(render).join(separator)
      edits.push({
        start: anchor.keyStart,
        end: anchor.keyStart,
        text: fileMultiline ? `${text}${separator}` : `${text}${layout.style.itemSeparator}`
      })
    }
    if (appended.length > 0) {
      const text = appended.map(render).join(separator)
      const last = node.entries[node.entries.length - 1]
      edits.push({
        start: last!.value.end,
        end: last!.value.end,
        text: fileMultiline
          ? `${separator}${text}`
          : `${layout.style.itemSeparator}${text}`
      })
    }
  }

  for (const [key, next] of Object.entries(value)) {
    const entry = byKey.get(key)
    if (entry === undefined) continue
    patchNode(next, entry.value.value, entry.value, edits, layout, childIndent)
  }
}

const patchNode = (
  value: unknown,
  previous: unknown,
  node: JsonNode,
  edits: Edit[],
  layout: Layout,
  indent: string
): void => {
  if (jsonEqual(value, previous)) return
  if (node.kind === "array" && Array.isArray(value)) {
    patchArray(value, node, edits, layout, indent)
    return
  }
  if (
    node.kind === "object" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    patchObject(value as Record<string, unknown>, node, edits, layout, indent)
    return
  }
  edits.push({
    start: node.start,
    end: node.end,
    text: formatValue(value, indent, isMultiline(layout.text, node), layout)
  })
}

const applyEdits = (text: string, edits: ReadonlyArray<Edit>): string | undefined => {
  if (edits.length === 0) return text
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const segments: string[] = []
  let cursor = 0
  for (const edit of ordered) {
    if (edit.start < cursor) return undefined
    segments.push(text.slice(cursor, edit.start), edit.text)
    cursor = edit.end
  }
  segments.push(text.slice(cursor))
  return segments.join("")
}

export interface PatchOptions {
  readonly style: JsonTextStyle
}

export type PatchFailureReason =
  | "parse-failed"
  | "patch-threw"
  | "overlapping-edits"
  | "not-representable"
  | "verification-failed"

export interface PatchResult {
  readonly text?: string
  readonly reason?: PatchFailureReason
}

export const patchJsonTextDetailed = (
  text: string,
  next: unknown,
  options: PatchOptions
): PatchResult => {
  let root: JsonNode
  let previous: unknown
  try {
    root = parseNode(text, 0)
    previous = root.value
  } catch {
    return { reason: "parse-failed" }
  }
  const layout: Layout = { text, style: options.style }
  const edits: Edit[] = []
  try {
    patchNode(next, previous, root, edits, layout, "")
  } catch {
    return { reason: "patch-threw" }
  }
  if (edits.length === 0) {
    return jsonEqual(previous, next)
      ? { text }
      : { reason: "not-representable" }
  }
  const patched = applyEdits(text, edits)
  if (patched === undefined) return { reason: "overlapping-edits" }
  try {
    if (!jsonEqual(JSON.parse(patched), next)) {
      return { reason: "verification-failed" }
    }
  } catch {
    return { reason: "verification-failed" }
  }
  return { text: patched }
}

export const patchJsonText = (
  text: string,
  next: unknown,
  options: PatchOptions
): string | undefined => patchJsonTextDetailed(text, next, options).text

export const formatJsonValue = (
  value: unknown,
  style: JsonTextStyle,
  multiline = true
): string => formatValue(value, "", multiline, { text: "", style })
