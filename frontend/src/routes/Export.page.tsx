import { Container, Divider, Text, Title } from "@mantine/core"
import { ZipExplorer } from "@/components/ZipExplorer"

export function ExportPage() {
  return (
    <Container size="lg">
      <Title order={2} mt="md">
        Export
      </Title>
      <Text c="dimmed" mt="sm">
        Prepare experimental data for export and NOMAD upload.
      </Text>

      <Divider my="lg" />

      <Title order={4} mb="xs">
        Inspect a ZIP archive
      </Title>
      <Text c="dimmed" mb="md">
        Explore the contents of an experimental archive read-only. Nothing is
        imported, modified or uploaded.
      </Text>
      <ZipExplorer />
    </Container>
  )
}
