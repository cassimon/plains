import { Container, Text, Title } from "@mantine/core"
import { ZipExplorer } from "@/components/ZipExplorer"

export function ImportPage() {
  return (
    <Container size="lg">
      <Title order={2} mt="md">
        Import
      </Title>
      <Text c="dimmed" mt="sm" mb="md">
        Inspect a ZIP archive and import supported JV Summary measurements into
        an existing experiment. Nothing is imported until you confirm it.
      </Text>
      <ZipExplorer />
    </Container>
  )
}
