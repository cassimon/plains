import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query"
import { createRouter, RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import ReactDOM from "react-dom/client"
import { ApiError, OpenAPI } from "./client"
import { ThemeProvider } from "./components/theme-provider"
import { Toaster } from "./components/ui/sonner"
import { clearKeycloak, getTokenAsync } from "./lib/keycloakInstance"
import "@mantine/core/styles.css"
import "@mantine/notifications/styles.css"
import "./index.css"
import { routeTree } from "./routeTree.gen"

OpenAPI.BASE = import.meta.env.VITE_API_URL
OpenAPI.TOKEN = () => getTokenAsync()

const handleApiError = (error: Error) => {
  if (error instanceof ApiError && [401, 403].includes(error.status)) {
    clearKeycloak()
    window.location.href = `${import.meta.env.BASE_URL}login`
  }
}
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: handleApiError,
  }),
  mutationCache: new MutationCache({
    onError: handleApiError,
  }),
})

// Guard against stale-chunk errors after a redeploy. Pages are lazily loaded as
// hashed chunks (TanStack `autoCodeSplitting`), so rebuilding the frontend while
// a tab is open leaves the old tab requesting chunk hashes that no longer exist
// on disk (e.g. results-CM8WUKcq.js). nginx's SPA fallback (`try_files $uri
// /index.html`) then returns index.html for that `.js` request, the browser
// blocks the module for its `text/html` MIME type, and the lazy route import
// throws — surfacing as a broken/"logged out" navigation. Vite dispatches
// `vite:preloadError` in exactly this case; reload once to pick up the fresh
// index.html and new chunk hashes. The sessionStorage timestamp caps us to one
// auto-reload per 10s so a genuinely-missing chunk can't cause a reload loop.
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault()
  const RELOAD_KEY = "plains:chunk-reload-at"
  const lastReload = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  if (Date.now() - lastReload < 10_000) return
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  window.location.reload()
})

const router = createRouter({ routeTree, basepath: import.meta.env.BASE_URL })
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster richColors closeButton />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
