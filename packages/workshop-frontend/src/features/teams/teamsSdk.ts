import { app } from '@microsoft/teams-js'
import type { TeamsSdkPort } from './teamsHost'

/** Coalesces host initialization while allowing another attempt after rejection. */
export function createRecoverableTeamsInitializer(initialize: () => Promise<void>): () => Promise<void> {
  let initialization: Promise<void> | undefined
  return () => {
    initialization ??= initialize().catch((error: unknown) => {
      initialization = undefined
      throw error
    })
    return initialization
  }
}

/** Display-only SDK adapter: authentication continues through Workshop's existing session. */
export const teamsSdk: TeamsSdkPort = {
  initialize: createRecoverableTeamsInitializer(() => app.initialize()),
  getContext: () => app.getContext(),
  notifySuccess: () => app.notifySuccess(),
  registerOnThemeChangeHandler: (handler) => app.registerOnThemeChangeHandler(handler),
}
