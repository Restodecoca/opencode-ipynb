import { describe, expect, it } from "bun:test"
import * as os from "node:os"
import { Effect } from "effect"
import { makePathService } from "../../src/services/PathService.js"
import { absoluteDriveRoot } from "../../src/utils/paths.js"

describe("absoluteDriveRoot", () => {
  it("turns a bare drive into an absolute root on win32 only", () => {
    expect(absoluteDriveRoot("C:", "win32")).toBe("C:\\")
    expect(absoluteDriveRoot("d:", "win32")).toBe("d:\\")
    expect(absoluteDriveRoot("C:\\", "win32")).toBe("C:\\")
    expect(absoluteDriveRoot("C:\\Windows", "win32")).toBe("C:\\Windows")
    expect(absoluteDriveRoot("/home/x", "win32")).toBe("/home/x")
    expect(absoluteDriveRoot("", "win32")).toBe("")
    expect(absoluteDriveRoot("C:", "linux")).toBe("C:")
  })
})

describe("worktree confinement on windows", () => {
  it("rejects drive roots and other drives", async () => {
    if (process.platform !== "win32") return
    const worktree = os.tmpdir()
    const svc = makePathService({
      directory: worktree,
      worktree,
      platform: process.platform
    })
    const rejected = [
      "C:\\",
      "C:\\etc\\outside.ipynb",
      "D:\\nope\\outside.ipynb"
    ]
    for (const candidate of rejected) {
      const exit = await Effect.runPromiseExit(
        svc.ensureInsideWorktree(candidate)
      )
      expect(exit._tag).toBe("Failure")
    }
    const inside = await Effect.runPromiseExit(
      svc.ensureInsideWorktree(`${worktree}\\ok.ipynb`)
    )
    expect(inside._tag).toBe("Success")
  })
})
