import { describe, expect, it } from "bun:test"
import {
  diagnosticsSkipReason,
  hasShellMetacharacters,
  shellCommandRefusal,
  ShellCommandError
} from "../../src/notebook-diagnostics.js"

describe("shell metacharacter guard", () => {
  it("rejects every character a cmd shell would reinterpret", () => {
    const rejected = [
      "C:\\dir%PATH%\\pyright.cmd",
      "C:\\tom & jerry\\pyright.cmd",
      "C:\\a|b\\pyright.cmd",
      "C:\\a<b\\pyright.cmd",
      "C:\\a>b\\pyright.cmd",
      "C:\\a^b\\pyright.cmd",
      "C:\\a\"b\\pyright.cmd",
      "C:\\a\rb\\pyright.cmd",
      "C:\\a\nb\\pyright.cmd"
    ]
    for (const value of rejected) {
      expect(hasShellMetacharacters(value)).toBe(true)
    }
  })

  it("accepts ordinary command paths and arguments", () => {
    const accepted = [
      "pyright",
      "pyright.cmd",
      "C:\\Program Files\\pyright\\pyright.cmd",
      "/usr/local/bin/pyright",
      "--outputjson",
      "--pythonpath",
      "/home/user/notebooks/dir with spaces/n.py",
      "/home/user/ünicode-𝄞/n.py",
      "C:\\dir(parens)\\pyright.cmd"
    ]
    for (const value of accepted) {
      expect(hasShellMetacharacters(value)).toBe(false)
    }
  })

  it("refuses only when the shell path is active", () => {
    const dirty = "C:\\dir%VAR%\\pyright.cmd"
    expect(shellCommandRefusal(dirty, [], false)).toBeUndefined()
    expect(shellCommandRefusal(dirty, [], true)).toBeInstanceOf(ShellCommandError)
    expect(shellCommandRefusal("pyright.cmd", ["--outputjson", "C:\\a&b\\n.py"], true)).toBeInstanceOf(
      ShellCommandError
    )
    expect(
      shellCommandRefusal("C:\\Program Files\\pyright\\pyright.cmd", ["--outputjson", "C:\\clean\\n.py"], true)
    ).toBeUndefined()
  })

  it("names the offending part of the command line", () => {
    const command = shellCommandRefusal("C:\\a%b\\pyright.cmd", [], true)
    expect(command?.message).toContain("%")
    expect(command?.message).toContain("command")
    const arg = shellCommandRefusal("pyright.cmd", ["--outputjson", "C:\\a|b\\n.py"], true)
    expect(arg?.message).toContain("C:")
    expect(arg?.message).toContain("|")
    expect(arg?.message).toContain("argument")
  })

  it("classifies a refused command as unsafe-shell-command", () => {
    expect(diagnosticsSkipReason(new ShellCommandError("refused"))).toBe("unsafe-shell-command")
    expect(diagnosticsSkipReason(Object.assign(new Error("spawn missing"), { code: "ENOENT" }))).toBe(
      "pyright-not-found"
    )
    expect(diagnosticsSkipReason(Object.assign(new Error("spawn denied"), { code: "EACCES" }))).toBe(
      "pyright-not-executable"
    )
    expect(diagnosticsSkipReason(Object.assign(new Error("spawn denied"), { code: "EPERM" }))).toBe(
      "pyright-not-executable"
    )
    expect(diagnosticsSkipReason(Object.assign(new Error("spawn denied"), { code: "EROFS" }))).toBe(
      "pyright-not-executable"
    )
    expect(diagnosticsSkipReason(new Error("anything else"))).toBe("invalid-output")
  })
})
