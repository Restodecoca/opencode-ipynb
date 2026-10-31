import type { ToolContext } from "../tool.js"
import { resolveOptionsFromEnv } from "../services/index.js"

// Thin re-export so tools/ can use the same resolver as services/.
// Keeping the implementation in services/index.ts ensures both layers
// agree on env handling and fallback semantics.
export const resolveToolOptions = (context?: ToolContext) =>
  resolveOptionsFromEnv(context?.pluginOptions)
