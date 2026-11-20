import { Text, type TextProps } from "@mantine/core"

interface SectionLabelProps {
  children: React.ReactNode
  /** Font weight; 600 by default (matches the existing section labels). */
  fw?: TextProps["fw"]
  /** Optional bottom margin (e.g. "xs" or 4). */
  mb?: TextProps["mb"]
  /** Optional top margin (e.g. "xs"). */
  mt?: TextProps["mt"]
}

/**
 * Small uppercase muted label used to head sections and panels in the Mantine
 * scientific GUI (e.g. "Chemicals", "Deposition Parameters", "Recipe / Process").
 *
 * Single source of truth for the `size="xs" c="dimmed" tt="uppercase"` convention
 * repeated across the scientific pages; keeps future labels consistent without a
 * heavier abstraction.
 */
export function SectionLabel({ children, fw = 600, mb, mt }: SectionLabelProps) {
  return (
    <Text size="xs" c="dimmed" tt="uppercase" fw={fw} mb={mb} mt={mt}>
      {children}
    </Text>
  )
}
