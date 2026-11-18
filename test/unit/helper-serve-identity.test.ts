import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const helper = path.resolve("python", "ipynb_runner.py")
const python = path.resolve(".venv", "bin", "python")

const notebook = (source: string): string =>
  JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source
      }
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python", file_extension: ".py" }
    },
    nbformat: 4,
    nbformat_minor: 5
  })

interface ServeResponse {
  readonly id?: number
  readonly success: boolean
  readonly error?: { readonly ename?: string; readonly evalue?: string }
}

const serve = (init: Record<string, unknown>, requests: ReadonlyArray<unknown>): ServeResponse[] => {
  const input = [init, ...requests].map((item) => JSON.stringify(item)).join("\n") + "\n"
  const result = Bun.spawnSync([python, helper], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(result.exitCode).toBe(0)
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ServeResponse)
}

describe("serve mode notebook identity", () => {
  it("refuses a request that names a different notebook than the kernel serves", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-serve-mismatch-"))
    const initFile = path.join(dir, "init.ipynb")
    const otherFile = path.join(dir, "other.ipynb")
    try {
      fs.writeFileSync(initFile, notebook("print('FROM_INIT')"))
      fs.writeFileSync(otherFile, notebook("print('FROM_OTHER')"))
      const [ready, ...responses] = serve(
        { mode: "serve", filePath: initFile, timeoutMs: 60_000 },
        [
          { id: 1, mode: "cell", cellIndex: 0, filePath: otherFile, timeoutMs: 60_000 },
          { id: 2, mode: "cell", cellIndex: 0, timeoutMs: 60_000 },
          { mode: "shutdown" }
        ]
      )
      expect(ready).toBeDefined()
      const mismatch = responses.find((response) => response.id === 1)
      expect(mismatch?.success).toBe(false)
      expect(mismatch?.error?.ename).toBe("NotebookMismatch")
      expect(mismatch?.error?.evalue ?? "").toContain("other.ipynb")
      const served = responses.find((response) => response.id === 2)
      expect(served?.success).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
