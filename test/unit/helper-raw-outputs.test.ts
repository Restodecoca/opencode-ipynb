import { expect, it } from "bun:test"
import { describeIf, realHelperEnabled } from "../helpers.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const helper = path.resolve("python", "ipynb_runner.py")
const python = "python"

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

interface RunOutput {
  readonly rawOutputs?: ReadonlyArray<Record<string, unknown>>
  readonly displayData?: ReadonlyArray<{ mime: string }>
}

interface RunResponse {
  readonly success: boolean
  readonly outputs: ReadonlyArray<RunOutput>
}

const run = (payload: Record<string, unknown>): RunResponse => {
  const result = Bun.spawnSync([python, helper], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(result.exitCode).toBe(0)
  const line = result.stdout.toString().trim().split("\n").filter(Boolean).at(-1) ?? ""
  return JSON.parse(line) as RunResponse
}

describeIf(realHelperEnabled(), "raw outputs are requested when the result is saved", () => {
  if (process.platform === "win32") return
  it("keeps the html bundle when includeRawOutputs is set", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-raw-mime-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(
      file,
      notebook(
        "from IPython.display import HTML, display\ndisplay(HTML('<b>raw</b>'))"
      )
    )
    try {
      const saved = run({
        filePath: file,
        mode: "cell",
        cellIndex: 0,
        timeoutMs: 60_000,
        includeRawOutputs: true,
        maxOutputChars: 6_000
      })
      expect(saved.success).toBe(true)
      const savedRaw = JSON.stringify(saved.outputs)
      expect(savedRaw).toContain("text/html")
      expect(savedRaw).toContain("<b>raw</b>")

      const summaryOnly = run({
        filePath: file,
        mode: "cell",
        cellIndex: 0,
        timeoutMs: 60_000,
        includeRawOutputs: false,
        maxOutputChars: 6_000
      })
      expect(summaryOnly.success).toBe(true)
      expect(JSON.stringify(summaryOnly.outputs)).not.toContain("<b>raw</b>")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
