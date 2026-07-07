import { MantineProvider } from "@mantine/core"
import { ModalsProvider } from "@mantine/modals"
import { createFileRoute } from "@tanstack/react-router"
import { AppLayout } from "@/components/AppLayout"
import { theme } from "@/gui/theme"
import { ensureAuthenticated } from "@/lib/auth"
import { AppProvider } from "@/store/AppContext"

export const Route = createFileRoute("/_gui")({
  component: GuiLayout,
  beforeLoad: ensureAuthenticated,
})

function GuiLayout() {
  return (
    <MantineProvider theme={theme}>
      <AppProvider>
        <ModalsProvider>
          <AppLayout />
        </ModalsProvider>
      </AppProvider>
    </MantineProvider>
  )
}
