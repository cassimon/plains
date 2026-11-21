import { Container, Text, Title } from "@mantine/core"
import { ComingSoonGate } from "@/components/ComingSoonGate"

export function ExportPage() {
  return (
    <ComingSoonGate featureName="Export">
      <Container>
        <Title order={2} mt="md">
          Export
        </Title>
        <Text c="dimmed" mt="sm">
          Export your data here.
        </Text>
      </Container>
    </ComingSoonGate>
  )
}
