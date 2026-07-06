import {
  ActionIcon,
  AppShell,
  Avatar,
  Badge,
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
import { modals } from "@mantine/modals"
import {
  IconChevronDown,
  IconCloudUpload,
  IconLogout,
  IconMoon,
  IconSettings,
  IconSun,
  IconX,
} from "@tabler/icons-react"
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo } from "react"
import useAuth from "@/hooks/useAuth"
import {
  type CanvasCollectionElement,
  useAppContext,
} from "../store/AppContext"
import { pageIcons } from "./AppLayout.icons"
import { UploadFlowStatus } from "./UploadFlowStatus"

// Neutral grayish-blue for default selections
const DEFAULT_ACCENT = "#94a3b8"

const pages = [
  { label: "Organization", value: "/organization" },
  { label: "Processes", value: "/processes" },
  { label: "Experiments", value: "/experiments" },
  { label: "Results", value: "/results" },
  { label: "Analysis", value: "/analysis" },
  { label: "Export", value: "/export" },
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
    processes,
    activeEntity,
    setActiveEntity,
    flushSave,
    uploadFlow,
    cancelUploadFlow,
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

  // Reference processes for use in useMemos
  const derivedProcesses = processes

  const activeEntityMatchesPage = useMemo(() => {
    if (!activeEntity) {
      return false
    }
    if (activeEntity.kind === "process") {
      return location.pathname.startsWith("/processes")
    }
    return (
      location.pathname.startsWith("/experiments") ||
      location.pathname.startsWith("/results")
    )
  }, [activeEntity, location.pathname])

  useEffect(() => {
    if (activeEntity && !activeEntityMatchesPage) {
      setActiveEntity(null)
    }
  }, [activeEntity, activeEntityMatchesPage, setActiveEntity])

  // Resolve the active entity's display name and icon
  const { entityName, EntityIcon } = useMemo(() => {
    if (!activeEntity) {
      return { entityName: null, EntityIcon: null }
    }
    let name: string | null = null
    if (activeEntity.kind === "experiment") {
      name = experiments.find((e) => e.id === activeEntity.id)?.name ?? null
    } else if (activeEntity.kind === "process") {
      name =
        derivedProcesses.find((p) => p.id === activeEntity.id)?.name ?? null
    }
    const iconPath =
      activeEntity.kind === "experiment" ? "/experiments" : "/processes"
    return {
      entityName: name,
      EntityIcon: pageIcons[iconPath as keyof typeof pageIcons] ?? null,
    }
  }, [activeEntity, experiments, derivedProcesses])

  // When a collection is selected, compute which page paths have refs in that
  // collection — all others are dimmed across the app until selection changes.
  const litPaths = useMemo<Set<string> | null>(() => {
    if (!activeCollection) {
      return null
    }
    const lit = new Set<string>(["/organization"])
    activeCollection.refs.forEach((r) => {
      if (r.kind === "process") {
        lit.add("/processes")
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
  }, [activeCollection])

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 64, breakpoint: "sm" }}
      padding="md"
    >
      <AppShell.Header>
        <Group
          h="100%"
          px="md"
          justify="space-between"
          style={{ position: "relative" }}
        >
          {/* Critical "File Upload" status — centered between path and login.
              Renders nothing (and takes no layout space) when no flow is active.
              When idle on the Organization view, the same slot shows the
              "place files" hint so the two occupy the exact same position. */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 10,
            }}
          >
            {uploadFlow ? (
              <UploadFlowStatus />
            ) : (
              location.pathname.startsWith("/organization") && (
                <Group
                  gap={8}
                  wrap="nowrap"
                  style={{
                    padding: "5px 14px",
                    borderRadius: 999,
                    border: "1px dashed var(--mantine-color-red-4)",
                  }}
                >
                  <IconCloudUpload
                    size={16}
                    color="var(--mantine-color-red-6)"
                  />
                  <Text size="sm" fw={600} c="red.7">
                    Place files onto Plane for upload
                  </Text>
                </Group>
              )
            )}
          </div>
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
                    <Group justify="space-between" wrap="nowrap" gap="xs">
                      <Text size="sm" style={{ flex: 1 }}>
                        {p.name}
                      </Text>
                      <Badge
                        size="xs"
                        color={
                          (p.sharedWith?.length ?? 0) > 0 ? "red" : "green"
                        }
                        variant="light"
                      >
                        {(p.sharedWith?.length ?? 0) > 0 ? "s" : "p"}
                      </Badge>
                    </Group>
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
            {activeEntityMatchesPage && activeEntity && entityName && (
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
                  onClick={() => navigate({ to: "/settings" })}
                >
                  User settings
                </Menu.Item>
                <Menu.Divider />
                <Menu.Item
                  color="red"
                  leftSection={<IconLogout size={14} />}
                  onClick={() => {
                    const doLogout = async () => {
                      // Incomplete flows are discarded on logout.
                      cancelUploadFlow()
                      await flushSave()
                      logout()
                    }
                    if (uploadFlow) {
                      modals.openConfirmModal({
                        title: "Upload in progress",
                        children: (
                          <Text size="sm">
                            You have an unfinished file upload. If you log out
                            now it will be discarded. Stay to finish it, or log
                            out and discard it.
                          </Text>
                        ),
                        labels: {
                          confirm: "Log out & discard",
                          cancel: "Stay and finish",
                        },
                        confirmProps: { color: "red" },
                        onConfirm: () => {
                          void doLogout()
                        },
                      })
                      return
                    }
                    void doLogout()
                  }}
                >
                  Log out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar>
        <Stack align="center" justify="top" h="100%" py="md" gap="xs">
          {pages.map((page) => {
            const Icon = pageIcons[page.value as keyof typeof pageIcons]
            const active = currentPage === page.value
            const dimmed = litPaths !== null && !litPaths.has(page.value)
            // "hasContent" = collection has at least one ref of this type
            const hasContent =
              litPaths?.has(page.value) && page.value !== "/organization"
            return (
              <Tooltip label={page.label} position="right" key={page.value}>
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
      </AppShell.Navbar>

      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  )
}
