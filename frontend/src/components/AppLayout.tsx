import {
  ActionIcon,
  AppShell,
  Avatar,
  ColorSwatch,
  Group,
  Menu,
  rem,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useMantineColorScheme,
} from "@mantine/core"
import {
  IconChevronDown,
  IconLogout,
  IconMoon,
  IconSettings,
  IconSun,
  IconX,
} from "@tabler/icons-react"
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"
import useAuth from "@/hooks/useAuth"
import {
  type CanvasCollectionElement,
  useAppContext,
} from "../store/AppContext"
import { pageIcons } from "./AppLayout.icons"

// Neutral grayish-blue for default selections
const DEFAULT_ACCENT = "#94a3b8"

// TODO: Update these paths once all routes are registered
const pages = [
  { label: "Organization", value: "/organization" as any },
  { label: "Materials", value: "/materials" as any },
  { label: "Solutions", value: "/solutions" as any },
  { label: "Experiments", value: "/experiments" as any },
  { label: "Results", value: "/results" as any },
  { label: "Analysis", value: "/analysis" as any },
  { label: "Export", value: "/export" as any },
] as const

export function AppLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { colorScheme, toggleColorScheme } = useMantineColorScheme()
  const {
    planes,
    activeCollectionId,
    setActiveCollectionId,
    activePlaneId,
    setActivePlaneId,
    experiments,
    materials,
    solutions,
    activeEntity,
    flushSave,
  } = useAppContext()

  const currentPage =
    pages.find((p) => location.pathname.startsWith(p.value))?.value ??
    pages[0].value
  const { user, logout } = useAuth()
  const initials = user?.full_name
    ? user.full_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : (user?.email?.[0] ?? "?").toUpperCase()

  // Find the active collection element (if any)
  const activeCollection = useMemo<CanvasCollectionElement | null>(() => {
    if (!activeCollectionId) {
      return null
    }
    for (const plane of planes) {
      const el = plane.elements.find((e) => e.id === activeCollectionId)
      if (el && el.type === "collection") {
        return el as CanvasCollectionElement
      }
    }
    return null
  }, [activeCollectionId, planes])

  // Find the active plane from context (set by OrganizationPage tab selection)
  const activePlane = useMemo(() => {
    return planes.find((p) => p.id === activePlaneId) || null
  }, [activePlaneId, planes])

  // All collection elements in the active plane
  const collections = useMemo(() => {
    if (!activePlane) {
      return []
    }
    return activePlane.elements.filter(
      (e) => e.type === "collection",
    ) as CanvasCollectionElement[]
  }, [activePlane])

  // Accent color: collection color if selected, otherwise neutral
  const accentColor = activeCollection?.color || DEFAULT_ACCENT

  // Resolve the active entity's display name and icon
  const { entityName, EntityIcon } = useMemo(() => {
    if (!activeEntity) {
      return { entityName: null, EntityIcon: null }
    }
    let name: string | null = null
    if (activeEntity.kind === "experiment") {
      name = experiments.find((e) => e.id === activeEntity.id)?.name ?? null
    } else if (activeEntity.kind === "material") {
      name = materials.find((m) => m.id === activeEntity.id)?.name ?? null
    } else if (activeEntity.kind === "solution") {
      name = solutions.find((s) => s.id === activeEntity.id)?.name ?? null
    }
    const iconPath =
      activeEntity.kind === "experiment"
        ? "/experiments"
        : activeEntity.kind === "material"
          ? "/materials"
          : "/solutions"
    return {
      entityName: name,
      EntityIcon: pageIcons[iconPath as keyof typeof pageIcons] ?? null,
    }
  }, [activeEntity, experiments, materials, solutions])

  // When on the Organization page and a collection is selected, compute which
  // page paths have refs in that collection — all others are dimmed.
  const litPaths = useMemo<Set<string> | null>(() => {
    if (!location.pathname.startsWith("/organization") || !activeCollection) {
      return null
    }
    const lit = new Set<string>(["/organization"])
    activeCollection.refs.forEach((r) => {
      if (r.kind === "material") {
        lit.add("/materials")
      }
      if (r.kind === "solution") {
        lit.add("/solutions")
      }
      if (r.kind === "experiment") {
        lit.add("/experiments")
      }
      if (r.kind === "result") {
        lit.add("/results")
      }
      if (r.kind === "analysis") {
        lit.add("/analysis")
      }
    })
    return lit
  }, [activeCollection, location.pathname])

  return (
    <AppShell
      header={{ height: 60 }}
      aside={{ width: 120, breakpoint: "sm" }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap={4} align="center">
            {/* Plane name — click navigates to org and deselects collection */}
            <UnstyledButton
              onClick={() => {
                navigate({ to: "/organization" })
                setActiveCollectionId(null)
              }}
              style={{ display: "flex", alignItems: "center" }}
            >
              <Text fw={600} size="lg">
                {activePlane?.name ?? "General"}
              </Text>
            </UnstyledButton>
            {/* Plane dropdown chevron only */}
            <Menu shadow="md" width={220}>
              <Menu.Target>
                <UnstyledButton
                  style={{
                    display: "flex",
                    alignItems: "center",
                    padding: "0 2px",
                  }}
                >
                  <IconChevronDown
                    size={14}
                    style={{ color: "var(--mantine-color-dimmed)" }}
                  />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  fw={!activePlaneId ? 700 : undefined}
                  onClick={() => {
                    setActivePlaneId(null)
                    setActiveCollectionId(null)
                  }}
                >
                  General
                </Menu.Item>
                <Menu.Divider />
                {planes.map((p) => (
                  <Menu.Item
                    key={p.id}
                    fw={p.id === activePlaneId ? 700 : undefined}
                    onClick={() => setActivePlaneId(p.id)}
                  >
                    {p.name}
                  </Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>

            {/* Removed path separator */}

            {/* Collection name — only shown when a specific plane is selected */}
            {activePlane && (
              <>
                <Text
                  fw={600}
                  size="lg"
                  c={activeCollection ? undefined : "dimmed"}
                  style={
                    activeCollection
                      ? {
                          borderLeft: `3px solid ${accentColor}`,
                          paddingLeft: 8,
                        }
                      : undefined
                  }
                >
                  {activeCollection?.name ?? "No Collection"}
                </Text>
                {/* Collection dropdown chevron only */}
                <Menu shadow="md" width={240}>
                  <Menu.Target>
                    <UnstyledButton
                      style={{
                        display: "flex",
                        alignItems: "center",
                        padding: "0 2px",
                      }}
                    >
                      <IconChevronDown
                        size={14}
                        style={{ color: "var(--mantine-color-dimmed)" }}
                      />
                    </UnstyledButton>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconX size={14} />}
                      disabled={!activeCollection}
                      onClick={() => setActiveCollectionId(null)}
                    >
                      No Collection
                    </Menu.Item>
                    {collections.length > 0 && <Menu.Divider />}
                    {collections.map((col) => (
                      <Menu.Item
                        key={col.id}
                        fw={col.id === activeCollectionId ? 700 : undefined}
                        leftSection={
                          <ColorSwatch
                            color={col.color || DEFAULT_ACCENT}
                            size={12}
                          />
                        }
                        onClick={() => setActiveCollectionId(col.id)}
                      >
                        {col.name}
                      </Menu.Item>
                    ))}
                    {collections.length === 0 && (
                      <Menu.Item disabled>
                        No collections in this plane
                      </Menu.Item>
                    )}
                  </Menu.Dropdown>
                </Menu>
              </>
            )}

            {/* Active entity segment */}
            {activeEntity && entityName && (
              <>
                {/* Removed path separator */}
                {EntityIcon && (
                  <EntityIcon
                    size={16}
                    style={{
                      color: "var(--mantine-color-dimmed)",
                      flexShrink: 0,
                    }}
                  />
                )}
                <Text fw={600} size="lg">
                  {entityName}
                </Text>
              </>
            )}
          </Group>
          <Group gap="xs" align="center">
            <ActionIcon
              variant="default"
              size="lg"
              onClick={() => toggleColorScheme()}
              aria-label="Toggle color scheme"
            >
              {colorScheme === "dark" ? (
                <IconSun size={18} />
              ) : (
                <IconMoon size={18} />
              )}
            </ActionIcon>

            <Menu shadow="md" width={240} position="bottom-end">
              <Menu.Target>
                <UnstyledButton
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  <Avatar size="sm" radius="xl">
                    {initials}
                  </Avatar>
                  <Stack gap={0} visibleFrom="sm">
                    <Text size="sm" fw={500} lh={1.2}>
                      {user?.full_name || user?.email || "Loading…"}
                    </Text>
                    {user?.full_name && (
                      <Text size="xs" c="dimmed" lh={1.2}>
                        {user.email}
                      </Text>
                    )}
                  </Stack>
                  <IconChevronDown
                    size={12}
                    style={{ color: "var(--mantine-color-dimmed)" }}
                  />
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user?.email}</Menu.Label>
                <Menu.Item
                  leftSection={<IconSettings size={14} />}
                  onClick={() => navigate({ to: "/settings" as any })}
                >
                  User settings
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout size={14} />}
                  onClick={async () => {
                    await flushSave()
                    logout()
                  }}
                >
                  Log out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Aside>
        <Stack align="center" justify="center" h="100%" py="md" gap="xs">
          {pages.map((page) => {
            const Icon = pageIcons[page.value as keyof typeof pageIcons]
            const active = currentPage === page.value
            const dimmed = litPaths !== null && !litPaths.has(page.value)
            // "hasContent" = collection has at least one ref of this type
            const hasContent =
              litPaths?.has(page.value) && page.value !== "/organization"
            return (
              <Tooltip label={page.label} position="left" key={page.value}>
                <ActionIcon
                  variant={active ? "filled" : "subtle"}
                  size="lg"
                  radius="md"
                  onClick={() => navigate({ to: page.value })}
                  aria-label={page.label}
                  style={{
                    width: rem(48),
                    height: rem(48),
                    opacity: dimmed ? 0.25 : 1,
                    transition: "opacity 150ms ease, background 150ms ease",
                    background: active ? accentColor : undefined,
                    color: active
                      ? "white"
                      : hasContent
                        ? "var(--mantine-color-gray-7)"
                        : "var(--mantine-color-gray-6)",
                  }}
                >
                  {Icon ? <Icon size={28} /> : null}
                </ActionIcon>
              </Tooltip>
            )
          })}
        </Stack>
      </AppShell.Aside>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
