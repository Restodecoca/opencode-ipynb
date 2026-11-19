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

// A killed helper that nobody reaps becomes a zombie, and signal 0 still
// succeeds for a zombie. On Linux read the process state so "alive" means
// actually running, not merely present in the process table.
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3)
    return state !== "Z" && state !== "X"
  } catch {
    return true
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return predicate()
}

describeIf(realHelperEnabled(), "parent death watchdog", () => {
  it("kills the helper and its kernel when the parent dies mid-cell", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-watchdog-"))
    const file = path.join(dir, "n.ipynb")
    fs.writeFileSync(file, notebook("import time\ntime.sleep(30)\nprint(1)"))
    // The parent is a small shell that spawns the helper and then sleeps; killing
    // it reproduces a plugin crash while a cell is running.
    const driver = path.join(dir, "driver.sh")
    fs.writeFileSync(
      driver,
      `#!/bin/sh
${JSON.stringify(python)} ${JSON.stringify(helper)} < ${JSON.stringify(path.join(dir, "requests.ndjson"))} > ${JSON.stringify(path.join(dir, "out.ndjson"))} 2>/dev/null &
echo $! > ${JSON.stringify(path.join(dir, "child.pid"))}
sleep 300
`
    )
    fs.chmodSync(driver, 0o755)
    fs.writeFileSync(
      path.join(dir, "requests.ndjson"),
      `${JSON.stringify({ mode: "serve", filePath: file, timeoutMs: 60_000 })}\n${JSON.stringify({
        id: 1,
        mode: "cell",
        cellIndex: 0,
        timeoutMs: 60_000
      })}\n`
    )
    const parent = Bun.spawn(["/bin/sh", driver], {
      stdout: "ignore",
      stderr: "ignore"
    })
    try {
      const pidFile = path.join(dir, "child.pid")
      expect(await waitFor(() => fs.existsSync(pidFile), 10_000)).toBe(true)
      const helperPid = Number(fs.readFileSync(pidFile, "utf8").trim())
      expect(Number.isInteger(helperPid)).toBe(true)
      const outFile = path.join(dir, "out.ndjson")
      expect(
        await waitFor(
          () => fs.existsSync(outFile) && fs.readFileSync(outFile, "utf8").includes('"ready"'),
          20_000
        )
      ).toBe(true)
      // Give the cell time to start, then kill the parent.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(alive(helperPid)).toBe(true)
      parent.kill("SIGKILL")
      const gone = await waitFor(() => !alive(helperPid), 15_000)
      expect(gone).toBe(true)
    } finally {
      try {
        parent.kill("SIGKILL")
      } catch {}
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
