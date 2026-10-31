import * as path from "node:path"
import type { ToolContext } from "../tool.js"
import { PermissionDeniedError } from "../domain/errors.js"
import { permissionAliases } from "../services/PermissionService.js"

/**
 * Custom V2 tools are not automatically covered by the host's native `read`
 * action. Ask explicitly before handing notebook content to a read-only tool.
 * The lexical and resolved paths are both requested so a symlink alias cannot
 * bypass a deny rule on the real notebook.
 */
export const assertReadPermission = async (
  context: ToolContext,
  filePath: string
): Promise<void> => {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(context.directory, filePath)
  const patterns = await permissionAliases(absolute, [
    context.directory,
    context.worktree
  ])
  try {
    await context.ask({
      permission: "read",
      patterns: [...patterns],
      always: [...patterns],
      metadata: { filePath: absolute, action: "ipynb_read" }
    })
  } catch (error) {
    throw new PermissionDeniedError({
      message: error instanceof Error ? error.message : String(error),
      action: "read",
      cause: error
    })
  }
}
