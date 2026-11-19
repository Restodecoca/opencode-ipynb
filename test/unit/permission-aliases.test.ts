import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { permissionAliases } from "../../src/services/PermissionService.js"

describe("permissionAliases", () => {
  it("returns both the lexical and real path for a symlink alias", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-alias-"))
    const real = path.join(dir, "real.ipynb")
    const alias = path.join(dir, "alias.ipynb")
    fs.writeFileSync(real, "{}")
    fs.symlinkSync(real, alias)
    try {
      const paths = await permissionAliases(alias, [dir])
      expect(paths).toContain(alias)
      expect(paths).toContain(real)
      expect(paths).toContain("alias.ipynb")
      expect(paths).toContain("real.ipynb")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("resolves the real parent for a new file under a symlinked directory", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-dir-"))
    const real = path.join(root, "real")
    const link = path.join(root, "link")
    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    try {
      const paths = await permissionAliases(path.join(link, "new.ipynb"))
      expect(paths).toHaveLength(2)
      expect(paths[1]).toBe(path.join(real, "new.ipynb"))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it("emits relative aliases when the base root is itself a symlink", async () => {
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-root-"))
    const real = path.join(root, "real")
    const link = path.join(root, "link")
    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    const file = path.join(real, "secret.ipynb")
    fs.writeFileSync(file, "{}")
    try {
      const paths = await permissionAliases(file, [link, link])
      expect(paths).toContain("secret.ipynb")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("resolves a not-yet-existing file through a symlinked ancestor", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return
    if (process.platform === "win32") return
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ipynb-perm-deep-"))
    const real = path.join(root, "real")
    const link = path.join(root, "link")
    fs.mkdirSync(real)
    fs.symlinkSync(real, link)
    const file = path.join(link, "new", "out.py")
    try {
      const paths = await permissionAliases(file, [root])
      expect(paths).toContain(file)
      expect(paths).toContain(path.join(real, "new", "out.py"))
      expect(paths).toContain(path.join("real", "new", "out.py"))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

})
