import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const helper = path.resolve("python", "ipynb_runner.py")
const python = path.resolve(".venv", "bin", "python")

const notebook = (): string =>
  JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: "print(1)"
      }
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", file_extension: ".py" }
    },
    nbformat: 4,
    nbformat_minor: 5
  })

interface EnvResponse {
  readonly success: boolean
  readonly env?: { readonly pipFreeze?: ReadonlyArray<string> }
}

const runEnv = (interpreter: string, file: string): EnvResponse => {
  const result = Bun.spawnSync([interpreter, helper], {
    stdin: new TextEncoder().encode(
      JSON.stringify({ filePath: file, mode: "env" })
    ),
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(result.exitCode).toBe(0)
  const line = result.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? ""
  return JSON.parse(line) as EnvResponse
}

describe("env report without pip", () => {
  it("degrades the package list instead of failing on a venv without pip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-nopip-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook())
    const venv = path.join(dir, "nopip")
    try {
      const created = Bun.spawnSync([python, "-m", "venv", "--without-pip", venv], {
        stdout: "pipe",
        stderr: "pipe"
      })
      expect(created.exitCode).toBe(0)
      const noPip = path.join(venv, "bin", "python")
      expect(fs.existsSync(noPip)).toBe(true)
      const probe = Bun.spawnSync([noPip, "-c", "import pip"], {
        stdout: "pipe",
        stderr: "pipe"
      })
      expect(probe.exitCode).not.toBe(0)
      const response = runEnv(noPip, file)
      expect(response.success).toBe(true)
      expect(response.env?.pipFreeze).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it("still reports the package list when pip is available", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-withpip-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook())
    try {
      const response = runEnv(python, file)
      expect(response.success).toBe(true)
      expect(Array.isArray(response.env?.pipFreeze)).toBe(true)
      expect((response.env?.pipFreeze ?? []).length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
