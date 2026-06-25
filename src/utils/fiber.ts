export const unwrapFiberFailure = <E>(err: unknown): E => {
  if (err && typeof err === "object") {
    const symbols = Object.getOwnPropertySymbols(err)
    for (const sym of symbols) {
      const cause = (err as Record<symbol, unknown>)[sym]
      if (cause && typeof cause === "object" && "_tag" in cause) {
        const c = cause as { _tag: string; failure?: unknown; error?: unknown }
        if (c._tag === "Fail") {
          const v = c.failure !== undefined ? c.failure : c.error
          if (v !== undefined) {
            return v as E
          }
        }
      }
    }
  }
  return err as E
}
