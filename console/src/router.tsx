import type { QueryClient } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'
import type { AuthState } from './lib/auth'
import { NotFoundPage } from './veridian/error-pages'

export interface RouterContext {
  auth: AuthState
  queryClient: QueryClient
}

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { auth: undefined!, queryClient },
    defaultPreload: 'intent',
    // 404 brandé Veridian pour toute route enfant non trouvée (ticket U9).
    defaultNotFoundComponent: NotFoundPage,
  })
}

export type AppRouter = ReturnType<typeof createAppRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter
  }
}
