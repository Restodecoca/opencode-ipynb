import type { ToolContext } from "../tool.js"
import { resolveOptionsFromEnv } from "../services/index.js"

export const resolveToolOptions = (context?: ToolContext) =>
  resolveOptionsFromEnv(context?.pluginOptions)
