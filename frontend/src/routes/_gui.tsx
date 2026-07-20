import { MantineProvider } from "@mantine/core"
import { ModalsProvider } from "@mantine/modals"
import { Notifications } from "@mantine/notifications"
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
      {/* Renders Mantine `notifications.show(...)` toasts — without this the
          upload-flow warnings (e.g. "Upload already in progress") fire into the
          void. zIndex sits above modals (1000) so warnings stay visible. */}
      <Notifications position="top-center" zIndex={2000} />
      <AppProvider>
        {/* Mantine's default modal z-index (200) is below Popover's (300), so a
            confirm modal opened from inside a Popover.Dropdown (e.g. the upload
            flow panel) would render behind it without this override. */}
        <ModalsProvider modalProps={{ zIndex: 1000 }}>
          <AppLayout />
        </ModalsProvider>
      </AppProvider>
    </MantineProvider>
  )
}
