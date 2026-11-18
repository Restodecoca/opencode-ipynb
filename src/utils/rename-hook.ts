type RenameHook = (target: string) => Promise<void> | void

let hook: RenameHook | undefined

export const setBeforeRenameHook = (next: RenameHook | undefined): void => {
  hook = next
}

export const beforeRenameHook = async (target: string): Promise<void> => {
  if (hook !== undefined) await hook(target)
}
