export const TEAMS_HOST_INITIALIZATION_TIMEOUT_MS = 8_000

export type TeamsHostTheme = 'light' | 'dark' | 'contrast'

/**
 * The deliberately narrow, display-only subset of Teams context exposed to the Workshop UI.
 * None of these fields prove identity or authorization. A future deep-link resolver must validate
 * `subPageId` as an internal destination before using it for navigation.
 */
export interface TeamsHostContext {
  locale?: string
  hostName?: string
  frameContext?: string
  subPageId?: string
  isMultiWindow: boolean
  theme: TeamsHostTheme
}

export type TeamsHostState =
  | { status: 'outside-teams' }
  | { status: 'ready'; context: TeamsHostContext }
  | { status: 'error'; reason: 'initialization-failed' | 'timeout' }

export interface TeamsHostSession {
  state: TeamsHostState
  dispose: () => void
}

/** The SDK surface kept behind this adapter so tests and domain UI never import TeamsJS. */
export interface TeamsSdkPort {
  initialize: () => Promise<void>
  getContext: () => Promise<TeamsSdkContext>
  notifySuccess: () => Promise<unknown>
  registerOnThemeChangeHandler: (handler: (theme: string) => void) => void
}

/** Structural subset of `app.Context`; identity-bearing Teams fields are intentionally absent. */
export interface TeamsSdkContext {
  app: {
    locale?: string
    theme?: string
    host?: { name?: string }
  }
  page?: {
    frameContext?: string
    subPageId?: string
    isMultiWindow?: boolean
  }
}

interface InitializeTeamsHostOptions {
  pathname: string
  sdk: TeamsSdkPort
  timeoutMs?: number
  onThemeChange?: (theme: TeamsHostTheme) => void
}

class TeamsHostTimeoutError extends Error {}

const activeThemeHandlers = new WeakMap<TeamsSdkPort, (theme: string) => void>()

export function isTeamsRoute(pathname: string): boolean {
  return pathname === '/teams' || pathname.startsWith('/teams/')
}

export function resolveTeamsHostTheme(theme: string | undefined): TeamsHostTheme {
  switch (theme?.toLowerCase()) {
    case 'dark':
      return 'dark'
    case 'contrast':
      return 'contrast'
    case 'default':
    case 'glass':
    default:
      return 'light'
  }
}

function boundedString(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined
  return value
}

function resolveDisplayContext(context: TeamsSdkContext): TeamsHostContext {
  return {
    locale: boundedString(context.app.locale, 128),
    hostName: boundedString(context.app.host?.name, 128),
    frameContext: boundedString(context.page?.frameContext, 128),
    subPageId: boundedString(context.page?.subPageId, 2_048),
    isMultiWindow: context.page?.isMultiWindow === true,
    theme: resolveTeamsHostTheme(context.app.theme),
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => reject(new TeamsHostTimeoutError()), timeoutMs)
  })

  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

/**
 * Initializes TeamsJS on `/teams` routes and returns a disposable, framework-neutral session.
 * Failures are converted to presentation state; this adapter never authenticates a user.
 */
export async function initializeTeamsHost({
  pathname,
  sdk,
  timeoutMs = TEAMS_HOST_INITIALIZATION_TIMEOUT_MS,
  onThemeChange = () => {},
}: InitializeTeamsHostOptions): Promise<TeamsHostSession> {
  if (!isTeamsRoute(pathname)) {
    return { state: { status: 'outside-teams' }, dispose: () => {} }
  }

  const operation = Promise.resolve()
    .then(() => sdk.initialize())
    .then(() => sdk.getContext())
    .then(async (context) => {
      await sdk.notifySuccess()
      return context
    })

  try {
    const context = resolveDisplayContext(await withTimeout(operation, timeoutMs))
    let active = true
    const themeHandler = (theme: string) => {
      if (active) onThemeChange(resolveTeamsHostTheme(theme))
    }
    sdk.registerOnThemeChangeHandler(themeHandler)
    activeThemeHandlers.set(sdk, themeHandler)

    return {
      state: { status: 'ready', context },
      dispose: () => {
        if (!active) return
        active = false
        // TeamsJS permits one theme handler but has no public unregister API. Replacing our handler
        // releases its closure and prevents callbacks into an unmounted Workshop tree.
        // A StrictMode cleanup may finish after a newer session has registered its handler.
        if (activeThemeHandlers.get(sdk) !== themeHandler) return
        activeThemeHandlers.delete(sdk)
        sdk.registerOnThemeChangeHandler(() => {})
      },
    }
  } catch (error) {
    return {
      state: {
        status: 'error',
        reason: error instanceof TeamsHostTimeoutError ? 'timeout' : 'initialization-failed',
      },
      dispose: () => {},
    }
  }
}
