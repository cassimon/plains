import { List, Modal, Stack, Text, Title } from "@mantine/core"

/** Concise in-app "Getting started" help, opened from the user menu. */
export function HelpModal({
  opened,
  onClose,
}: {
  opened: boolean
  onClose: () => void
}) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Getting started"
      size="lg"
      centered
    >
      <Stack gap="md">
        <Text size="sm">
          Plains is a lab notebook for perovskite solar cell research: organize
          planes, plan fabrication processes, and record measurement results.
        </Text>

        <div>
          <Title order={5} mb={4}>
            Two ways to start
          </Title>
          <List size="sm" withPadding>
            <List.Item>
              <b>Data first</b>: open <b>Results</b>, drop your files, folder or
              ZIP archive, review the parsed measurements and assign substrates.
              You do not need a process.
            </List.Item>
            <List.Item>
              <b>Plan first</b>: create a <b>Process</b>, generate an{" "}
              <b>Experiment</b> from it, then add results.
            </List.Item>
          </List>
        </div>

        <div>
          <Title order={5} mb={4}>
            Main sections
          </Title>
          <List size="sm" withPadding>
            <List.Item>
              <b>Organization</b> — planes and collections.
            </List.Item>
            <List.Item>
              <b>Processes / Experiments</b> — fabrication steps and runs.
            </List.Item>
            <List.Item>
              <b>Results</b> — measurement files and JV values.
            </List.Item>
          </List>
        </div>

        <div>
          <Title order={5} mb={4}>
            Supported measurements
          </Title>
          <Text size="sm">
            CHOSE <code>Stability (JV)</code> files (forward/reverse) and
            <code>JV Summary_Parameters FW/RV.txt</code> are parsed with device,
            cell and pixel identifiers. Other formats (Dark JV, IPCE, Stability,
            UV-Vis) are also recognized.
          </Text>
        </div>

        <Text size="xs" c="dimmed">
          Full guide: <code>docs/USER_GUIDE.md</code> in the repository.
        </Text>
      </Stack>
    </Modal>
  )
}
