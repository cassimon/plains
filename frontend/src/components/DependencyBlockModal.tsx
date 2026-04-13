import { Table, Text } from "@mantine/core"
import type { DependencyLocation } from "../store/AppContext"

/**
 * Shown inside a modal when the user tries to delete an item that other items
 * depend on. Lists all dependents with their Plane → Collection → Item location.
 */
export function DependencyBlockModal({
  itemName,
  dependents,
}: {
  itemName: string
  dependents: DependencyLocation[]
}) {
  return (
    <>
      <Text size="sm" mb="md">
        <Text span fw={600}>
          "{itemName}"
        </Text>{" "}
        cannot be deleted because the following items still depend on it. Remove
        or update those items first.
      </Text>
      <Table withTableBorder withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Plane</Table.Th>
            <Table.Th>Collection</Table.Th>
            <Table.Th>Item</Table.Th>
            <Table.Th>Type</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {dependents.map((dep) => (
            <Table.Tr key={dep.itemId}>
              <Table.Td>{dep.planeName}</Table.Td>
              <Table.Td>{dep.collectionName}</Table.Td>
              <Table.Td>{dep.itemName}</Table.Td>
              <Table.Td>
                <Text size="xs" c="dimmed" tt="capitalize">
                  {dep.itemKind}
                </Text>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </>
  )
}
