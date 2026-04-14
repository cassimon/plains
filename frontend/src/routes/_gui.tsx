import { MantineProvider } from "@mantine/core"
import { ModalsProvider } from "@mantine/modals"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { AppLayout } from "@/components/AppLayout"
import { ChatWidgetComponent } from "@/components/ChatWidget"
import { theme } from "@/gui/theme"
import { isLoggedIn } from "@/hooks/useAuth"
import { AppProvider } from "@/store/AppContext"

export const Route = createFileRoute("/_gui")({
  component: GuiLayout,
  beforeLoad: async () => {
    if (!isLoggedIn()) {
      throw redirect({ to: "/login" })
    }
  },
})

function GuiLayout() {
  return (
    <MantineProvider theme={theme}>
      <ModalsProvider>
        <AppProvider>
          <AppLayout />
          <ChatWidgetComponent />
        </AppProvider>
      </ModalsProvider>
    </MantineProvider>
  )
}
