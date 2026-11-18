import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const srcRoot = path.join(import.meta.dir, "..", "..", "src")

const silentCatch =
  /\.catch\(\(\) => \{\s*\}\)|\.catch\(\(\) => (?:undefined|false|null|\[\]|"")\)|\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g

const allowlist = new Map<string, number>([
  ["services/KernelManager.ts|.catch(() => {})", 1],
  ["services/NotebookFileService.ts|.catch(() => {})", 1],
  ["notebook-diagnostics.ts|.catch(() => {})", 1],
  ["plugin-v2.ts|.catch(() => {})", 1],
  ["services/PythonService.ts|catch { }", 3],
  ["notebook-diagnostics.ts|catch { }", 2],
  ["virtual-materialize.ts|catch { }", 1],
  ["plugin-options.ts|catch { }", 1]
])

const listFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listFiles(full)
    return entry.name.endsWith(".ts") ? [full] : []
  })

const normalize = (match: string): string => match.replace(/\s+/g, " ").trim()

describe("silent failure allowlist", () => {
  it("keeps every swallowed failure either reported or on the allowlist", () => {
    const remaining = new Map(allowlist)
    const offenders: string[] = []
    for (const file of listFiles(srcRoot)) {
      const rel = path.relative(srcRoot, file).split(path.sep).join("/")
      const content = fs.readFileSync(file, "utf8")
      for (const match of content.matchAll(silentCatch)) {
        const key = `${rel}|${normalize(match[0])}`
        const left = remaining.get(key)
        if (left === undefined) {
          offenders.push(`unlisted silent failure at ${rel} near offset ${match.index ?? 0}`)
          continue
        }
        if (left === 1) remaining.delete(key)
        else remaining.set(key, left - 1)
      }
    }
    for (const key of remaining.keys()) {
      offenders.push(`stale allowlist entry: ${key}`)
    }
    expect(offenders).toEqual([])
  })
})
