#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

interface PackFile {
  readonly path: string
}

const root = path.resolve(import.meta.dir, "..")

const required = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/lsp.js",
  "dist/lsp.d.ts",
  "dist/rpc.js",
  "dist/rpc.d.ts",
  "server.js",
  "python/ipynb_runner.py",
  "python/requirements.txt",
  "README.md",
  "CHANGELOG.md",
  "LICENSE"
]

const staleMarkers = [
  "the existing notebook could not be read; refusing to overwrite it",
  "another process replaced the notebook right after the write",
  "nothing was changed"
]

const failures: string[] = []

for (const entry of required) {
  if (!fs.existsSync(path.join(root, entry))) {
    failures.push(`${entry} is missing from the repository; run: bun run build`)
  }
}

let packed: string[] = []
try {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
  const parsed = JSON.parse(output) as Array<{ files?: PackFile[] }>
  packed = (parsed[0]?.files ?? []).map((file) => file.path)
} catch (error) {
  failures.push(
    `npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`
  )
}

for (const entry of required) {
  if (packed.length > 0 && !packed.includes(entry)) {
    failures.push(`${entry} is not in the packed file set`)
  }
}

const bundle = path.join(root, "dist", "index.js")
if (fs.existsSync(bundle)) {
  const text = fs.readFileSync(bundle, "utf8")
  for (const marker of staleMarkers) {
    if (!text.includes(marker)) {
      failures.push(
        `dist/index.js is stale: missing "${marker}" (run: bun run build)`
      )
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`prepack: ${failure}`)
  process.exit(1)
}

console.log(`prepack: ${packed.length} packed files, required entries present, dist is current`)
