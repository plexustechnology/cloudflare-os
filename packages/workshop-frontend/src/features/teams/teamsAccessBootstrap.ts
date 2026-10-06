import { app, authentication } from '@microsoft/teams-js'
import { parseTeamsReturnPath } from './teamsNavigation'

const CALLBACK_PATH = '/teams/auth-complete'
const STATE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMEOUT_MS = 8_000

class TeamsAccessError extends Error {}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Teams unavailable')), TIMEOUT_MS)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Check the Access-protected callback without following a sign-in redirect or reading identity. */
export async function hasTeamsAccessSession(request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`${CALLBACK_PATH}?probe=1`, {
      credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return response.ok && response.headers.get('Content-Type')?.includes('application/json') === true &&
      (await response.json()).ready === true
  } catch { return false }
}

/** Correlate a Teams-managed popup; its result grants no authority and carries no credentials. */
export async function signInToTeamsAccess({
  origin,
  authenticate = authentication.authenticate,
  checkSession = hasTeamsAccessSession,
  randomState = () => crypto.randomUUID(),
}: {
  origin: string
  authenticate?: (parameters: authentication.AuthenticatePopUpParameters) => Promise<string>
  checkSession?: () => Promise<boolean>
  randomState?: () => string
}): Promise<void> {
  const state = randomState()
  if (!STATE_PATTERN.test(state)) throw new TeamsAccessError('Invalid sign-in state')
  const popup = new URL(CALLBACK_PATH, origin)
  popup.searchParams.set('state', state)
  const result = await authenticate({ url: popup.href, width: 600, height: 650 })
  if (result !== state) throw new TeamsAccessError('Sign-in could not be verified. Please retry.')
  if (!await checkSession()) {
    throw new TeamsAccessError('Teams could not use your sign-in session. You can open Plexus OS in your browser.')
  }
}

/** Mount the static sign-in screen and protected popup completion without loading the Workshop. */
export async function mountSignInScreen(): Promise<void> {
  const status = document.getElementById('teams-access-status')
  const button = document.getElementById('teams-access-sign-in')
  const browserLink = document.getElementById('teams-access-browser')
  if (!status || !(button instanceof HTMLButtonElement) || !(browserLink instanceof HTMLAnchorElement)) return
  const url = new URL(window.location.href)
  let destination = parseTeamsReturnPath(url.searchParams.get('destination') ?? undefined) ?? '/workspaces'
  browserLink.href = destination
  try {
    await withTimeout(app.initialize())
    if (url.pathname === CALLBACK_PATH) {
      const state = url.searchParams.get('state')
      if (!state || !STATE_PATTERN.test(state)) throw new Error('Invalid sign-in state')
      authentication.notifySuccess(state)
      status.textContent = 'Signed in. You can close this window.'
      return
    }
    const context = await withTimeout(app.getContext())
    destination = parseTeamsReturnPath(context.page.subPageId) ?? destination
    browserLink.href = destination
    await withTimeout(app.notifySuccess())
    const openWorkshop = () => window.location.replace(`/teams${destination}`)
    button.addEventListener('click', async () => {
      button.disabled = true
      status.textContent = 'Complete sign-in in the window that opens.'
      try {
        await signInToTeamsAccess({ origin: window.location.origin })
        openWorkshop()
      } catch (error) {
        status.textContent = error instanceof TeamsAccessError ? error.message : 'Sign-in was not completed. Please retry.'
        button.disabled = false
      }
    })
    if (await hasTeamsAccessSession()) { openWorkshop(); return }
    status.textContent = 'Sign in to open your Plexus OS workspaces.'
    button.disabled = false
  } catch {
    status.textContent = 'Open Plexus OS in your browser, or reopen this app inside Microsoft Teams.'
  }
}

if (document.getElementById('teams-access-status')) void mountSignInScreen()
