import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const readJson = (file: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", file), "utf8")) as Record<
    string,
    unknown
  >

describe("Effect version alignment", () => {
  it("uses the same Effect 4 version as OpenCode 2's plugin SDK", () => {
    const pkg = readJson("package.json")
    const dev = pkg.devDependencies as Record<string, string>
    const installed = readJson("node_modules/effect/package.json")
    const sdk = readJson("node_modules/@opencode/plugin/package.json")
    const sdkDeps = sdk.dependencies as Record<string, string>

    expect(dev.effect).toBe("4.0.6")
    expect(installed.version).toBe("4.0.6")
    expect(sdkDeps.effect).toBe("4.0.6")
  })
})
