import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Effect } from "effect"
import { makeKernelManager } from "../../src/services/KernelManager.js"
import { makeWarningSink } from "../../src/utils/warnings.js"

const notebook = {
  cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: "x = 1" }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5
}

const writeScript = (dir: string, body: string): string => {
  const file = path.join(dir, "helper.sh")
  fs.writeFileSync(file, body, "utf8")
  fs.chmodSync(file, 0o755)
  return file
}

const shellHelper = (dir: string): string =>
  writeScript(
    dir,
    `#!/bin/sh
IFS= read -r init
printf '{"ready": true, "pid": %s, "kernelPid": %s}\\n' "$$" "$$"
IFS= read -r req
id=$(printf '%s' "$req" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')
printf '{"id": %s, "success": true, "executedCells": [], "durationMs": 1, "outputs": []}\\n' "$id"
`
  )

describe("kernel shutdown through a deleted symlink", () => {
  it("stops the kernel that was started through the link", async () => {
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-kernel-link-"))
    const real = path.join(dir, "real.ipynb")
    const link = path.join(dir, "link.ipynb")
    fs.writeFileSync(real, JSON.stringify(notebook))
    fs.symlinkSync(real, link)
    const helper = shellHelper(dir)
    const sink = makeWarningSink()
    const mgr = makeKernelManager({
      pythonPath: "/bin/sh",
      helperPath: helper,
      workingDirectory: dir,
      defaultTimeoutMs: 10_000,
      warningSink: sink
    })
    try {
      await Effect.runPromise(
        mgr.execute(link, {
          filePath: link,
          mode: "all",
          timeoutMs: 10_000,
          save: false,
          maxOutputChars: 1_000
        })
      )
      const live = mgr.list()
      expect(live).toHaveLength(1)
      const pid = live[0]!.pid
      fs.rmSync(link)
      await Effect.runPromise(mgr.shutdown(link))
      expect(mgr.list()).toHaveLength(0)
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await Effect.runPromise(mgr.disposeAll())
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
