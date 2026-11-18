import { Effect } from "effect"

export type WarningSource =
  | "atomic-replace"
  | "cleanup"
  | "format-detection"
  | "json-patch"
  | "lock"
  | "permission-alias"
  | "path-resolution"
  | "python-probe"
  | "revision-check"
  | "sidecar-cleanup"
  | "temp-unlink"

export interface Warning {
  readonly source: WarningSource
  readonly message: string
  readonly detail?: string
}

export interface WarningSink {
  readonly add: (warning: Warning) => void
  readonly drain: () => ReadonlyArray<Warning>
}

export const makeWarningSink = (): WarningSink => {
  let warnings: Warning[] = []
  return {
    add: (warning) => {
      warnings.push(warning)
    },
    drain: () => {
      const drained = warnings
      warnings = []
      return drained
    }
  }
}

export const warningFrom = (
  source: WarningSource,
  error: unknown,
  context?: string
): Warning => {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const detail = context === undefined ? code : `${context}: ${code ?? message}`
  return {
    source,
    message,
    ...(detail === undefined ? {} : { detail })
  }
}

export const ignoreExpectedFailure = <A>(
  sink: WarningSink | undefined,
  source: WarningSource,
  context: string,
  effect: Effect.Effect<A, unknown>
): Effect.Effect<A | undefined> =>
  Effect.orElseSucceed(effect, (error) => {
    sink?.add(warningFrom(source, error, context))
    return undefined
  })

export const bestEffort = async (
  sink: WarningSink | undefined,
  source: WarningSource,
  context: string,
  action: () => Promise<unknown>
): Promise<void> => {
  try {
    await action()
  } catch (error) {
    sink?.add(warningFrom(source, error, context))
  }
}
