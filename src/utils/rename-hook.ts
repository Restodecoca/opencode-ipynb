type RenameHook = (target: string) => Promise<void> | void

let beforeHook: RenameHook | undefined
let afterHook: RenameHook | undefined

export const setBeforeRenameHook = (next: RenameHook | undefined): void => {
  beforeHook = next
}

export const setAfterRenameHook = (next: RenameHook | undefined): void => {
  afterHook = next
}

export const beforeRenameHook = async (target: string): Promise<void> => {
  if (beforeHook !== undefined) await beforeHook(target)
}

export const afterRenameHook = async (target: string): Promise<void> => {
  if (afterHook !== undefined) await afterHook(target)
}
