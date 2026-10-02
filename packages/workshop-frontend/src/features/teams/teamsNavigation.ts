const SAFE_ORIGIN = 'https://cloudflare-os.invalid'
const DEFAULT_TEAMS_DESTINATION = '/workspaces'
const SIMPLE_DESTINATIONS = new Set([
  '/workspaces',
  '/outputs',
  '/blueprints',
  '/gatekeepers',
  '/providers',
  '/profile',
  '/context',
  '/explore',
])

export function routerBasepath(pathname: string): '/' | '/teams' {
  return pathname === '/teams' || pathname.startsWith('/teams/') ? '/teams' : '/'
}

/** Restores the browser-visible path after the router removes its configured base path. */
export function pathWithRouterBasepath(pathname: string, basepath: string): string {
  if (basepath === '/' || pathname === basepath || pathname.startsWith(`${basepath}/`)) {
    return pathname
  }

  return pathname === '/' ? basepath : `${basepath}${pathname}`
}

function normalizePathname(pathname: string): string | null {
  if (SIMPLE_DESTINATIONS.has(pathname)) return pathname

  const entityMatch = pathname.match(/^\/(workspace|blueprint|gatekeepers)\/([A-Za-z0-9_-]+)$/)
  if (!entityMatch) return null
  return `/${entityMatch[1]}/${entityMatch[2]}`
}

function hasValidSearch(pathname: string, searchParams: URLSearchParams): boolean {
  if (searchParams.size === 0) return true
  if (!pathname.startsWith('/workspace/')) return false

  for (const [key, value] of searchParams) {
    if ((key !== 'chat' && key !== 'w') || !/^\d+$/.test(value)) return false
    if (searchParams.getAll(key).length !== 1) return false
  }
  return true
}

/** Returns a safe Workshop route or null; external, privileged, malformed, and unknown paths fail closed. */
export function parseTeamsReturnPath(candidate: string | undefined): string | null {
  if (
    !candidate ||
    candidate.length > 2_048 ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\')
  ) {
    return null
  }

  try {
    const url = new URL(candidate, SAFE_ORIGIN)
    if (url.origin !== SAFE_ORIGIN || url.hash) return null

    const pathname = normalizePathname(url.pathname.replace(/\/$/, ''))
    if (!pathname || !hasValidSearch(pathname, url.searchParams)) return null
    return `${pathname}${url.search}`
  } catch {
    return null
  }
}

/** Removes the Teams router base path without accepting lookalike paths. */
export function appPathFromTeamsPath(pathname: string): string | null {
  if (pathname === '/teams' || pathname === '/teams/') return '/'
  return pathname.startsWith('/teams/') ? pathname.slice('/teams'.length) : null
}

/** Chooses a validated deep-link hint, current Teams route, or the Workspaces default in that order. */
export function resolveTeamsDestination({
  pathname,
  search = '',
  subPageId,
}: {
  pathname: string
  search?: string
  subPageId?: string
}): string {
  const contextDestination = parseTeamsReturnPath(subPageId)
  if (contextDestination) return contextDestination

  const currentPath = appPathFromTeamsPath(pathname)
  if (currentPath && currentPath !== '/') {
    const currentDestination = parseTeamsReturnPath(`${currentPath}${search}`)
    if (currentDestination) return currentDestination
  }

  return DEFAULT_TEAMS_DESTINATION
}

/** Builds the same-origin top-level URL used by the pilot browser-login recovery. */
export function buildTeamsBrowserUrl(origin: string, destination: string): string {
  const safeDestination = parseTeamsReturnPath(destination) ?? DEFAULT_TEAMS_DESTINATION
  return new URL(safeDestination, origin).href
}
