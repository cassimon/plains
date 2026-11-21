import { Anchor, Container, Group, Text, Title } from "@mantine/core"
import { ZipExplorer } from "@/components/ZipExplorer"

const EXAMPLE_ZIP = `${import.meta.env.BASE_URL}examples/sample-jv-summary.zip`

export function ImportPage() {
  return (
    <Container size="lg">
      <Title order={2} mt="md">
        Import
      </Title>
      <Text c="dimmed" mt="sm" mb="md">
        Inspect a ZIP archive and import supported JV Summary measurements into a
        new or existing experiment. Nothing is imported until you confirm it.
      </Text>

      <Group mb="md">
        <Anchor href={EXAMPLE_ZIP} download size="sm">
          Download example ZIP (fictional data)
        </Anchor>
      </Group>

      <ZipExplorer />
    </Container>
  )
}
