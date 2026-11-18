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

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

const runHelper = (payload: unknown): Run => {
  const result = Bun.spawnSync([python, helper], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe"
  })
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  }
}

const parse = (stdout: string): Record<string, unknown> => {
  const line = stdout.trim().split("\n").filter(Boolean).at(-1) ?? ""
  return JSON.parse(line) as Record<string, unknown>
}

describe("helper input validation", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["maxOutputChars", "x"],
    ["maxOutputChars", 1.5],
    ["maxOutputChars", -5],
    ["timeoutMs", null],
    ["timeoutMs", "soon"],
    ["timeoutMs", true]
  ]

  for (const [field, value] of cases) {
    it(`rejects ${field}=${JSON.stringify(value)} with a structured error`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-helper-validate-"))
      const file = path.join(dir, "n.ipynb")
      fs.writeFileSync(file, notebook())
      try {
        const run = runHelper({
          filePath: file,
          mode: "cell",
          cellIndex: 0,
          [field]: value
        })
        expect(run.code).toBe(0)
        expect(run.stderr).not.toContain("Traceback (most recent call last)")
        const response = parse(run.stdout)
        expect(response.success).toBe(false)
        const error = response.error as { evalue?: string }
        expect(error.evalue).toContain(field)
        expect(error.evalue).toContain("positive integer")
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
