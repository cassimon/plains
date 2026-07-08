import { Button, Modal, Stack, Text } from "@mantine/core"
import { useState } from "react"

/**
 * Blocks a page behind an acknowledgement modal until the user clicks OK.
 * Used for pages that exist in the nav but aren't ready for real use yet.
 */
export function ComingSoonGate({
  featureName,
  children,
}: {
  featureName: string
  children: React.ReactNode
}) {
  const [acknowledged, setAcknowledged] = useState(false)

  return (
    <>
      <Modal
        opened={!acknowledged}
        onClose={() => {}}
        withCloseButton={false}
        closeOnClickOutside={false}
        closeOnEscape={false}
        centered
        title="Coming soon"
      >
        <Stack gap="md">
          <Text size="sm">
            {featureName} is not yet available. This page will be enabled in a
            future version.
          </Text>
          <Button onClick={() => setAcknowledged(true)} fullWidth>
            OK
          </Button>
        </Stack>
      </Modal>
      {acknowledged && children}
    </>
  )
}
