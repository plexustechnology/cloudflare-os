import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import { routerBasepath } from './features/teams/teamsNavigation'

export function createRouter(pathname = typeof window === 'undefined' ? '/' : window.location.pathname) {
  return createTanStackRouter({
    routeTree,
    basepath: routerBasepath(pathname),
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
