import { MantineProvider } from "@mantine/core"
import { ModalsProvider } from "@mantine/modals"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { useMemo } from "react"
import { AppLayout } from "@/components/AppLayout"
import { ChatWidgetComponent } from "@/components/ChatWidget"
import { OpenAPI } from "@/client"
import { theme } from "@/gui/theme"
import { isLoggedIn } from "@/hooks/useAuth"
import { AppProvider } from "@/store/AppContext"
import { HttpBackend } from "@/store/backend"

export const Route = createFileRoute("/_gui")({
  component: GuiLayout,
  beforeLoad: async () => {
    if (!isLoggedIn()) {
      throw redirect({ to: "/login" })
    }
  },
})

function GuiLayout() {
  const backend = useMemo(
    () => new HttpBackend(`${OpenAPI.BASE}/api/v1`),
    [],
  )

  return (
    <MantineProvider theme={theme}>
      <ModalsProvider>
        <AppProvider backend={backend}>
          <AppLayout />
          <ChatWidgetComponent />
        </AppProvider>
      </ModalsProvider>
    </MantineProvider>
  )
}
