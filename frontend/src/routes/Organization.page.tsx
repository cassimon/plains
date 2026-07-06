import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  ColorSwatch,
  Divider,
  FileButton,
  Group,
  Loader,
  Modal,
  Paper,
  Popover,
  rem,
  ScrollArea,
  Stack,
  Table,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
  useComputedColorScheme,
} from "@mantine/core"
import { useDebouncedValue } from "@mantine/hooks"
import { modals } from "@mantine/modals"
import {
  IconArrowRight,
  IconBold,
  IconChartBar,
  IconCheck,
  IconCloudUpload,
  IconCopy,
  IconDownload,
  IconFolderPlus,
  IconItalic,
  IconLetterT,
  IconMinus,
  IconNote,
  IconPlayerPlay,
  IconPlus,
  IconSeparatorVertical,
  IconShare,
  IconStack3,
  IconTrash,
  IconUnderline,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import {
  type MouseEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { PlanesService } from "../client"
import { UploadFlowTargetPicker } from "../components/UploadFlowTargetPicker"
import useAuth from "../hooks/useAuth"
import { getUploadFlowSteps, isUploadFlowComplete } from "../lib/uploadFlow"
import { useStartOrAddUpload } from "../lib/useStartOrAddUpload"
import {
  type CanvasCollectionElement,
  type CanvasElement,
  type CanvasLineElement,
  type CanvasPlainTextElement,
  type CanvasTextElement,
  type CollectionRef,
  type DependencyLocation,
  type Experiment,
  type ExperimentResults,
  getDependentLocations,
  type Plane,
  type Process,
  type TextFormatting,
  useAppContext,
  type Vec2,
} from "../store/AppContext"
import { apiPlaneToPlane } from "../store/apiTypes"

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GRID = 20 // px – subtle grid snap
const COLLECTION_REF_DRAG_MIME = "application/x-plains-collection-ref-drag"
const COLLECTION_ELEMENT_DRAG_MIME =
  "application/x-plains-collection-element-drag"

// Neutral grayish-blue for default selections
const DEFAULT_ACCENT = "#94a3b8"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function snapToGrid(v: number): number {
  return Math.round(v / GRID) * GRID
}

// ─────────────────────────────────────────────────────────────────────────────
// Collection fusion helpers
// ─────────────────────────────────────────────────────────────────────────────

type CollectionRefDragPayload = {
  sourceCollectionId: string
  kind: CollectionRef["kind"]
  mode: "kind" | "single"
  refIds: string[]
}

type CollectionElementDragPayload = { collectionId: string }

/** Approximate rendered bounding box of a CollectionEl card */
// Chessboard grid cell dimensions
const CELL_W = 200
const CELL_H = 180
// Breathing room between the toolbar and the first row of cells
const CELL_TOP_MARGIN = 20
const CELL_GAP = 6 // visual gap between grid cells
const CELL_STRIDE_W = CELL_W + CELL_GAP
const CELL_STRIDE_H = CELL_H + CELL_GAP

function snapToCell(x: number, y: number): Vec2 {
  return {
    x: Math.round(x / CELL_STRIDE_W) * CELL_W,
    y: Math.round(y / CELL_STRIDE_H) * CELL_H,
  }
}

const ROUTE_FOR_KIND: Record<CollectionRef["kind"], string> = {
  experiment: "/experiments",
  process: "/processes",
  result: "/results",
  analysis: "/analysis",
}

// ─────────────────────────────────────────────────────────────────────────────
// Color palette
// ─────────────────────────────────────────────────────────────────────────────

// Palette for user-selectable element colors – mid-tone hues, dark/light compatible, no black/gray.
// Ordered for maximum perceptual contrast between consecutive picks in the cycle.
// Greens/teals are distributed 4 positions apart so they never appear adjacent.
const PALETTE = [
  "#4dabf7", // sky blue    (~210°)
  "#ff6b6b", // coral       (~  0°)
  "#a9e34b", // lime        (~ 80°)
  "#cc5de8", // violet      (~290°)
  "#ffd43b", // yellow      (~ 45°)
  "#38d9a9", // teal        (~165°)
  "#f06595", // pink        (~340°)
  "#748ffc", // indigo      (~245°)
  "#ff922b", // orange      (~ 30°)
  "#66d9e8", // cyan        (~185°)
  "#e64980", // rose        (~325°)
  "#ffa94d", // amber       (~ 35°)
]

// Inject keyframes for bubble animation + grid cell hover
if (
  typeof document !== "undefined" &&
  !document.getElementById("bubble-keyframes")
) {
  const style = document.createElement("style")
  style.id = "bubble-keyframes"
  style.textContent = `
    @keyframes bubble-in {
      from { transform: scale(0); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    @keyframes upload-pending-blink {
      0%, 100% { opacity: 1; }
      50%      { opacity: 0.25; }
    }
    .upload-pending-blink { animation: upload-pending-blink 1s ease-in-out infinite; }
  `
  document.head.appendChild(style)
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating format bar — appears above an element when text is selected
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_COLORS = [
  "#000000",
  "#ffffff",
  "#e03131",
  "#2f9e44",
  "#1971c2",
  "#f08c00",
  "#ae3ec9",
  "#0c8599",
  "#495057",
  "#868e96",
]
const DEFAULT_NOTE_FONT_SIZE = 12
const DEFAULT_PLAIN_FONT_SIZE = 16

function FloatingFormatBar({
  formatting,
  color,
  onChangeFormatting,
  onChangeColor,
}: {
  formatting: TextFormatting
  color: string
  onChangeFormatting: (f: TextFormatting) => void
  onChangeColor: (c: string) => void
}) {
  const fontSize = formatting.fontSize ?? DEFAULT_NOTE_FONT_SIZE
  return (
    <Paper
      shadow="md"
      p={4}
      style={{
        position: "absolute",
        bottom: 4,
        left: 4,
        zIndex: 500,
        display: "flex",
        alignItems: "center",
        gap: 2,
        whiteSpace: "nowrap",
        pointerEvents: "auto",
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      {/* Font size */}
      <ActionIcon
        size="xs"
        variant="subtle"
        color="gray"
        onClick={() =>
          onChangeFormatting({
            ...formatting,
            fontSize: Math.max(8, fontSize - 1),
          })
        }
      >
        <IconMinus size={10} />
      </ActionIcon>
      <Text size="xs" fw={500} style={{ minWidth: 22, textAlign: "center" }}>
        {fontSize}
      </Text>
      <ActionIcon
        size="xs"
        variant="subtle"
        color="gray"
        onClick={() =>
          onChangeFormatting({
            ...formatting,
            fontSize: Math.min(72, fontSize + 1),
          })
        }
      >
        <IconPlus size={10} />
      </ActionIcon>
      <Divider orientation="vertical" mx={2} />
      {/* Bold */}
      <Tooltip label="Bold" openDelay={600} position="top">
        <ActionIcon
          size="xs"
          variant={formatting.bold ? "filled" : "subtle"}
          color={formatting.bold ? "blue" : "gray"}
          onClick={() =>
            onChangeFormatting({ ...formatting, bold: !formatting.bold })
          }
        >
          <IconBold size={12} />
        </ActionIcon>
      </Tooltip>
      {/* Italic */}
      <Tooltip label="Italic" openDelay={600} position="top">
        <ActionIcon
          size="xs"
          variant={formatting.italic ? "filled" : "subtle"}
          color={formatting.italic ? "blue" : "gray"}
          onClick={() =>
            onChangeFormatting({ ...formatting, italic: !formatting.italic })
          }
        >
          <IconItalic size={12} />
        </ActionIcon>
      </Tooltip>
      {/* Underline */}
      <Tooltip label="Underline" openDelay={600} position="top">
        <ActionIcon
          size="xs"
          variant={formatting.underline ? "filled" : "subtle"}
          color={formatting.underline ? "blue" : "gray"}
          onClick={() =>
            onChangeFormatting({
              ...formatting,
              underline: !formatting.underline,
            })
          }
        >
          <IconUnderline size={12} />
        </ActionIcon>
      </Tooltip>
      <Divider orientation="vertical" mx={2} />
      {/* Color */}
      <Popover withArrow shadow="md" position="top">
        <Popover.Target>
          <Tooltip label="Text color" openDelay={600} position="top">
            <ActionIcon size="xs" variant="subtle" color="gray">
              <ColorSwatch color={color} size={14} />
            </ActionIcon>
          </Tooltip>
        </Popover.Target>
        <Popover.Dropdown p={6}>
          <Group gap={4} wrap="wrap" w={130}>
            {TEXT_COLORS.map((c) => (
              <ColorSwatch
                key={c}
                color={c}
                size={18}
                style={{
                  cursor: "pointer",
                  outline:
                    color === c
                      ? "2px solid var(--mantine-color-blue-5)"
                      : "none",
                  borderRadius: 3,
                }}
                onClick={() => onChangeColor(c)}
              />
            ))}
          </Group>
        </Popover.Dropdown>
      </Popover>
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Hyperlink parser
// ─────────────────────────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s,;）)>\]]+/g

function renderWithLinks(text: string, baseStyle?: React.CSSProperties) {
  const parts: React.ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  URL_REGEX.lastIndex = 0
  // biome-ignore lint/suspicious/noAssignInExpressions: regex exec loop pattern
  while ((match = URL_REGEX.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index))
    }
    const url = match[0]
    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "#228be6", textDecoration: "underline", ...baseStyle }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>,
    )
    last = match.index + url.length
  }
  if (last < text.length) {
    parts.push(text.slice(last))
  }
  return parts
}

// ─────────────────────────────────────────────────────────────────────────────
// Text element
// ─────────────────────────────────────────────────────────────────────────────

// Default sticky-note background (classic yellow)
const STICKY_BG = "#fff9c4"
// Fold size
const FOLD = 18

// Inject sticky-note fold keyframes / styles once
if (
  typeof document !== "undefined" &&
  !document.getElementById("sticky-styles")
) {
  const s = document.createElement("style")
  s.id = "sticky-styles"
  s.textContent = `
    .sticky-note {
      position: relative;
      clip-path: polygon(0 0, calc(100% - ${FOLD}px) 0, 100% ${FOLD}px, 100% 100%, 0 100%);
    }
    .sticky-fold {
      position: absolute;
      top: 0;
      right: 0;
      width: ${FOLD}px;
      height: ${FOLD}px;
      background: rgba(0,0,0,0.12);
      clip-path: polygon(0 0, 100% 100%, 100% 0);
      pointer-events: none;
    }
    .resize-handle {
      position: absolute;
      bottom: 2px;
      right: 4px;
      width: 12px;
      height: 12px;
      cursor: se-resize;
      opacity: 0.35;
    }
    .resize-handle:hover { opacity: 0.7; }
  `
  document.head.appendChild(s)
}

// Inject onboarding pulse animation once
if (typeof document !== "undefined" && !document.getElementById("ob-styles")) {
  const s = document.createElement("style")
  s.id = "ob-styles"
  s.textContent = `
    @keyframes ob-pulse {
      0%   { transform: scale(1);    }
      45%  { transform: scale(1.13); }
      100% { transform: scale(1);    }
    }
    .ob-pulse { animation: ob-pulse 1.7s ease-in-out infinite; }
  `
  document.head.appendChild(s)
}

function TextEl({
  el,
  onUpdate,
  onDelete,
  onStartEdit,
  onEditEnd,
  pan,
}: {
  el: CanvasTextElement
  onUpdate: (e: CanvasElement) => void
  onDelete: () => void
  onStartEdit?: () => void
  onEditEnd?: () => void
  pan: Vec2
}) {
  const [editing, setEditing] = useState(el.content === "")
  const [dragging, setDragging] = useState(false)
  const [showFormatBar, setShowFormatBar] = useState(false)
  const dragStart = useRef<{ mouse: Vec2; origin: Vec2 } | null>(null)
  const resizeStart = useRef<{ mouse: Vec2; size: Vec2 } | null>(null)
  const prevEditing = useRef(editing)

  const startDrag = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (editing) return
    setDragging(true)
    dragStart.current = {
      mouse: { x: ev.clientX, y: ev.clientY },
      origin: { ...el.position },
    }
    ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
  }

  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || !dragStart.current) return
    const dx = ev.clientX - dragStart.current.mouse.x
    const dy = ev.clientY - dragStart.current.mouse.y
    onUpdate({
      ...el,
      position: {
        x: Math.max(
          0,
          Math.round((dragStart.current.origin.x + dx) / CELL_W) * CELL_W,
        ),
        y: Math.max(
          0,
          Math.round((dragStart.current.origin.y + dy) / CELL_H) * CELL_H,
        ),
      },
    })
  }

  const stopDrag = () => {
    setDragging(false)
    dragStart.current = null
  }

  const startResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.stopPropagation()
    ev.preventDefault()
    ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
    resizeStart.current = {
      mouse: { x: ev.clientX, y: ev.clientY },
      size: { ...el.size },
    }
  }

  const onResizeMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return
    ev.stopPropagation()
    const dx = ev.clientX - resizeStart.current.mouse.x
    const dy = ev.clientY - resizeStart.current.mouse.y
    onUpdate({
      ...el,
      size: {
        x: Math.max(
          CELL_W,
          Math.round((resizeStart.current.size.x + dx) / CELL_W) * CELL_W,
        ),
        y: Math.max(
          CELL_H,
          Math.round((resizeStart.current.size.y + dy) / CELL_H) * CELL_H,
        ),
      },
    })
  }

  const stopResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.stopPropagation()
    resizeStart.current = null
  }

  const textColor = el.color || "#000000"
  const textFormatting = el.formatting || {}
  const fontSize = textFormatting.fontSize ?? DEFAULT_NOTE_FONT_SIZE

  useEffect(() => {
    if (!prevEditing.current && editing) onStartEdit?.()
    if (prevEditing.current && !editing) {
      onEditEnd?.()
      setShowFormatBar(false)
    }
    prevEditing.current = editing
  }, [editing, onEditEnd, onStartEdit])

  const handleFormatChange = (f: TextFormatting) =>
    onUpdate({ ...el, formatting: f })
  const handleColorChange = (c: string) => onUpdate({ ...el, color: c })

  const checkSelection = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget
    setShowFormatBar(t.selectionStart !== t.selectionEnd)
  }

  return (
    <Box
      style={{
        position: "absolute",
        left: el.position.x + pan.x,
        top: el.position.y + pan.y,
        width: el.size.x,
        minHeight: el.size.y,
        cursor: dragging ? "grabbing" : editing ? "text" : "grab",
        userSelect: "none",
      }}
      onPointerDown={startDrag}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
    >
      <div
        className="sticky-note"
        style={{
          width: "100%",
          minHeight: el.size.y,
          background: STICKY_BG,
          padding: "6px 8px 18px 8px",
          boxShadow: "2px 3px 8px rgba(0,0,0,0.15)",
          position: "relative",
        }}
      >
        {/* Folded corner */}
        <div className="sticky-fold" />

        {/* Delete button */}
        <ActionIcon
          size={16}
          variant="transparent"
          color="gray"
          style={{
            position: "absolute",
            top: 4,
            right: FOLD + 2,
            opacity: 0.5,
            zIndex: 1,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
        >
          <IconX size={10} />
        </ActionIcon>

        {/* Content */}
        {editing ? (
          <Textarea
            autosize
            autoFocus
            size="xs"
            minRows={2}
            value={el.content}
            onChange={(e) =>
              onUpdate({ ...el, content: e.currentTarget.value })
            }
            onBlur={() => setEditing(false)}
            onSelect={checkSelection}
            onKeyUp={checkSelection}
            onPointerDown={(e) => e.stopPropagation()}
            styles={{
              input: {
                background: "transparent",
                border: "none",
                resize: "none",
                color: textColor,
                fontFamily: "inherit",
                fontSize,
                fontWeight: textFormatting.bold ? 700 : 400,
                fontStyle: textFormatting.italic ? "italic" : "normal",
                textDecoration: textFormatting.underline ? "underline" : "none",
                padding: 0,
              },
            }}
          />
        ) : (
          <Text
            style={{
              whiteSpace: "pre-wrap",
              minHeight: rem(40),
              color: textColor,
              fontSize,
              fontWeight: textFormatting.bold ? 700 : 400,
              fontStyle: textFormatting.italic ? "italic" : "normal",
              textDecoration: textFormatting.underline ? "underline" : "none",
              cursor: "grab",
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}
          >
            {el.content ? (
              renderWithLinks(el.content)
            ) : (
              <Text span c="dimmed" size="xs">
                Double-click to edit…
              </Text>
            )}
          </Text>
        )}

        {/* Resize handle */}
        <div
          className="resize-handle"
          onPointerDown={startResize}
          onPointerMove={onResizeMove}
          onPointerUp={stopResize}
        >
          <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
            <line
              x1="12"
              y1="4"
              x2="4"
              y2="12"
              stroke="#888"
              strokeWidth="1.5"
            />
            <line
              x1="12"
              y1="8"
              x2="8"
              y2="12"
              stroke="#888"
              strokeWidth="1.5"
            />
          </svg>
        </div>
      </div>
      {/* Floating format bar — inside the box at the bottom, on top of content */}
      {editing && showFormatBar && (
        <FloatingFormatBar
          formatting={textFormatting}
          color={textColor}
          onChangeFormatting={handleFormatChange}
          onChangeColor={handleColorChange}
        />
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain Text element – transparent background with text formatting
// ─────────────────────────────────────────────────────────────────────────────

function PlainTextEl({
  el,
  onUpdate,
  onDelete,
  onStartEdit,
  onEditEnd,
  pan,
}: {
  el: CanvasPlainTextElement
  onUpdate: (e: CanvasElement) => void
  onDelete: () => void
  onStartEdit?: () => void
  onEditEnd?: () => void
  pan: Vec2
}) {
  const [editing, setEditing] = useState(el.content === "")
  const [dragging, setDragging] = useState(false)
  const [hovered, setHovered] = useState(false)
  const dragStart = useRef<{ mouse: Vec2; origin: Vec2 } | null>(null)
  const resizeStart = useRef<{ mouse: Vec2; size: Vec2 } | null>(null)

  const startDrag = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (editing) {
      return
    }
    setDragging(true)
    dragStart.current = {
      mouse: { x: ev.clientX, y: ev.clientY },
      origin: { ...el.position },
    }
    ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
  }

  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging || !dragStart.current) {
      return
    }
    const dx = ev.clientX - dragStart.current.mouse.x
    const dy = ev.clientY - dragStart.current.mouse.y
    onUpdate({
      ...el,
      position: {
        x: Math.max(
          0,
          Math.round((dragStart.current.origin.x + dx) / CELL_W) * CELL_W,
        ),
        y: Math.max(
          0,
          Math.round((dragStart.current.origin.y + dy) / CELL_H) * CELL_H,
        ),
      },
    })
  }

  const stopDrag = () => {
    setDragging(false)
    dragStart.current = null
  }

  const startResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.stopPropagation()
    ev.preventDefault()
    ;(ev.target as HTMLElement).setPointerCapture(ev.pointerId)
    resizeStart.current = {
      mouse: { x: ev.clientX, y: ev.clientY },
      size: { ...el.size },
    }
  }

  const onResizeMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) {
      return
    }
    ev.stopPropagation()
    const dx = ev.clientX - resizeStart.current.mouse.x
    const dy = ev.clientY - resizeStart.current.mouse.y
    onUpdate({
      ...el,
      size: {
        x: Math.max(
          CELL_W,
          Math.round((resizeStart.current.size.x + dx) / CELL_W) * CELL_W,
        ),
        y: Math.max(
          CELL_H,
          Math.round((resizeStart.current.size.y + dy) / CELL_H) * CELL_H,
        ),
      },
    })
  }

  const stopResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.stopPropagation()
    resizeStart.current = null
  }

  const [showFormatBar, setShowFormatBar] = useState(false)

  const fontSize = el.formatting?.fontSize ?? DEFAULT_PLAIN_FONT_SIZE

  const textStyle: React.CSSProperties = {
    color: el.color,
    fontWeight: el.formatting.bold ? 700 : 400,
    fontStyle: el.formatting.italic ? "italic" : "normal",
    textDecoration: el.formatting.underline ? "underline" : "none",
    fontSize,
    lineHeight: 1.4,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  }

  const handleFormatChange = (f: TextFormatting) =>
    onUpdate({ ...el, formatting: f })
  const handleColorChange = (c: string) => onUpdate({ ...el, color: c })

  const checkSelection = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget
    setShowFormatBar(t.selectionStart !== t.selectionEnd)
  }

  return (
    <Box
      style={{
        position: "absolute",
        left: el.position.x + pan.x,
        top: el.position.y + pan.y,
        width: el.size.x,
        minHeight: el.size.y,
        cursor: dragging ? "grabbing" : editing ? "text" : "grab",
        userSelect: "none",
        background: "transparent",
      }}
      onPointerDown={startDrag}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <div
        style={{
          width: "100%",
          minHeight: el.size.y,
          padding: "4px",
          position: "relative",
          border:
            hovered || editing
              ? "1px dashed var(--mantine-color-gray-4)"
              : "1px dashed transparent",
          borderRadius: 4,
          transition: "border 100ms",
        }}
      >
        {/* Delete button – visible on hover */}
        {hovered && !editing && (
          <ActionIcon
            size={16}
            variant="transparent"
            color="gray"
            style={{
              position: "absolute",
              top: -8,
              right: -8,
              opacity: 0.7,
              zIndex: 1,
              background: "white",
              borderRadius: "50%",
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onDelete}
          >
            <IconX size={10} />
          </ActionIcon>
        )}

        {/* Content */}
        {editing ? (
          <Textarea
            autosize
            autoFocus
            size="xs"
            minRows={1}
            value={el.content}
            onChange={(e) =>
              onUpdate({ ...el, content: e.currentTarget.value })
            }
            onBlur={() => {
              setEditing(false)
              setShowFormatBar(false)
              onEditEnd?.()
            }}
            onSelect={checkSelection}
            onKeyUp={checkSelection}
            onPointerDown={(e) => e.stopPropagation()}
            styles={{
              input: {
                background: "transparent",
                border: "none",
                resize: "none",
                ...textStyle,
                padding: 0,
              },
            }}
          />
        ) : (
          // biome-ignore lint/a11y/noStaticElementInteractions: canvas element requires double-click
          <div
            style={{ ...textStyle, minHeight: 20, cursor: "grab" }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(true)
              onStartEdit?.()
            }}
          >
            {el.content ? (
              renderWithLinks(el.content)
            ) : (
              <Text span c="dimmed" size="xs" style={{ fontStyle: "italic" }}>
                Double-click to edit…
              </Text>
            )}
          </div>
        )}

        {/* Resize handle – bottom right corner */}
        {hovered && !editing && (
          <div
            style={{
              position: "absolute",
              bottom: 0,
              right: 0,
              width: 12,
              height: 12,
              cursor: "nwse-resize",
              opacity: 0.6,
            }}
            onPointerDown={startResize}
            onPointerMove={onResizeMove}
            onPointerUp={stopResize}
          >
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
              <line
                x1="12"
                y1="4"
                x2="4"
                y2="12"
                stroke="#888"
                strokeWidth="1.5"
              />
              <line
                x1="12"
                y1="8"
                x2="8"
                y2="12"
                stroke="#888"
                strokeWidth="1.5"
              />
            </svg>
          </div>
        )}
      </div>
      {/* Floating format bar — inside the box at the bottom, on top of content */}
      {editing && showFormatBar && (
        <FloatingFormatBar
          formatting={el.formatting}
          color={el.color}
          onChangeFormatting={handleFormatChange}
          onChangeColor={handleColorChange}
        />
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Line element – rendered as SVG overlay
// ─────────────────────────────────────────────────────────────────────────────

const LINE_COLORS = [
  "#228be6",
  "#40c057",
  "#fa5252",
  "#fab005",
  "#7950f2",
  "#12b886",
]

function LineOverlay({
  lines,
  pan,
  canMove,
  activeId,
  setActiveId,
  onUpdate,
  onDelete,
}: {
  lines: CanvasLineElement[]
  pan: Vec2
  canMove: boolean
  activeId: string | null
  setActiveId: (id: string | null) => void
  onUpdate: (el: CanvasLineElement) => void
  onDelete: (id: string) => void
}) {
  const [hovered, setHovered] = useState<string | null>(null)
  const moveRef = useRef<{
    id: string
    mouse: Vec2
    origin: Vec2[]
  } | null>(null)

  const toPath = (line: CanvasLineElement): string => {
    if (line.points.length < 2) {
      return ""
    }
    if (line.kind === "rectangle") {
      const a = line.points[0]
      const b = line.points[line.points.length - 1]
      const x1 = a.x + pan.x
      const y1 = a.y + pan.y
      const x2 = b.x + pan.x
      const y2 = b.y + pan.y
      return `M ${x1} ${y1} L ${x2} ${y1} L ${x2} ${y2} L ${x1} ${y2} Z`
    }
    return line.points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x + pan.x} ${p.y + pan.y}`)
      .join(" ")
  }

  const boundsOf = (line: CanvasLineElement) => {
    const xs = line.points.map((p) => p.x + pan.x)
    const ys = line.points.map((p) => p.y + pan.y)
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys),
      bottom: Math.max(...ys),
    }
  }

  const activeLine = lines.find((l) => l.id === activeId)
  const activeBounds = activeLine ? boundsOf(activeLine) : null

  return (
    <>
      <svg
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible",
          pointerEvents: "none",
        }}
      >
        {lines.map((line) => {
          if (line.points.length < 2) {
            return null
          }
          const d = toPath(line)
          const color = line.color || LINE_COLORS[0]
          const strokeWidth = line.strokeWidth || 2
          return (
            <g key={line.id}>
              {/* biome-ignore lint/a11y/noStaticElementInteractions: SVG path used as interactive canvas element */}
              <path
                d={d}
                stroke="transparent"
                strokeWidth={Math.max(12, strokeWidth + 8)}
                fill="none"
                style={{
                  pointerEvents: "stroke",
                  cursor: canMove ? "grab" : "pointer",
                }}
                onMouseEnter={() => setHovered(line.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={(e) => {
                  e.stopPropagation()
                  setActiveId(line.id)
                }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  setActiveId(line.id)
                  if (!canMove) {
                    return
                  }
                  ;(e.target as SVGPathElement).setPointerCapture(e.pointerId)
                  moveRef.current = {
                    id: line.id,
                    mouse: { x: e.clientX, y: e.clientY },
                    origin: line.points.map((p) => ({ ...p })),
                  }
                }}
                onPointerMove={(e) => {
                  if (!moveRef.current || moveRef.current.id !== line.id) {
                    return
                  }
                  e.stopPropagation()
                  const dx = e.clientX - moveRef.current.mouse.x
                  const dy = e.clientY - moveRef.current.mouse.y
                  onUpdate({
                    ...line,
                    points: moveRef.current.origin.map((p) => ({
                      x: snapToGrid(p.x + dx),
                      y: snapToGrid(p.y + dy),
                    })),
                  })
                }}
                onPointerUp={(e) => {
                  e.stopPropagation()
                  moveRef.current = null
                }}
              />
              <path
                d={d}
                stroke={
                  activeId === line.id
                    ? "var(--mantine-color-blue-6)"
                    : hovered === line.id
                      ? "var(--mantine-color-red-5)"
                      : color
                }
                strokeWidth={strokeWidth}
                fill="none"
                style={{ pointerEvents: "none" }}
              />
            </g>
          )
        })}
      </svg>

      {activeLine && activeBounds && (
        <ActionIcon
          size="xs"
          variant="filled"
          color="red"
          radius="xl"
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onDelete(activeLine.id)
            setActiveId(null)
          }}
          style={{
            position: "absolute",
            left: activeBounds.right + 6,
            top: activeBounds.top - 10,
            zIndex: 5,
            boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
          }}
        >
          <IconX size={10} />
        </ActionIcon>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Ghost Cell – invisible grid slot that reveals on hover, creates collection on click
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Collection element – minimal card with speech-bubble actions when selected
// ─────────────────────────────────────────────────────────────────────────────

function EmptyCellEl({
  cellX,
  cellY,
  visualX,
  visualY,
  isDragOver,
  planeId,
  isFirstPlane,
  nextCollectionColor,
  onCreateNote,
  onCreateText,
}: {
  cellX: number
  cellY: number
  visualX: number
  visualY: number
  isDragOver: boolean
  planeId: string
  isFirstPlane: boolean
  nextCollectionColor: () => string
  onCreateNote: () => void
  onCreateText: () => void
}) {
  const {
    addCollectionElement,
    updateElement,
    setActiveCollectionId,
    setPendingCollectionLink,
  } = useAppContext()
  const navigate = useNavigate()
  const [isHovered, setIsHovered] = useState(false)
  const rawObLevel = useOnboardingLevel()
  const obLevel: OnboardingLevel = isFirstPlane ? rawObLevel : 4
  const obNextKind = ONBOARDING_NEXT_KIND[obLevel]

  const createAndLink = (kind: CollectionRef["kind"]) => {
    const color = nextCollectionColor()
    const newEl = addCollectionElement(planeId, { x: cellX, y: cellY })
    const updated = { ...newEl, color }
    updateElement(planeId, updated)
    setActiveCollectionId(newEl.id)
    setPendingCollectionLink({
      collectionId: newEl.id,
      planeId,
      kind,
      requestId: crypto.randomUUID(),
    })
    navigate({ to: ROUTE_FOR_KIND[kind] })
  }

  return (
    <Box
      style={{
        position: "absolute",
        left: visualX,
        top: visualY,
        width: CELL_W,
        height: CELL_H,
        border: isDragOver
          ? "2px dashed var(--mantine-color-blue-5)"
          : isHovered
            ? "2px dashed var(--mantine-color-gray-4)"
            : "2px dashed transparent",
        borderRadius: 8,
        background: isDragOver ? "var(--mantine-color-blue-0)" : "transparent",
        cursor: "pointer",
        boxSizing: "border-box",
        transition: "border 80ms, background 80ms",
        zIndex: isHovered ? 20 : 1,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Center overlay: kind "+" buttons (filtered by onboarding) + note + textfield */}
      {isHovered && (
        <Box
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            padding: 8,
            alignContent: "center",
            justifyContent: "center",
          }}
        >
          {SIX_KINDS.filter(({ kind }) =>
            ONBOARDING_UNLOCK[obLevel].includes(kind),
          ).map(({ kind, label: kindLabel, Icon, color, manColor }) => {
            const isNext = kind === obNextKind
            return (
              <Tooltip
                key={kind}
                label={
                  isNext && obLevel > 0
                    ? `${kindLabel} — next step!`
                    : `Add ${kindLabel}`
                }
                withArrow
                position="bottom"
                openDelay={200}
              >
                <Box
                  className={isNext ? "ob-pulse" : undefined}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    cursor: "pointer",
                    borderRadius: 4,
                    padding: "4px 5px",
                    background: `var(--mantine-color-${manColor}-${isNext ? "2" : "1"})`,
                    outline: isNext
                      ? `2px solid var(--mantine-color-${manColor}-4)`
                      : undefined,
                    outlineOffset: 1,
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    createAndLink(kind)
                  }}
                >
                  <Icon size={isNext ? 24 : 22} color={color} />
                  <Text
                    size="xs"
                    c={manColor}
                    style={{ lineHeight: 1, marginTop: 3, fontWeight: 600 }}
                  >
                    +
                  </Text>
                </Box>
              </Tooltip>
            )
          })}
          <Tooltip
            label="Add sticky note"
            withArrow
            position="bottom"
            openDelay={400}
          >
            <Box
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                cursor: "pointer",
                borderRadius: 4,
                padding: "4px 5px",
                background: "var(--mantine-color-yellow-1)",
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onCreateNote()
              }}
            >
              <IconNote size={22} color="var(--mantine-color-yellow-7)" />
              <Text
                size="xs"
                c="yellow.7"
                style={{ lineHeight: 1, marginTop: 3, fontWeight: 600 }}
              >
                +
              </Text>
            </Box>
          </Tooltip>
          <Tooltip
            label="Add text field"
            withArrow
            position="bottom"
            openDelay={400}
          >
            <Box
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                cursor: "pointer",
                borderRadius: 4,
                padding: "4px 5px",
                background: "var(--mantine-color-gray-1)",
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onCreateText()
              }}
            >
              <IconLetterT size={22} color="var(--mantine-color-gray-7)" />
              <Text
                size="xs"
                c="gray.7"
                style={{ lineHeight: 1, marginTop: 3, fontWeight: 600 }}
              >
                +
              </Text>
            </Box>
          </Tooltip>
        </Box>
      )}
    </Box>
  )
}

// Ordered list of entity kinds shown in every collection
const SIX_KINDS: {
  kind: CollectionRef["kind"]
  label: string
  Icon: React.ElementType
  color: string
  manColor: string
}[] = [
  {
    kind: "process",
    label: "Processes",
    Icon: IconStack3,
    color: "var(--mantine-color-gray-6)",
    manColor: "gray",
  },
  {
    kind: "experiment",
    label: "Experiments",
    Icon: IconPlayerPlay,
    color: "var(--mantine-color-grape-6)",
    manColor: "grape",
  },
  {
    kind: "result",
    label: "Results",
    Icon: IconDownload,
    color: "var(--mantine-color-orange-6)",
    manColor: "orange",
  },
  {
    kind: "analysis",
    label: "Analyses",
    Icon: IconChartBar,
    color: "var(--mantine-color-red-6)",
    manColor: "red",
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 0 = no processes yet   → only "process" + note + text unlocked
 * 1 = has process(es)    → + "experiment" unlocked (highlighted)
 * 2 = has experiment(s)  → + "result" unlocked (highlighted)
 * 3 = has result(s)      → + "analysis" unlocked (highlighted)
 * 4 = complete           → all kinds unlocked, no guidance shown
 */
type OnboardingLevel = 0 | 1 | 2 | 3 | 4

const ONBOARDING_UNLOCK: Record<OnboardingLevel, CollectionRef["kind"][]> = {
  0: ["process"],
  1: ["process", "experiment"],
  2: ["process", "experiment", "result"],
  3: ["process", "experiment", "result", "analysis"],
  4: ["process", "experiment", "result", "analysis"],
}

const ONBOARDING_NEXT_KIND: Record<
  OnboardingLevel,
  CollectionRef["kind"] | null
> = {
  0: "process",
  1: "experiment",
  2: "result",
  3: "analysis",
  4: null,
}

const ONBOARDING_STEPS: Record<
  0 | 1 | 2 | 3,
  { step: number; title: string; body: string }
> = {
  0: {
    step: 1,
    title: "Create your first Process",
    body: "A Process is the recipe for your device — it defines fabrication steps and chemistry. Hover any empty cell and click the Process icon to begin.",
  },
  1: {
    step: 2,
    title: "Create an Experiment",
    body: "Process defined! An Experiment is a concrete run of your process — it records dates, substrates, and the actual materials used.",
  },
  2: {
    step: 3,
    title: "Upload Results",
    body: "Experiment logged! Add measurement files to capture device performance data for this run.",
  },
  3: {
    step: 4,
    title: "Run an Analysis",
    body: "Data uploaded! Create an Analysis to visualise and compare results across experiments.",
  },
}

const ONBOARDING_COLORS: Record<0 | 1 | 2 | 3, string> = {
  0: "gray",
  1: "grape",
  2: "orange",
  3: "red",
}

function useOnboardingLevel(): OnboardingLevel {
  const { processes, experiments, results, planes } = useAppContext()
  return useMemo((): OnboardingLevel => {
    if (processes.length === 0) return 0
    if (experiments.length === 0) return 1
    if (results.length === 0) return 2
    const analysisCount = planes.reduce((total, p) => {
      return (
        total +
        p.elements
          .filter((e) => e.type === "collection")
          .flatMap((e) => (e as CanvasCollectionElement).refs)
          .filter((r) => r.kind === "analysis").length
      )
    }, 0)
    if (analysisCount === 0) return 3
    return 4
  }, [processes.length, experiments.length, results.length, planes])
}

const ONBOARDING_AUTO_DISMISS_MS = 9000

function OnboardingBanner({ level }: { level: OnboardingLevel }) {
  const [dismissedLevel, setDismissedLevel] = useState<OnboardingLevel | null>(
    null,
  )
  const [visible, setVisible] = useState(false)

  // Slide in from below after a short delay; auto-dismiss after a while; reset when level advances
  useEffect(() => {
    if (level === 4 || level === dismissedLevel) return
    setVisible(false)
    const slideIn = setTimeout(() => setVisible(true), 600)
    const autoDismiss = setTimeout(
      () => setDismissedLevel(level),
      600 + ONBOARDING_AUTO_DISMISS_MS,
    )
    return () => {
      clearTimeout(slideIn)
      clearTimeout(autoDismiss)
    }
  }, [level, dismissedLevel])

  if (level === 4 || level === dismissedLevel) return null

  const info = ONBOARDING_STEPS[level]
  const color = ONBOARDING_COLORS[level]
  const nextMeta = SIX_KINDS.find((k) => k.kind === ONBOARDING_NEXT_KIND[level])

  return (
    <Box
      style={{
        position: "absolute",
        bottom: 20,
        left: "50%",
        transform: `translateX(-50%) translateY(${visible ? "0" : "24px"})`,
        opacity: visible ? 1 : 0,
        transition:
          "transform 0.4s cubic-bezier(0.34, 1.4, 0.64, 1), opacity 0.35s ease",
        zIndex: 200,
        maxWidth: 480,
        width: "calc(100% - 48px)",
        pointerEvents: "none",
      }}
    >
      <Paper
        shadow="md"
        px="md"
        py="sm"
        radius="md"
        style={{
          border: `2px solid var(--mantine-color-${color}-4)`,
          background: `var(--mantine-color-${color}-0)`,
          pointerEvents: "auto",
        }}
      >
        <Group gap="sm" wrap="nowrap" align="flex-start">
          {nextMeta && (
            <nextMeta.Icon
              size={22}
              color={nextMeta.color}
              style={{ flexShrink: 0, marginTop: 1 }}
            />
          )}
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Group gap="xs" mb={3} align="center">
              <Badge size="xs" color={color} variant="filled">
                Step {info.step} / 4
              </Badge>
              <Text size="sm" fw={700}>
                {info.title}
              </Text>
            </Group>
            <Text size="xs" c="dimmed">
              {info.body}
            </Text>
          </Box>
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            style={{ flexShrink: 0, marginTop: 1 }}
            onClick={() => setDismissedLevel(level)}
            aria-label="Dismiss"
          >
            <IconX size={12} />
          </ActionIcon>
        </Group>
      </Paper>
    </Box>
  )
}

function CollectionEl({
  el,
  planeId,
  isFirstPlane,
  onUpdate,
  onDelete,
  pan,
  isDragOver,
  isDragging,
  onStartDivide,
  onDragCollectionStart,
  onDragCollectionEnd,
  onCreateNote,
  onCreateText,
}: {
  el: CanvasCollectionElement
  planeId: string
  isFirstPlane: boolean
  onUpdate: (e: CanvasElement) => void
  onDelete: () => void
  pan: Vec2
  isDragOver: boolean
  isDragging: boolean
  onStartDivide: () => void
  onDragCollectionStart: () => void
  onDragCollectionEnd: () => void
  onCreateNote: () => void
  onCreateText: () => void
}) {
  const {
    processes,
    setProcesses,
    experiments,
    setExperiments,
    results,
    setResults,
    planes,
    activeCollectionId,
    setActiveCollectionId,
    setActivePlaneId,
    setActiveEntity,
    setPendingCollectionLink,
    uploadFlow,
  } = useAppContext()
  const startOrAddUpload = useStartOrAddUpload()
  // A file drop targeting this collection stages an incomplete upload. It shows
  // a blinking red marker until the flow finishes and becomes a real result.
  const uploadPending =
    uploadFlow != null &&
    uploadFlow.targetCollectionId === el.id &&
    !isUploadFlowComplete(
      getUploadFlowSteps(uploadFlow, { processes, experiments, results }),
    )
  // Only a brand-new (empty) collection collapses to just the marker. A
  // populated collection keeps all its items visible/accessible alongside it.
  const markerOnly = uploadPending && el.refs.length === 0
  const rawObLevel = useOnboardingLevel()
  const obLevel: OnboardingLevel = isFirstPlane ? rawObLevel : 4
  const obNextKind = ONBOARDING_NEXT_KIND[obLevel]
  const isActive = activeCollectionId === el.id
  const navigate = useNavigate()
  const [isExpanded, setIsExpanded] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameBuffer, setNameBuffer] = useState(el.name)
  const [hoveredRefKind, setHoveredRefKind] = useState<
    CollectionRef["kind"] | null
  >(null)
  const [addPopoverKind, setAddPopoverKind] = useState<
    CollectionRef["kind"] | null
  >(null)
  const [hoveredSlot, setHoveredSlot] = useState<CollectionRef["kind"] | null>(
    null,
  )
  const [hoveredRowKind, setHoveredRowKind] = useState<
    CollectionRef["kind"] | null
  >(null)
  const [isCardHovered, setIsCardHovered] = useState(false)
  const expandedRef = useRef<HTMLDivElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const keepHoverOpen = () => {
    if (closeTimerRef.current !== null)
      window.clearTimeout(closeTimerRef.current)
  }
  const scheduleHoverClose = () => {
    closeTimerRef.current = window.setTimeout(
      () => setHoveredRefKind(null),
      250,
    )
  }

  // Collapse on click-outside
  useEffect(() => {
    if (!isExpanded) return
    const handler = (e: Event) => {
      if (!expandedRef.current?.contains(e.target as Node)) {
        setIsExpanded(false)
        setHoveredRefKind(null)
        setAddPopoverKind(null)
      }
    }
    document.addEventListener("mousedown", handler, true)
    return () => document.removeEventListener("mousedown", handler, true)
  }, [isExpanded])

  // Collapse on Escape
  useEffect(() => {
    if (!isExpanded) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsExpanded(false)
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [isExpanded])

  // Auto-start name editing when the first ref is added to a new collection
  const prevRefCountRef = useRef(el.refs.length)
  useEffect(() => {
    if (prevRefCountRef.current === 0 && el.refs.length > 0) {
      setEditingName(true)
      setNameBuffer(el.name)
    }
    prevRefCountRef.current = el.refs.length
  }, [el.refs.length, el.name])

  const startRefDrag = (
    e: ReactDragEvent<HTMLElement>,
    payload: CollectionRefDragPayload,
  ) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = "move"
    const encoded = JSON.stringify(payload)
    e.dataTransfer.setData(COLLECTION_REF_DRAG_MIME, encoded)
    e.dataTransfer.setData("text/plain", encoded)
  }

  const commitName = () => {
    onUpdate({ ...el, name: nameBuffer.trim() || el.name })
    setEditingName(false)
  }

  const handleDeleteCollection = () => {
    const collectionRefIds = new Set(el.refs.map((r) => r.id))

    // Find blocking external dependencies (items outside this collection that reference items inside it)
    const blockingDeps: DependencyLocation[] = []
    for (const ref of el.refs) {
      if (ref.kind === "process") {
        const deps = getDependentLocations("process", ref.id, {
          experiments,
          processes,
          planes,
        })
        for (const dep of deps) {
          if (!collectionRefIds.has(dep.itemId)) blockingDeps.push(dep)
        }
      }
      if (ref.kind === "experiment") {
        for (const result of results) {
          if (
            result.experimentId === ref.id &&
            !collectionRefIds.has(result.id)
          ) {
            let planeName = "(unknown)"
            let collectionName = "(unknown)"
            for (const p of planes) {
              for (const e of p.elements) {
                if (
                  e.type === "collection" &&
                  (e as CanvasCollectionElement).refs.some(
                    (r) => r.kind === "result" && r.id === result.id,
                  )
                ) {
                  planeName = p.name
                  collectionName = (e as CanvasCollectionElement).name
                }
              }
            }
            blockingDeps.push({
              planeName,
              collectionName,
              itemKind: "result",
              itemName: `Result (${result.id.slice(0, 6)}…)`,
              itemId: result.id,
            })
          }
        }
      }
    }

    const doDelete = () => {
      const processIds = new Set(
        el.refs.filter((r) => r.kind === "process").map((r) => r.id),
      )
      const experimentIds = new Set(
        el.refs.filter((r) => r.kind === "experiment").map((r) => r.id),
      )
      const resultIds = new Set(
        el.refs.filter((r) => r.kind === "result").map((r) => r.id),
      )
      if (processIds.size)
        setProcesses((prev) => prev.filter((p) => !processIds.has(p.id)))
      if (experimentIds.size)
        setExperiments((prev) => prev.filter((e) => !experimentIds.has(e.id)))
      if (resultIds.size)
        setResults((prev) => prev.filter((r) => !resultIds.has(r.id)))
      setIsExpanded(false)
      onDelete()
    }

    if (blockingDeps.length > 0) {
      modals.open({
        title: "Cannot delete collection",
        children: (
          <>
            <Text size="sm" mb="sm">
              The following items outside this collection depend on its
              contents. Remove those dependencies first.
            </Text>
            <Table withTableBorder withColumnBorders mb="md" fz="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Plane</Table.Th>
                  <Table.Th>Collection</Table.Th>
                  <Table.Th>Item</Table.Th>
                  <Table.Th>Type</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {blockingDeps.map((dep, i) => (
                  <Table.Tr key={`${dep.itemId}-${i}`}>
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
        ),
      })
      return
    }

    modals.openConfirmModal({
      title: `Delete "${el.name}"?`,
      children: (
        <Text size="sm">
          This will permanently delete the collection and all{" "}
          <strong>{el.refs.length}</strong> item
          {el.refs.length !== 1 ? "s" : ""} within it. This cannot be undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: doDelete,
    })
  }

  const handleBubbleClick = (kind: CollectionRef["kind"]) => {
    setPendingCollectionLink({
      collectionId: el.id,
      planeId,
      kind,
      requestId: crypto.randomUUID(),
    })
    navigate({ to: ROUTE_FOR_KIND[kind] })
  }

  const handleAddExperimentFromProcess = (processId: string) => {
    setPendingCollectionLink({
      collectionId: el.id,
      planeId,
      kind: "experiment",
      selectedProcessId: processId,
      requestId: crypto.randomUUID(),
    })
    navigate({ to: ROUTE_FOR_KIND.experiment })
  }

  const handleAddResultsForExperiment = (experimentId: string) => {
    setPendingCollectionLink({
      collectionId: el.id,
      planeId,
      kind: "result",
      selectedExperimentId: experimentId,
      requestId: crypto.randomUUID(),
    })
    navigate({ to: ROUTE_FOR_KIND.result })
  }

  const handleRefIconClick = (kind: CollectionRef["kind"]) => {
    setActiveCollectionId(el.id)
    setActivePlaneId(planeId)
    navigate({ to: ROUTE_FOR_KIND[kind] })
  }

  const handleRefItemClick = (kind: CollectionRef["kind"], id: string) => {
    setActiveCollectionId(el.id)
    setActivePlaneId(planeId)
    if (kind === "process" || kind === "experiment") {
      setActiveEntity({ kind, id })
    }
    navigate({ to: ROUTE_FOR_KIND[kind] })
  }

  const labelForRef = (kind: CollectionRef["kind"], id: string) => {
    if (kind === "process") {
      const p = processes.find((x) => x.id === id)
      return p ? p.name || p.id : id
    }
    if (kind === "experiment") {
      const exp = experiments.find((x) => x.id === id)
      return exp ? exp.name || exp.id : id
    }
    if (kind === "result") {
      const r = results.find((x) => x.id === id)
      if (!r) return id
      const exp = experiments.find((x) => x.id === r.experimentId)
      return `Results for experiment ${exp ? exp.name || exp.id : r.experimentId}`
    }
    return id
  }

  // Collect plane-scoped process/experiment options for add submenus
  const currentPlane = planes.find((p) => p.id === planeId)
  const planeRefs = (currentPlane?.elements ?? [])
    .filter((e) => e.type === "collection")
    .flatMap((e) => (e as CanvasCollectionElement).refs)
  const planeProcessIds = new Set(
    planeRefs.filter((r) => r.kind === "process").map((r) => r.id),
  )
  const planeExperimentIds = new Set(
    planeRefs.filter((r) => r.kind === "experiment").map((r) => r.id),
  )

  const processOptions = [...processes]
    .filter((p) => planeProcessIds.has(p.id))
    .map((p) => ({ id: p.id, name: p.name || p.id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const groupedExperiments = [...experiments]
    .filter((e) => planeExperimentIds.has(e.id))
    .sort((a, b) => {
      const da = Date.parse(a.date || "")
      const db = Date.parse(b.date || "")
      return (Number.isNaN(db) ? 0 : db) - (Number.isNaN(da) ? 0 : da)
    })
    .reduce<
      Array<{
        processId: string
        processName: string
        experiments: Array<{ id: string; name: string; date: string }>
      }>
    >((acc, exp) => {
      const process = processes.find((p) => p.id === exp.processId)
      const processId = process?.id || "unassigned"
      const processName = process?.name || "Unassigned Process"
      const existing = acc.find((g) => g.processId === processId)
      const payload = { id: exp.id, name: exp.name || exp.id, date: exp.date }
      if (existing) existing.experiments.push(payload)
      else acc.push({ processId, processName, experiments: [payload] })
      return acc
    }, [])
    .sort((a, b) => a.processName.localeCompare(b.processName))

  // Col 2 (expanded view): item list for hoveredRefKind
  const renderItemPanel = () => {
    if (hoveredRefKind === null) return null
    const kind = hoveredRefKind
    const refs = el.refs.filter((r) => r.kind === kind)
    if (refs.length === 0) return null
    const kindMeta = SIX_KINDS.find((k) => k.kind === kind)!
    return (
      <Stack gap={3} pt={1} onPointerDown={(e) => e.stopPropagation()}>
        {refs.map((r, idx) => (
          <Button
            key={`${r.id}-${idx}`}
            variant="subtle"
            color="gray"
            size="compact-xs"
            fullWidth
            draggable
            styles={{
              inner: { justifyContent: "flex-start" },
              label: {
                maxWidth: 120,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            }}
            onClick={(e) => {
              e.stopPropagation()
              setHoveredRefKind(null)
              handleRefItemClick(kind, r.id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onDragStart={(e) =>
              startRefDrag(e, {
                sourceCollectionId: el.id,
                kind,
                mode: "single",
                refIds: [r.id],
              })
            }
          >
            {labelForRef(kind, r.id)}
          </Button>
        ))}
        {refs.length > 1 && (
          <Button
            variant="light"
            color={kindMeta.manColor}
            size="compact-xs"
            fullWidth
            draggable
            styles={{ inner: { justifyContent: "flex-start" } }}
            onDragStart={(e) =>
              startRefDrag(e, {
                sourceCollectionId: el.id,
                kind,
                mode: "kind",
                refIds: refs.map((r) => r.id),
              })
            }
            onClick={(e) => {
              e.stopPropagation()
              setHoveredRefKind(null)
              handleRefIconClick(kind)
            }}
          >
            All ({refs.length}) →
          </Button>
        )}
      </Stack>
    )
  }

  // Col 4 (expanded view): add submenu for addPopoverKind
  const renderAddPanel = () => {
    if (addPopoverKind === null) return null
    const kind = addPopoverKind
    if (kind === "experiment") {
      if (processOptions.length === 0) {
        return (
          <Box pt={1}>
            <Text size="xs" c="dimmed" mb={4}>
              No processes on canvas
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              color="grape"
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              onClick={(e) => {
                e.stopPropagation()
                setAddPopoverKind(null)
                handleBubbleClick("experiment")
              }}
            >
              Create experiment
            </Button>
          </Box>
        )
      }
      return (
        <Stack gap={2} pt={1}>
          <Text size="10px" fw={600} c="dimmed">
            From process
          </Text>
          {processOptions.map((p) => (
            <Button
              key={p.id}
              size="compact-xs"
              variant="subtle"
              color="grape"
              styles={{ inner: { justifyContent: "flex-start" } }}
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              onClick={(e) => {
                e.stopPropagation()
                setAddPopoverKind(null)
                handleAddExperimentFromProcess(p.id)
              }}
            >
              {p.name}
            </Button>
          ))}
        </Stack>
      )
    }
    if (kind === "result") {
      if (groupedExperiments.length === 0) {
        return (
          <Box pt={1}>
            <Text size="xs" c="dimmed" mb={4}>
              No experiments on canvas
            </Text>
            <Button
              size="compact-xs"
              variant="light"
              color="orange"
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
              }}
              onClick={(e) => {
                e.stopPropagation()
                setAddPopoverKind(null)
                handleBubbleClick("result")
              }}
            >
              Upload results
            </Button>
          </Box>
        )
      }
      return (
        <Stack gap={2} pt={1}>
          <Text size="10px" fw={600} c="dimmed">
            For experiment
          </Text>
          <ScrollArea h={140}>
            <Stack gap={3}>
              {groupedExperiments.map((group) => (
                <Stack key={group.processId} gap={2}>
                  <Text size="10px" fw={600} c="gray.6">
                    {group.processName}
                  </Text>
                  {group.experiments.map((exp) => (
                    <Button
                      key={exp.id}
                      size="compact-xs"
                      variant="subtle"
                      color="orange"
                      styles={{ inner: { justifyContent: "space-between" } }}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setAddPopoverKind(null)
                        handleAddResultsForExperiment(exp.id)
                      }}
                    >
                      <span>{exp.name}</span>
                      <span style={{ opacity: 0.6 }}>{exp.date || "-"}</span>
                    </Button>
                  ))}
                </Stack>
              ))}
            </Stack>
          </ScrollArea>
        </Stack>
      )
    }
    return null
  }

  const boxStyle: React.CSSProperties = {
    position: "absolute",
    left: el.position.x + pan.x,
    top: el.position.y + pan.y,
    width: CELL_W,
    height: CELL_H,
    userSelect: "none",
    zIndex: isExpanded ? 100 : 1,
    opacity: isDragging ? 0.35 : 1,
    transition: "opacity 80ms ease",
  }

  return (
    <Box
      style={boxStyle}
      draggable={!isExpanded}
      onDragStart={(e: ReactDragEvent<HTMLDivElement>) => {
        if (isExpanded) {
          e.preventDefault()
          return
        }
        const payload: CollectionElementDragPayload = { collectionId: el.id }
        e.dataTransfer.effectAllowed = "move"
        e.dataTransfer.setData(
          COLLECTION_ELEMENT_DRAG_MIME,
          JSON.stringify(payload),
        )
        e.dataTransfer.setData("text/plain", JSON.stringify(payload))
        requestAnimationFrame(() => onDragCollectionStart())
      }}
      onDragEnd={() => onDragCollectionEnd()}
    >
      {/* ── RETRACTED VIEW ──────────────────────────────────────────────── */}
      {!isExpanded && (
        <Paper
          shadow="xs"
          style={{
            position: "absolute",
            inset: 0,
            boxSizing: "border-box",
            padding: 8,
            display: "flex",
            flexDirection: "column",
            border: isDragOver
              ? "3px dashed var(--mantine-color-blue-5)"
              : isActive
                ? `3px solid ${el.color || DEFAULT_ACCENT}`
                : `2px solid ${el.color || DEFAULT_ACCENT}88`,
            boxShadow:
              isActive && !isDragOver
                ? `0 0 0 3px ${el.color || DEFAULT_ACCENT}33, 0 0 14px 4px ${el.color || DEFAULT_ACCENT}1a`
                : undefined,
            background: isDragOver
              ? "var(--mantine-color-blue-0)"
              : "var(--mantine-color-body)",
            cursor: "pointer",
            overflow: "hidden",
            transition: "border 120ms ease, box-shadow 120ms ease",
          }}
          onMouseEnter={() => setIsCardHovered(true)}
          onMouseLeave={() => setIsCardHovered(false)}
          onClick={() => {
            setIsExpanded(true)
            setActiveCollectionId(el.id)
          }}
        >
          {/* Name */}
          <Text
            fw={600}
            size="sm"
            style={{
              lineHeight: 1.2,
              marginBottom: 6,
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
            }}
          >
            {el.name}
          </Text>

          {/* Icons: empty collection → always show all add symbols; partially filled → filled icons + empty on hover */}
          <Box
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              flex: 1,
              alignContent: "flex-start",
            }}
          >
            {/* Incomplete upload marker — blinking red until the flow finishes */}
            {uploadPending && (
              <Tooltip
                label="Upload not finished — click to choose a process & experiment before it becomes a result"
                withArrow
                position="bottom"
                openDelay={200}
                multiline
                w={220}
              >
                <Box
                  className="upload-pending-blink"
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    cursor: "pointer",
                    borderRadius: 4,
                    padding: "4px 5px",
                    background: "var(--mantine-color-red-1)",
                    outline: "2px solid var(--mantine-color-red-5)",
                    outlineOffset: 1,
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    modals.open({
                      title: "Finish file upload",
                      children: (
                        <Stack gap="sm">
                          <Text size="sm" c="dimmed">
                            Choose which process and experiment these files
                            belong to.
                          </Text>
                          <UploadFlowTargetPicker
                            onNavigateAway={() => modals.closeAll()}
                          />
                          <Group justify="flex-end">
                            <Button
                              variant="default"
                              size="xs"
                              onClick={() => modals.closeAll()}
                            >
                              Done
                            </Button>
                          </Group>
                        </Stack>
                      ),
                    })
                  }}
                >
                  <IconCloudUpload
                    size={22}
                    color="var(--mantine-color-red-6)"
                  />
                  <Text
                    size="xs"
                    c="red.7"
                    style={{ lineHeight: 1, marginTop: 3, fontWeight: 700 }}
                  >
                    !
                  </Text>
                </Box>
              </Tooltip>
            )}

            {/* Filled items first — kept visible unless this is an empty card
                collapsed to just the pending marker */}
            {!markerOnly &&
              SIX_KINDS.filter(({ kind }) =>
                el.refs.some((r) => r.kind === kind),
              ).map(({ kind, label: kindLabel, Icon, color }) => {
                const refs = el.refs.filter((r) => r.kind === kind)
                return (
                  <Tooltip
                    key={kind}
                    label={`${kindLabel} (${refs.length})`}
                    withArrow
                    position="bottom"
                    openDelay={400}
                  >
                    <Box
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        cursor: "pointer",
                        borderRadius: 4,
                        padding: "4px 5px",
                        background:
                          hoveredSlot === kind
                            ? "var(--mantine-color-default-hover)"
                            : "transparent",
                        transition: "background 100ms ease",
                      }}
                      onMouseEnter={() => setHoveredSlot(kind)}
                      onMouseLeave={() => setHoveredSlot(null)}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRefIconClick(kind)
                      }}
                    >
                      <Icon size={22} color={color} />
                      <Text
                        size="xs"
                        c="dimmed"
                        style={{ lineHeight: 1, marginTop: 3, fontWeight: 500 }}
                      >
                        {refs.length}
                      </Text>
                    </Box>
                  </Tooltip>
                )
              })}

            {/* "+" add slots — always to the right of filled items, shown on hover (or always if empty) */}
            {!markerOnly &&
              (isCardHovered || el.refs.length === 0) &&
              SIX_KINDS.filter(
                ({ kind }) =>
                  !el.refs.some((r) => r.kind === kind) &&
                  ONBOARDING_UNLOCK[obLevel].includes(kind),
              ).map(({ kind, label: kindLabel, Icon, color, manColor }) => {
                const isNext = kind === obNextKind
                return (
                  <Tooltip
                    key={kind}
                    label={
                      isNext && obLevel > 0
                        ? `${kindLabel} — next step!`
                        : `Add ${kindLabel}`
                    }
                    withArrow
                    position="bottom"
                    openDelay={200}
                  >
                    <Box
                      className={isNext ? "ob-pulse" : undefined}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        cursor: "pointer",
                        borderRadius: 4,
                        padding: "4px 5px",
                        background: `var(--mantine-color-${manColor}-${isNext ? "2" : "1"})`,
                        outline: isNext
                          ? `2px solid var(--mantine-color-${manColor}-4)`
                          : undefined,
                        outlineOffset: 1,
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleBubbleClick(kind)
                      }}
                    >
                      <Icon size={isNext ? 24 : 22} color={color} />
                      <Text
                        size="xs"
                        c={manColor}
                        style={{ lineHeight: 1, marginTop: 3, fontWeight: 600 }}
                      >
                        +
                      </Text>
                    </Box>
                  </Tooltip>
                )
              })}

            {/* Result-file upload — small, non-dominant red affordance shown on
                every collection so files can be uploaded without dragging. */}
            {!markerOnly && (
              <FileButton
                multiple
                onChange={(picked) => {
                  if (picked.length > 0) {
                    startOrAddUpload(picked, {
                      collectionId: el.id,
                      planeId,
                    })
                  }
                }}
              >
                {(fileBtnProps) => (
                  <Tooltip
                    label="Upload result files"
                    withArrow
                    position="bottom"
                    openDelay={300}
                  >
                    <Box
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        cursor: "pointer",
                        borderRadius: 4,
                        padding: "4px 5px",
                        background: "var(--mantine-color-red-0)",
                        outline: "1px dashed var(--mantine-color-red-4)",
                        outlineOffset: 1,
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        fileBtnProps.onClick()
                      }}
                    >
                      <IconCloudUpload
                        size={20}
                        color="var(--mantine-color-red-6)"
                      />
                      <Text
                        size="xs"
                        c="red.7"
                        style={{
                          lineHeight: 1,
                          marginTop: 3,
                          fontWeight: 600,
                        }}
                      >
                        ↑
                      </Text>
                    </Box>
                  </Tooltip>
                )}
              </FileButton>
            )}

            {/* Note + textfield add buttons — same size/style, only when collection is fully empty */}
            {!markerOnly && el.refs.length === 0 && (
              <>
                <Tooltip
                  label="Add sticky note"
                  withArrow
                  position="bottom"
                  openDelay={400}
                >
                  <Box
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      cursor: "pointer",
                      borderRadius: 4,
                      padding: "4px 5px",
                      background: "var(--mantine-color-yellow-1)",
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onCreateNote()
                    }}
                  >
                    <IconNote size={22} color="var(--mantine-color-yellow-7)" />
                    <Text
                      size="xs"
                      c="yellow.7"
                      style={{ lineHeight: 1, marginTop: 3, fontWeight: 600 }}
                    >
                      +
                    </Text>
                  </Box>
                </Tooltip>
                <Tooltip
                  label="Add text field"
                  withArrow
                  position="bottom"
                  openDelay={400}
                >
                  <Box
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      cursor: "pointer",
                      borderRadius: 4,
                      padding: "4px 5px",
                      background: "var(--mantine-color-gray-1)",
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onCreateText()
                    }}
                  >
                    <IconLetterT
                      size={22}
                      color="var(--mantine-color-gray-7)"
                    />
                    <Text
                      size="xs"
                      c="gray.7"
                      style={{ lineHeight: 1, marginTop: 3, fontWeight: 600 }}
                    >
                      +
                    </Text>
                  </Box>
                </Tooltip>
              </>
            )}
          </Box>
        </Paper>
      )}

      {/* Drag-over ghost when no refs yet and retracted */}
      {!isExpanded && isDragOver && el.refs.length === 0 && (
        <Box
          style={{
            position: "absolute",
            inset: 4,
            border: "2px dashed var(--mantine-color-blue-5)",
            borderRadius: 8,
            background: "var(--mantine-color-blue-0)",
            pointerEvents: "none",
          }}
        />
      )}

      {/* ── EXPANDED VIEW ───────────────────────────────────────────────── */}
      {isExpanded && (
        <Paper
          ref={expandedRef}
          shadow="lg"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 430,
            boxSizing: "border-box",
            padding: "8px 8px 8px 8px",
            display: "flex",
            flexDirection: "column",
            border: `3px solid ${el.color || DEFAULT_ACCENT}`,
            boxShadow: `0 0 0 3px ${el.color || DEFAULT_ACCENT}33, 0 0 14px 4px ${el.color || DEFAULT_ACCENT}1a`,
            background: "var(--mantine-color-body)",
            zIndex: 100,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header: name + divide + close */}
          <Group
            justify="space-between"
            mb={6}
            wrap="nowrap"
            style={{ minHeight: 28 }}
          >
            <Box
              style={{ flex: 1, minWidth: 0 }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {editingName ? (
                <TextInput
                  size="xs"
                  value={nameBuffer}
                  autoFocus
                  onChange={(e) => setNameBuffer(e.currentTarget.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitName()
                    if (e.key === "Escape") setEditingName(false)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <Text
                  fw={600}
                  size="sm"
                  style={{
                    cursor: "text",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setEditingName(true)
                    setNameBuffer(el.name)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {el.name}
                </Text>
              )}
            </Box>
            <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
              {el.refs.length > 0 && (
                <Tooltip label="Divide collection" withArrow openDelay={400}>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="violet"
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      setIsExpanded(false)
                      onStartDivide()
                    }}
                  >
                    <IconSeparatorVertical size={10} />
                  </ActionIcon>
                </Tooltip>
              )}
              {el.refs.length > 0 && (
                <Tooltip label="Delete collection" withArrow openDelay={400}>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="red"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteCollection()
                    }}
                  >
                    <IconTrash size={10} />
                  </ActionIcon>
                </Tooltip>
              )}
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  setIsExpanded(false)
                }}
              >
                <IconX size={10} />
              </ActionIcon>
            </Group>
          </Group>

          {/* Col 1 (browse) + Col 3 (add) side by side, then one shared submenu panel */}
          <Box style={{ display: "flex", gap: 0, alignItems: "flex-start" }}>
            {/* Icon columns */}
            <Box style={{ flexShrink: 0 }} onMouseLeave={scheduleHoverClose}>
              {SIX_KINDS.map(
                ({ kind, label: kindLabel, Icon, color, manColor }) => {
                  const refs = el.refs.filter((r) => r.kind === kind)
                  const hasRefs = refs.length > 0
                  return (
                    <Box
                      key={kind}
                      style={{
                        height: 36,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                      onMouseEnter={() => setHoveredRowKind(kind)}
                      onMouseLeave={() => setHoveredRowKind(null)}
                    >
                      {/* Col 1: icon + count, hover → show items in shared panel */}
                      <Box
                        style={{
                          width: 52,
                          height: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: 5,
                          paddingLeft: 3,
                          cursor: hasRefs ? "pointer" : "default",
                          borderRadius: 4,
                          background:
                            hoveredRefKind === kind && hasRefs
                              ? "var(--mantine-color-default-hover)"
                              : "transparent",
                          transition: "background 80ms ease",
                        }}
                        onMouseEnter={() => {
                          if (hasRefs) {
                            keepHoverOpen()
                            setHoveredRefKind(kind)
                          }
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (hasRefs) handleRefIconClick(kind)
                        }}
                      >
                        <Icon
                          size={20}
                          color={color}
                          style={{ flexShrink: 0, opacity: hasRefs ? 1 : 0.2 }}
                        />
                        {hasRefs && (
                          <Text
                            size="sm"
                            c="dimmed"
                            fw={500}
                            style={{ lineHeight: 1 }}
                          >
                            {refs.length}
                          </Text>
                        )}
                      </Box>

                      {/* Col 3: add button — only shown when kind is unlocked and row is hovered/active */}
                      {ONBOARDING_UNLOCK[obLevel].includes(kind) &&
                        (hoveredRowKind === kind ||
                          addPopoverKind === kind ||
                          hoveredRefKind === kind) && (
                          <Tooltip
                            label={
                              kind === obNextKind && obLevel > 0
                                ? `${kindLabel} — next step!`
                                : `Add ${kindLabel}`
                            }
                            withArrow
                            openDelay={200}
                            position="right"
                          >
                            <Box
                              className={
                                kind === obNextKind ? "ob-pulse" : undefined
                              }
                              style={{
                                width: 30,
                                height: 30,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                cursor: "pointer",
                                borderRadius: 4,
                                background:
                                  addPopoverKind === kind
                                    ? `var(--mantine-color-${manColor}-2)`
                                    : kind === obNextKind
                                      ? `var(--mantine-color-${manColor}-2)`
                                      : `var(--mantine-color-${manColor}-1)`,
                                outline:
                                  kind === obNextKind
                                    ? `2px solid var(--mantine-color-${manColor}-4)`
                                    : undefined,
                                outlineOffset: 1,
                              }}
                              onPointerDown={(e) => {
                                e.stopPropagation()
                                e.preventDefault()
                              }}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (
                                  kind === "experiment" ||
                                  kind === "result"
                                ) {
                                  setAddPopoverKind(
                                    addPopoverKind === kind ? null : kind,
                                  )
                                } else {
                                  handleBubbleClick(kind)
                                }
                              }}
                            >
                              <Text
                                fw={700}
                                c={manColor}
                                style={{ fontSize: 20, lineHeight: 1 }}
                              >
                                +
                              </Text>
                            </Box>
                          </Tooltip>
                        )}
                    </Box>
                  )
                },
              )}
            </Box>

            {/* Shared submenu panel — content slides to the active row's vertical position */}
            <Box
              style={{
                flex: 1,
                minWidth: 0,
                borderLeft: "1px solid var(--mantine-color-default-border)",
                marginLeft: 8,
                paddingLeft: 8,
                paddingRight: 4,
              }}
              onMouseEnter={keepHoverOpen}
              onMouseLeave={scheduleHoverClose}
            >
              {(() => {
                const kind = hoveredRefKind ?? addPopoverKind
                if (!kind) return null
                const rowIndex = SIX_KINDS.findIndex((k) => k.kind === kind)
                const content =
                  hoveredRefKind !== null ? renderItemPanel() : renderAddPanel()
                if (!content) return null
                return (
                  <Box style={{ marginTop: rowIndex * 36, paddingTop: 2 }}>
                    {content}
                  </Box>
                )
              })()}
            </Box>
          </Box>
        </Paper>
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Division overlay - expanded view for splitting a collection
// ─────────────────────────────────────────────────────────────────────────────

type DivisionSide = "left" | "right" | "center"

/** Icon for each ref kind */
const REF_ICONS: Record<
  CollectionRef["kind"],
  { Icon: React.ElementType; color: string }
> = {
  experiment: { Icon: IconPlayerPlay, color: "grape" },
  process: { Icon: IconStack3, color: "gray" },
  result: { Icon: IconDownload, color: "orange" },
  analysis: { Icon: IconChartBar, color: "red" },
}

/** Helper to get name for a ref from context data */
function useRefName() {
  const { experiments, processes } = useAppContext()
  return useCallback(
    (ref: CollectionRef): string => {
      switch (ref.kind) {
        case "process":
          return (
            processes.find((p) => p.id === ref.id)?.name ||
            `Process ${ref.id.slice(0, 6)}`
          )
        case "experiment":
          return (
            experiments.find((e) => e.id === ref.id)?.name ||
            `Experiment ${ref.id.slice(0, 6)}`
          )
        case "result":
          return `Result ${ref.id.slice(0, 6)}`
        case "analysis":
          return `Analysis ${ref.id.slice(0, 6)}`
        default:
          return ref.id.slice(0, 8)
      }
    },
    [processes, experiments],
  )
}

/** Detailed Division Modal - shows all individual refs of one kind for left/right assignment */
function DetailedDivisionModal({
  kind,
  refs,
  initialAssignments,
  onConfirm,
  onCancel,
}: {
  kind: CollectionRef["kind"]
  refs: CollectionRef[]
  initialAssignments: Record<string, "left" | "right">
  onConfirm: (assignments: Record<string, "left" | "right">) => void
  onCancel: () => void
}) {
  const getRefName = useRefName()
  const { Icon, color } = REF_ICONS[kind]

  // Per-ref assignments: id -> 'left' | 'right'
  const [refAssigns, setRefAssigns] =
    useState<Record<string, "left" | "right">>(initialAssignments)
  const [dragRefId, setDragRefId] = useState<string | null>(null)
  const [hoverSide, setHoverSide] = useState<"left" | "right" | null>(null)

  const startDrag = (refId: string) => (e: ReactPointerEvent) => {
    e.stopPropagation()
    setDragRefId(refId)
  }

  const onContainerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRefId) {
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = e.clientX - rect.left
    setHoverSide(relX < rect.width / 2 ? "left" : "right")
  }

  const onContainerPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRefId) {
      return
    }
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const dropSide: "left" | "right" = relX < rect.width / 2 ? "left" : "right"
    setRefAssigns((prev) => ({ ...prev, [dragRefId]: dropSide }))
    setDragRefId(null)
    setHoverSide(null)
  }

  const leftRefs = refs.filter((r) => refAssigns[r.id] === "left")
  const rightRefs = refs.filter((r) => refAssigns[r.id] === "right")

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Drag individual {kind}s between Left and Right collections.
      </Text>

      <Group
        gap={12}
        align="stretch"
        style={{ minHeight: 200 }}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
      >
        {/* Left zone */}
        <Box
          style={{
            flex: 1,
            background:
              hoverSide === "left"
                ? "var(--mantine-color-teal-0)"
                : "var(--mantine-color-gray-0)",
            borderRadius: 6,
            padding: 8,
            border:
              hoverSide === "left"
                ? "2px dashed var(--mantine-color-teal-5)"
                : "2px dashed var(--mantine-color-gray-3)",
            transition: "background 100ms, border 100ms",
          }}
        >
          <Text size="xs" fw={600} c="teal" mb={6}>
            Left ({leftRefs.length})
          </Text>
          <Stack gap={4}>
            {leftRefs.map((ref) => (
              <Paper
                key={ref.id}
                withBorder
                p={4}
                style={{
                  cursor: "grab",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: dragRefId === ref.id ? 0.5 : 1,
                }}
                onPointerDown={startDrag(ref.id)}
              >
                <Icon size={14} color={`var(--mantine-color-${color}-6)`} />
                <Text size="xs" lineClamp={1}>
                  {getRefName(ref)}
                </Text>
              </Paper>
            ))}
          </Stack>
        </Box>

        {/* Right zone */}
        <Box
          style={{
            flex: 1,
            background:
              hoverSide === "right"
                ? "var(--mantine-color-blue-0)"
                : "var(--mantine-color-gray-0)",
            borderRadius: 6,
            padding: 8,
            border:
              hoverSide === "right"
                ? "2px dashed var(--mantine-color-blue-5)"
                : "2px dashed var(--mantine-color-gray-3)",
            transition: "background 100ms, border 100ms",
          }}
        >
          <Text size="xs" fw={600} c="blue" mb={6}>
            Right ({rightRefs.length})
          </Text>
          <Stack gap={4}>
            {rightRefs.map((ref) => (
              <Paper
                key={ref.id}
                withBorder
                p={4}
                style={{
                  cursor: "grab",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: dragRefId === ref.id ? 0.5 : 1,
                }}
                onPointerDown={startDrag(ref.id)}
              >
                <Icon size={14} color={`var(--mantine-color-${color}-6)`} />
                <Text size="xs" lineClamp={1}>
                  {getRefName(ref)}
                </Text>
              </Paper>
            ))}
          </Stack>
        </Box>
      </Group>

      <Group justify="flex-end" gap="sm">
        <Button size="xs" variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          leftSection={<IconCheck size={14} />}
          onClick={() => onConfirm(refAssigns)}
        >
          Apply
        </Button>
      </Group>
    </Stack>
  )
}

function DivisionOverlay({
  collection,
  onCancel,
  onConfirm,
}: {
  collection: CanvasCollectionElement
  onCancel: () => void
  onConfirm: (
    leftRefs: CollectionRef[],
    rightRefs: CollectionRef[],
    leftName: string,
    rightName: string,
  ) => void
}) {
  // Group refs by kind for display
  const refsByKind = collection.refs.reduce<Record<string, CollectionRef[]>>(
    (acc, r) => {
      if (!acc[r.kind]) acc[r.kind] = []
      acc[r.kind].push(r)
      return acc
    },
    {},
  )
  const kinds = Object.keys(refsByKind) as CollectionRef["kind"][]

  // Track which side each kind is assigned to (initially all on left)
  // 'center' means the kind has been split via detailed division
  const [assignments, setAssignments] = useState<Record<string, DivisionSide>>(
    () => Object.fromEntries(kinds.map((k) => [k, "left" as DivisionSide])),
  )

  // Track detailed per-ref assignments for kinds that are in 'center' (split)
  // Key is ref.id, value is 'left' | 'right'
  const [detailedAssignments, setDetailedAssignments] = useState<
    Record<string, "left" | "right">
  >(() =>
    Object.fromEntries(collection.refs.map((r) => [r.id, "left" as const])),
  )

  const [leftName, setLeftName] = useState(`${collection.name} A`)
  const [rightName, setRightName] = useState(`${collection.name} B`)
  const [dragKind, setDragKind] = useState<CollectionRef["kind"] | null>(null)
  const [hoverSide, setHoverSide] = useState<DivisionSide | null>(null)
  const [detailedKind, setDetailedKind] = useState<
    CollectionRef["kind"] | null
  >(null)
  const dragStartX = useRef(0)

  const startDrag = (kind: CollectionRef["kind"]) => (e: ReactPointerEvent) => {
    e.stopPropagation()
    dragStartX.current = e.clientX
    setDragKind(kind)
  }

  const onContainerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragKind) {
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const containerWidth = rect.width
    const thirdWidth = containerWidth / 3

    if (relX < thirdWidth) {
      setHoverSide("left")
    } else if (relX < 2 * thirdWidth) {
      setHoverSide("center")
    } else {
      setHoverSide("right")
    }
  }

  const onContainerPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragKind) {
      return
    }
    e.stopPropagation()

    const rect = e.currentTarget.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const containerWidth = rect.width
    const thirdWidth = containerWidth / 3

    let dropSide: DivisionSide = "left"
    if (relX < thirdWidth) {
      dropSide = "left"
    } else if (relX < 2 * thirdWidth) {
      dropSide = "center"
    } else {
      dropSide = "right"
    }

    if (dropSide === "center") {
      // Open detailed division dialog for this kind
      setDetailedKind(dragKind)
    } else {
      // All refs of this kind go to the same side
      setAssignments((prev) => ({ ...prev, [dragKind]: dropSide }))
      // Update detailed assignments for consistency
      const kindsRefs = refsByKind[dragKind] || []
      setDetailedAssignments((prev) => {
        const updated = { ...prev }
        for (const ref of kindsRefs) {
          updated[ref.id] = dropSide
        }
        return updated
      })
    }

    setDragKind(null)
    setHoverSide(null)
  }

  const handleDetailedConfirm = (
    kind: CollectionRef["kind"],
    assigns: Record<string, "left" | "right">,
  ) => {
    // Merge new assignments
    setDetailedAssignments((prev) => ({ ...prev, ...assigns }))
    // Mark the kind as 'center' (split)
    setAssignments((prev) => ({ ...prev, [kind]: "center" }))
    setDetailedKind(null)
  }

  const handleDetailedCancel = () => {
    setDetailedKind(null)
  }

  const openDetailedDialog = (kind: CollectionRef["kind"]) => {
    setDetailedKind(kind)
  }

  const handleConfirm = () => {
    const leftRefs: CollectionRef[] = []
    const rightRefs: CollectionRef[] = []

    for (const kind of kinds) {
      const refs = refsByKind[kind]
      if (assignments[kind] === "left") {
        leftRefs.push(...refs)
      } else if (assignments[kind] === "right") {
        rightRefs.push(...refs)
      } else {
        // 'center' means split - use detailed assignments
        for (const ref of refs) {
          if (detailedAssignments[ref.id] === "left") {
            leftRefs.push(ref)
          } else {
            rightRefs.push(ref)
          }
        }
      }
    }

    onConfirm(
      leftRefs,
      rightRefs,
      leftName.trim() || collection.name,
      rightName.trim() || collection.name,
    )
  }

  // Calculate split counts for kinds in center
  const getSplitCounts = (kind: CollectionRef["kind"]) => {
    const refs = refsByKind[kind] || []
    let left = 0,
      right = 0
    for (const ref of refs) {
      if (detailedAssignments[ref.id] === "left") {
        left++
      } else {
        right++
      }
    }
    return { left, right }
  }

  const OVERLAY_H = 280

  // If detailed modal is open, show it
  if (detailedKind) {
    const refsForKind = refsByKind[detailedKind] || []
    // Get current assignments for these refs
    const currentAssigns = Object.fromEntries(
      refsForKind.map((r) => [r.id, detailedAssignments[r.id] || "left"]),
    ) as Record<string, "left" | "right">

    return (
      <Modal
        opened
        onClose={handleDetailedCancel}
        title={`Divide ${detailedKind}s`}
        size="lg"
        centered
      >
        <DetailedDivisionModal
          kind={detailedKind}
          refs={refsForKind}
          initialAssignments={currentAssigns}
          onConfirm={(assigns) => handleDetailedConfirm(detailedKind, assigns)}
          onCancel={handleDetailedCancel}
        />
      </Modal>
    )
  }

  return (
    <Modal
      opened
      onClose={onCancel}
      title={`Divide "${collection.name}"`}
      size="lg"
      centered
    >
      {/* Main division area */}
      <Group
        gap={0}
        align="stretch"
        style={{ minHeight: OVERLAY_H - 100 }}
        onPointerMove={onContainerPointerMove}
        onPointerUp={onContainerPointerUp}
      >
        {/* Left side */}
        <Box
          style={{
            flex: 1,
            background:
              hoverSide === "left"
                ? "var(--mantine-color-teal-0)"
                : "var(--mantine-color-gray-0)",
            borderRadius: 6,
            padding: 8,
            border:
              hoverSide === "left"
                ? "2px dashed var(--mantine-color-teal-5)"
                : "2px dashed transparent",
            transition: "background 100ms, border 100ms",
          }}
        >
          <TextInput
            size="xs"
            placeholder="Left name"
            value={leftName}
            onChange={(e) => setLeftName(e.currentTarget.value)}
            mb={6}
          />
          <Stack gap={4}>
            {kinds
              .filter((k) => assignments[k] === "left")
              .map((k) => {
                const { Icon, color } = REF_ICONS[k]
                return (
                  <Paper
                    key={k}
                    withBorder
                    p={4}
                    style={{
                      cursor: "grab",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      opacity: dragKind === k ? 0.5 : 1,
                    }}
                    onPointerDown={startDrag(k)}
                  >
                    <Icon size={14} color={`var(--mantine-color-${color}-6)`} />
                    <Text size="xs" tt="capitalize">
                      {k}s ({refsByKind[k].length})
                    </Text>
                  </Paper>
                )
              })}
          </Stack>
        </Box>

        {/* Center divide zone */}
        <Box
          style={{
            width: 100,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: kinds.some((k) => assignments[k] === "center")
              ? "flex-start"
              : "center",
            background:
              hoverSide === "center"
                ? "var(--mantine-color-violet-1)"
                : "transparent",
            borderRadius: 6,
            border:
              hoverSide === "center"
                ? "2px dashed var(--mantine-color-violet-5)"
                : "2px dashed var(--mantine-color-gray-3)",
            margin: "0 6px",
            padding: 6,
            transition: "background 100ms, border 100ms",
          }}
        >
          {/* Show split items */}
          {kinds.some((k) => assignments[k] === "center") ? (
            <Stack gap={4} w="100%">
              {kinds
                .filter((k) => assignments[k] === "center")
                .map((k) => {
                  const { Icon, color } = REF_ICONS[k]
                  const { left, right } = getSplitCounts(k)
                  return (
                    <Paper
                      key={k}
                      withBorder
                      p={4}
                      style={{
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        gap: 2,
                        background: "var(--mantine-color-violet-0)",
                      }}
                      onClick={() => openDetailedDialog(k)}
                      title="Click to edit division"
                    >
                      <Icon
                        size={14}
                        color={`var(--mantine-color-${color}-6)`}
                      />
                      <Text size="xs" tt="capitalize" ta="center" lh={1.1}>
                        {k}s
                      </Text>
                      <Text size="10px" c="dimmed" ta="center" lh={1}>
                        {left}← / →{right}
                      </Text>
                    </Paper>
                  )
                })}
            </Stack>
          ) : (
            <>
              <IconSeparatorVertical
                size={20}
                color="var(--mantine-color-gray-5)"
              />
              <Text size="xs" c="dimmed" ta="center" mt={4}>
                Divide
              </Text>
            </>
          )}
        </Box>

        {/* Right side */}
        <Box
          style={{
            flex: 1,
            background:
              hoverSide === "right"
                ? "var(--mantine-color-blue-0)"
                : "var(--mantine-color-gray-0)",
            borderRadius: 6,
            padding: 8,
            border:
              hoverSide === "right"
                ? "2px dashed var(--mantine-color-blue-5)"
                : "2px dashed transparent",
            transition: "background 100ms, border 100ms",
          }}
        >
          <TextInput
            size="xs"
            placeholder="Right name"
            value={rightName}
            onChange={(e) => setRightName(e.currentTarget.value)}
            mb={6}
          />
          <Stack gap={4}>
            {kinds
              .filter((k) => assignments[k] === "right")
              .map((k) => {
                const { Icon, color } = REF_ICONS[k]
                return (
                  <Paper
                    key={k}
                    withBorder
                    p={4}
                    style={{
                      cursor: "grab",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      opacity: dragKind === k ? 0.5 : 1,
                    }}
                    onPointerDown={startDrag(k)}
                  >
                    <Icon size={14} color={`var(--mantine-color-${color}-6)`} />
                    <Text size="xs" tt="capitalize">
                      {k}s ({refsByKind[k].length})
                    </Text>
                  </Paper>
                )
              })}
          </Stack>
        </Box>
      </Group>

      {/* Action buttons */}
      <Group justify="flex-end" gap="sm" mt="sm">
        <Button size="xs" variant="default" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          leftSection={<IconCheck size={14} />}
          onClick={handleConfirm}
        >
          Confirm
        </Button>
      </Group>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Infinite-scroll canvas for one Plane
// ─────────────────────────────────────────────────────────────────────────────

function PlaneCanvas({ plane }: { plane: Plane }) {
  const {
    experiments,
    setExperiments,
    processes,
    setProcesses,
    results,
    setResults,
    updateElement,
    deleteElement,
    addTextElement,
    addPlainTextElement,
    updatePlane,
    setActiveCollectionId,
    activeCollectionId,
    planes,
    copyElementToPlane,
    moveElementToPlane,
    uploadFlow,
  } = useAppContext()
  const startOrAddUpload = useStartOrAddUpload()

  const obLevel = useOnboardingLevel()
  const isFirstPlane = planes[0]?.id === plane.id
  const colorScheme = useComputedColorScheme("light")
  const isDark = colorScheme === "dark"

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 })
  const panRef = useRef<Vec2>({ x: 0, y: 0 })
  panRef.current = pan
  const panStart = useRef<{ mouse: Vec2; origin: Vec2 } | null>(null)
  const [containerHeight, setContainerHeight] = useState(0)
  const [containerWidth, setContainerWidth] = useState(0)
  const containerHeightRef = useRef(0)
  containerHeightRef.current = containerHeight

  // OneNote-style expandable vertical canvas
  const SECTION_HEIGHT = 800
  const MIN_SECTIONS = 5 // 5 × 800 = 4000px minimum
  const [canvasSections, setCanvasSections] = useState(MIN_SECTIONS)
  const canvasHeight = canvasSections * SECTION_HEIGHT
  // Mutable ref so the wheel listener can read the current value without deps
  const maxPanYRef = useRef(0)
  maxPanYRef.current = Math.max(0, canvasHeight - containerHeight)

  // Vertical scrollbar geometry (derived from pan.y + containerHeight)
  const thumbH =
    containerHeight > 0
      ? Math.max(30, (containerHeight * containerHeight) / canvasHeight)
      : 0
  const thumbTrack = Math.max(0, containerHeight - thumbH)
  const thumbTop =
    maxPanYRef.current > 0 ? (-pan.y / maxPanYRef.current) * thumbTrack : 0

  const [activeDrawId, setActiveDrawId] = useState<string | null>(null)
  const [dragOverCellKey, setDragOverCellKey] = useState<string | null>(null)
  const [draggingCollectionId, setDraggingCollectionId] = useState<
    string | null
  >(null)
  const plaintextEditingRef = useRef(false)

  // ── Track color scheme changes to auto-invert plain text colors ─────────
  const prevSchemeRef = useRef(colorScheme)
  useEffect(() => {
    if (prevSchemeRef.current === colorScheme) return
    const nowDark = colorScheme === "dark"
    prevSchemeRef.current = colorScheme
    // Invert existing plain text element colors (black ↔ white only)
    const updated = plane.elements.map((el) => {
      if (el.type !== "plaintext") return el
      const ptel = el as CanvasPlainTextElement
      if (nowDark && ptel.color === "#000000")
        return { ...ptel, color: "#ffffff" }
      if (!nowDark && ptel.color === "#ffffff")
        return { ...ptel, color: "#000000" }
      return el
    })
    if (updated.some((el, i) => el !== plane.elements[i])) {
      updatePlane({ ...plane, elements: updated })
    }
  }, [colorScheme, plane, updatePlane]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pick next free collection color (hue-rotation) ─────────────────────
  const nextCollectionColor = (): string => {
    const usedColors = new Set(
      (
        plane.elements.filter(
          (e) => e.type === "collection",
        ) as CanvasCollectionElement[]
      ).map((c) => c.color),
    )
    const free = PALETTE.find((c) => !usedColors.has(c))
    if (free) return free
    // All used – pick the one used least (wrap around cycle)
    const counts = new Map(PALETTE.map((c) => [c, 0]))
    for (const el of plane.elements) {
      if (el.type === "collection") {
        const col = el as CanvasCollectionElement
        if (col.color && counts.has(col.color))
          counts.set(col.color, (counts.get(col.color) ?? 0) + 1)
      }
    }
    let minColor = PALETTE[0]
    let minCount = Infinity
    for (const [c, count] of counts) {
      if (count < minCount) {
        minCount = count
        minColor = c
      }
    }
    return minColor
  }

  // ── Transfer-to-plane dialog state ──────────────────────────────────────
  const [transferDialog, setTransferDialog] = useState<{
    element: CanvasCollectionElement
    targetPlaneId: string
  } | null>(null)

  const handleDropRefs = useCallback(
    (
      targetCollectionId: string,
      payload: CollectionRefDragPayload,
      isCopy: boolean,
    ) => {
      if (targetCollectionId === payload.sourceCollectionId) {
        return
      }
      const source = plane.elements.find(
        (e) => e.id === payload.sourceCollectionId && e.type === "collection",
      ) as CanvasCollectionElement | undefined
      const target = plane.elements.find(
        (e) => e.id === targetCollectionId && e.type === "collection",
      ) as CanvasCollectionElement | undefined
      if (!source || !target) {
        return
      }

      const idSet = new Set(payload.refIds)
      const shouldMove = (r: CollectionRef) =>
        r.kind === payload.kind && idSet.has(r.id)

      const moving = source.refs.filter(shouldMove)
      if (moving.length === 0) {
        return
      }

      if (isCopy) {
        // COPY: Create deep copies of the actual entities with new IDs
        const newRefs: CollectionRef[] = []

        for (const ref of moving) {
          if (ref.kind === "experiment") {
            const original = experiments.find((e) => e.id === ref.id)
            if (original) {
              const copied: Experiment = {
                ...original,
                id: crypto.randomUUID(),
                substrates: original.substrates.map((substrate) => ({
                  ...substrate,
                  id: crypto.randomUUID(),
                  parameterValues: { ...(substrate.parameterValues ?? {}) },
                })),
                processingTimes: { ...(original.processingTimes ?? {}) },
                hasResults: false,
              }
              setExperiments((prev) => [...prev, copied])
              newRefs.push({ kind: "experiment", id: copied.id })
            }
          } else if (ref.kind === "process") {
            const original = processes.find((p) => p.id === ref.id)
            if (original) {
              const copied: Process = {
                ...original,
                id: crypto.randomUUID(),
                stages: original.stages.map((stage) => ({
                  ...stage,
                  alternatives: stage.alternatives.map((step) => ({
                    ...step,
                    id: crypto.randomUUID(),
                  })),
                })),
              }
              setProcesses((prev) => [...prev, copied])
              newRefs.push({ kind: "process", id: copied.id })
            }
          } else if (ref.kind === "result") {
            const original = results.find((r) => r.id === ref.id)
            if (original) {
              const copied: ExperimentResults = {
                ...original,
                id: crypto.randomUUID(),
                files: original.files.map((f) => ({
                  ...f,
                  id: crypto.randomUUID(),
                })),
                deviceGroups: original.deviceGroups.map((g) => ({
                  ...g,
                  id: crypto.randomUUID(),
                })),
                updatedAt: new Date().toISOString(),
              }
              setResults((prev) => [...prev, copied])
              newRefs.push({ kind: "result", id: copied.id })
            }
          }
          // Note: 'analysis' entities don't exist yet in the data model
        }

        // Add new copied entities to target collection
        const nextTargetRefs = [...target.refs, ...newRefs]
        updatePlane({
          ...plane,
          elements: plane.elements.map((e) => {
            if (e.id === target.id && e.type === "collection") {
              return { ...e, refs: nextTargetRefs }
            }
            return e
          }),
        })
      } else {
        // MOVE: Check for dependencies first
        const allDependents: DependencyLocation[] = []
        const dependentRefIds = new Set<string>()

        for (const ref of moving) {
          if (ref.kind === "process") {
            const deps = getDependentLocations(ref.kind, ref.id, {
              experiments,
              processes,
              planes,
            })
            allDependents.push(...deps)
            for (const dep of deps) {
              dependentRefIds.add(dep.itemId)
            }
          }
        }

        if (allDependents.length > 0) {
          // Show modal asking whether to move with dependents or cancel
          const entityNames = moving
            .map((r) => {
              if (r.kind === "experiment") {
                return experiments.find((e) => e.id === r.id)?.name || r.id
              }
              if (r.kind === "process") {
                return processes.find((p) => p.id === r.id)?.name || r.id
              }
              return r.id
            })
            .join(", ")

          modals.openConfirmModal({
            title: "Move with dependencies?",
            size: "lg",
            children: (
              <>
                <Text size="sm" mb="md">
                  The following items have dependencies that reference them:
                </Text>
                <Text size="sm" fw={600} mb="xs">
                  {entityNames}
                </Text>
                <Table withTableBorder withColumnBorders mb="md">
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Plane</Table.Th>
                      <Table.Th>Collection</Table.Th>
                      <Table.Th>Item</Table.Th>
                      <Table.Th>Type</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {allDependents.map((dep, idx) => (
                      <Table.Tr key={`${dep.itemId}-${idx}`}>
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
                <Text size="sm">
                  Do you want to move these items along with all their
                  dependencies?
                </Text>
              </>
            ),
            labels: { confirm: "Move with dependencies", cancel: "Cancel" },
            confirmProps: { color: "blue" },
            onConfirm: () => {
              // Move the original refs AND their dependents
              const refsToMove = new Set<string>()
              for (const ref of moving) {
                refsToMove.add(`${ref.kind}:${ref.id}`)
              }
              for (const depId of dependentRefIds) {
                // Find the dependent's kind from allDependents
                const dep = allDependents.find((d) => d.itemId === depId)
                if (dep) {
                  refsToMove.add(`${dep.itemKind}:${depId}`)
                }
              }

              const nextSourceRefs = source.refs.filter(
                (r) => !refsToMove.has(`${r.kind}:${r.id}`),
              )
              const nextTargetRefs = [...target.refs]

              for (const ref of source.refs) {
                if (refsToMove.has(`${ref.kind}:${ref.id}`)) {
                  if (
                    !nextTargetRefs.some(
                      (x) => x.kind === ref.kind && x.id === ref.id,
                    )
                  ) {
                    nextTargetRefs.push(ref)
                  }
                }
              }

              updatePlane({
                ...plane,
                elements: plane.elements
                  .filter(
                    (e) => !(e.id === source.id && nextSourceRefs.length === 0),
                  )
                  .map((e) => {
                    if (e.id === source.id && e.type === "collection") {
                      return { ...e, refs: nextSourceRefs }
                    }
                    if (e.id === target.id && e.type === "collection") {
                      return { ...e, refs: nextTargetRefs }
                    }
                    return e
                  }),
              })
            },
          })
        } else {
          // No dependencies, move directly
          const nextSourceRefs = source.refs.filter((r) => !shouldMove(r))
          const nextTargetRefs = [...target.refs]
          for (const r of moving) {
            if (
              !nextTargetRefs.some((x) => x.kind === r.kind && x.id === r.id)
            ) {
              nextTargetRefs.push(r)
            }
          }

          updatePlane({
            ...plane,
            elements: plane.elements
              .filter(
                (e) => !(e.id === source.id && nextSourceRefs.length === 0),
              )
              .map((e) => {
                if (e.id === source.id && e.type === "collection") {
                  return { ...e, refs: nextSourceRefs }
                }
                if (e.id === target.id && e.type === "collection") {
                  return { ...e, refs: nextTargetRefs }
                }
                return e
              }),
          })
        }
      }
    },
    [
      plane,
      updatePlane,
      experiments,
      setExperiments,
      processes,
      setProcesses,
      results,
      setResults,
      planes,
    ],
  )

  // ── Canvas-level drop handler: routes drops to the correct cell ──────────────
  // Files dropped directly onto the canvas start (or are refused by) an upload
  // flow. Opens the Process → Experiment picker so the user maps the files.
  const handleFileDrop = (
    fileList: FileList,
    dropCell: { col: number; row: number } | null,
  ) => {
    const files = Array.from(fileList)
    if (files.length === 0) {
      return
    }

    // An unfinished upload is always associated with a collection. Reuse the
    // collection under the cursor, or create an empty one at that cell so the
    // pending marker has a home ("empty collection with just this symbol").
    // Only materialize a new collection when starting a *fresh* flow — an
    // add-to-zip / different-target drop shouldn't spawn stray collections.
    let targetCollectionId: string | null = null
    if (!uploadFlow && dropCell && dropCell.col >= 0 && dropCell.row >= 0) {
      const { col, row } = dropCell
      const existing = plane.elements.find((e) => {
        if (e.type !== "collection") return false
        const c = e as CanvasCollectionElement
        return (
          Math.round(c.position.x / CELL_W) === col &&
          Math.round(c.position.y / CELL_H) === row
        )
      }) as CanvasCollectionElement | undefined
      if (existing) {
        targetCollectionId = existing.id
      } else {
        const newEl: CanvasCollectionElement = {
          id: crypto.randomUUID(),
          type: "collection",
          position: { x: col * CELL_W, y: row * CELL_H },
          size: { x: CELL_W, y: CELL_H },
          name: "Data Collection",
          color: nextCollectionColor(),
          refs: [],
        }
        updatePlane({ ...plane, elements: [...plane.elements, newEl] })
        targetCollectionId = newEl.id
      }
    } else if (uploadFlow && dropCell) {
      // Resolve the collection under the cursor (if any) so the shared hook can
      // tell same-target (add-to-zip) from different-target (warn).
      const { col, row } = dropCell
      const existing = plane.elements.find((e) => {
        if (e.type !== "collection") return false
        const c = e as CanvasCollectionElement
        return (
          Math.round(c.position.x / CELL_W) === col &&
          Math.round(c.position.y / CELL_H) === row
        )
      }) as CanvasCollectionElement | undefined
      targetCollectionId = existing?.id ?? null
    }

    startOrAddUpload(files, {
      collectionId: targetCollectionId,
      planeId: plane.id,
    })
  }

  const handleDropToCell = (
    col: number,
    row: number,
    payload: CollectionRefDragPayload,
  ) => {
    // Don't drop onto cells covered by text/note elements (including multi-cell spans)
    const textOccupied = plane.elements.some((e) => {
      if (e.type !== "text" && e.type !== "plaintext") return false
      const elCol = Math.round(e.position.x / CELL_W)
      const elRow = Math.round(e.position.y / CELL_H)
      const spanCols = Math.max(1, Math.round(e.size.x / CELL_W))
      const spanRows = Math.max(1, Math.round(e.size.y / CELL_H))
      return (
        col >= elCol &&
        col < elCol + spanCols &&
        row >= elRow &&
        row < elRow + spanRows
      )
    })
    if (textOccupied) return

    const cellX = col * CELL_W
    const cellY = row * CELL_H

    const source = plane.elements.find(
      (e) => e.id === payload.sourceCollectionId && e.type === "collection",
    ) as CanvasCollectionElement | undefined
    if (!source) return

    const idSet = new Set(payload.refIds)
    const refsToMove = source.refs.filter(
      (r) => r.kind === payload.kind && idSet.has(r.id),
    )
    if (refsToMove.length === 0) return

    const existing = plane.elements.find((e) => {
      if (e.type !== "collection") return false
      const c = e as CanvasCollectionElement
      return (
        Math.round(c.position.x / CELL_W) === col &&
        Math.round(c.position.y / CELL_H) === row
      )
    }) as CanvasCollectionElement | undefined

    if (existing?.id === payload.sourceCollectionId) return // drop on self

    if (existing) {
      // Reuse existing logic (handles dependency checks and modals)
      handleDropRefs(existing.id, payload, false)
    } else {
      // Create a new collection at this empty cell, pre-populated with the dropped refs
      const nextSourceRefs = source.refs.filter(
        (r) => !(r.kind === payload.kind && idSet.has(r.id)),
      )
      const color = nextCollectionColor()
      const newEl: CanvasCollectionElement = {
        id: crypto.randomUUID(),
        type: "collection",
        position: { x: cellX, y: cellY },
        size: { x: CELL_W, y: CELL_H },
        name: "Data Collection",
        color,
        refs: refsToMove,
      }
      const baseElements =
        nextSourceRefs.length === 0
          ? plane.elements.filter((e) => e.id !== source.id)
          : plane.elements.map((e) => {
              if (e.id === source.id) return { ...e, refs: nextSourceRefs }
              return e
            })
      updatePlane({ ...plane, elements: [...baseElements, newEl] })
      setActiveCollectionId(newEl.id)
    }
  }

  const handleMoveCollection = (
    collectionId: string,
    col: number,
    row: number,
  ) => {
    // Don't drop on cells covered by text/note elements (including multi-cell spans)
    const textOccupied = plane.elements.some((e) => {
      if (e.type !== "text" && e.type !== "plaintext") return false
      const elCol = Math.round(e.position.x / CELL_W)
      const elRow = Math.round(e.position.y / CELL_H)
      const spanCols = Math.max(1, Math.round(e.size.x / CELL_W))
      const spanRows = Math.max(1, Math.round(e.size.y / CELL_H))
      return (
        col >= elCol &&
        col < elCol + spanCols &&
        row >= elRow &&
        row < elRow + spanRows
      )
    })
    if (textOccupied) return

    const source = plane.elements.find(
      (e) => e.id === collectionId && e.type === "collection",
    ) as CanvasCollectionElement | undefined
    if (!source) return

    const sourceCol = Math.round(source.position.x / CELL_W)
    const sourceRow = Math.round(source.position.y / CELL_H)
    if (sourceCol === col && sourceRow === row) return // same cell

    const cellX = col * CELL_W
    const cellY = row * CELL_H

    const target = plane.elements.find((e) => {
      if (e.type !== "collection" || e.id === collectionId) return false
      const c = e as CanvasCollectionElement
      return (
        Math.round(c.position.x / CELL_W) === col &&
        Math.round(c.position.y / CELL_H) === row
      )
    }) as CanvasCollectionElement | undefined

    if (target) {
      // Merge: move all refs from source into target, remove source
      updatePlane({
        ...plane,
        elements: plane.elements
          .filter((e) => e.id !== collectionId)
          .map((e) => {
            if (e.id !== target.id) return e
            const merged = target as CanvasCollectionElement
            return { ...merged, refs: [...merged.refs, ...source.refs] }
          }),
      })
      setActiveCollectionId(target.id)
    } else {
      // Move to empty cell
      updatePlane({
        ...plane,
        elements: plane.elements.map((e) => {
          if (e.id !== collectionId) return e
          return { ...e, position: { x: cellX, y: cellY } }
        }),
      })
    }
  }

  const handleCreateNote = (cellX: number, cellY: number) => {
    const el = addTextElement(plane.id, { x: cellX, y: cellY })
    updateElement(plane.id, { ...el, size: { x: CELL_W, y: CELL_H } })
  }

  const handleCreateText = (cellX: number, cellY: number) => {
    if (plaintextEditingRef.current) return
    plaintextEditingRef.current = true
    const newEl = addPlainTextElement(
      plane.id,
      { x: cellX, y: cellY },
      "#000000",
      {
        bold: false,
        italic: false,
        underline: false,
      },
    )
    updateElement(plane.id, { ...newEl, size: { x: CELL_W, y: CELL_H } })
  }

  // ── Collection division state ────────────────────────────────────────────────────────
  const [dividingCollection, setDividingCollection] =
    useState<CanvasCollectionElement | null>(null)

  const handleStartDivide = (collection: CanvasCollectionElement) => {
    setDividingCollection(collection)
    setActiveCollectionId(null) // Deselect to hide action bubbles
  }

  const handleCancelDivide = () => {
    setDividingCollection(null)
  }

  const handleConfirmDivide = (
    leftRefs: CollectionRef[],
    rightRefs: CollectionRef[],
    leftName: string,
    rightName: string,
  ) => {
    if (!dividingCollection) {
      return
    }
    const original = dividingCollection
    // Place divided collections in adjacent grid cells
    const leftPos = snapToCell(
      Math.max(0, original.position.x - CELL_W),
      original.position.y,
    )
    const rightPos = snapToCell(
      original.position.x + CELL_W,
      original.position.y,
    )
    // Create left collection
    const leftCol: CanvasCollectionElement = {
      id: crypto.randomUUID(),
      type: "collection",
      position: leftPos,
      size: original.size,
      name: leftName,
      color: original.color,
      refs: leftRefs,
    }
    // Create right collection
    const rightCol: CanvasCollectionElement = {
      id: crypto.randomUUID(),
      type: "collection",
      position: rightPos,
      size: original.size,
      name: rightName,
      color: original.color,
      refs: rightRefs,
    }
    // Delete original, add two new
    deleteElement(plane.id, original.id)
    // Use updatePlane to batch add both
    const newElements = plane.elements.filter((e) => e.id !== original.id)
    newElements.push(leftCol, rightCol)
    updatePlane({ ...plane, elements: newElements })
    setDividingCollection(null)
  }

  // Auto-cleanup: remove empty collections when the user clicks away
  const prevActiveIdRef = useRef<string | null>(null)
  useEffect(() => {
    const prevId = prevActiveIdRef.current
    prevActiveIdRef.current = activeCollectionId
    if (prevId && prevId !== activeCollectionId) {
      const prevEl = plane.elements.find(
        (e) => e.id === prevId && e.type === "collection",
      ) as CanvasCollectionElement | undefined
      if (prevEl && prevEl.refs.length === 0) {
        deleteElement(plane.id, prevId)
      }
    }
  }, [activeCollectionId, plane.elements, plane.id, deleteElement])

  // ── X-axis overflow scrolling (backup for elements beyond viewport) ─────────
  // Compute the rightmost canvas coordinate of all elements
  const rightmostX = plane.elements.reduce((acc, el) => {
    if (el.type === "line") {
      const line = el as CanvasLineElement
      return Math.max(acc, ...line.points.map((p) => p.x))
    }
    const sized = el as { position: Vec2; size?: Vec2 }
    return Math.max(acc, sized.position.x + (sized.size?.x ?? 160))
  }, 0)
  const maxPanX = Math.max(0, rightmostX + 40 - containerWidth)
  const maxPanXRef = useRef(0)
  maxPanXRef.current = maxPanX

  // Horizontal scrollbar geometry (only visible when maxPanX > 0)
  const xThumbW =
    containerWidth > 0 && maxPanX > 0
      ? Math.max(
          30,
          (containerWidth * containerWidth) / (containerWidth + maxPanX),
        )
      : 0
  const xThumbTrack = Math.max(0, containerWidth - xThumbW)
  const xThumbLeft = maxPanX > 0 ? (-pan.x / maxPanX) * xThumbTrack : 0

  // ── Panning (middle-mouse or space+drag) ────────────────────────────────────
  const isPanning = useRef(false)
  const spaceDown = useRef(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = e.type === "keydown"
      }
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("keyup", onKey)
    }
  }, [])

  // ── Measure container size for scrollbars ──────────────────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    const ro = new ResizeObserver(() => {
      setContainerHeight(el.clientHeight)
      setContainerWidth(el.clientWidth)
    })
    ro.observe(el)
    setContainerHeight(el.clientHeight)
    setContainerWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // ── Mouse-wheel scrolling (x + y) + bottom expansion ──────────────────────
  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const current = panRef.current
      const newY = Math.min(
        0,
        Math.max(-maxPanYRef.current, current.y - e.deltaY),
      )
      const newX = Math.min(
        0,
        Math.max(-maxPanXRef.current, current.x - e.deltaX),
      )
      setPan({ x: newX, y: newY })
      // Expand canvas when scrolling within one section of the bottom
      if (e.deltaY > 0 && newY <= -(maxPanYRef.current - SECTION_HEIGHT)) {
        setCanvasSections((s) => s + 1)
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-trim canvas sections when scrolling back up ────────────────────────
  useEffect(() => {
    if (canvasSections <= MIN_SECTIONS) return
    const lastSectionStart = (canvasSections - 1) * SECTION_HEIGHT
    const visibleBottom = -pan.y + containerHeight
    // Only trim when the view doesn't reach the last section
    if (visibleBottom < lastSectionStart) {
      const hasElementInLastSection = plane.elements.some((el) => {
        if (el.type === "line") {
          const line = el as CanvasLineElement
          return line.points.some((p) => p.y >= lastSectionStart)
        }
        const positioned = el as { position: Vec2 }
        return positioned.position.y >= lastSectionStart
      })
      if (!hasElementInLastSection) {
        setCanvasSections((s) => Math.max(MIN_SECTIONS, s - 1))
      }
    }
  }, [pan.y, plane.elements, canvasSections, containerHeight]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Clamp pan.x when maxPanX decreases (elements moved back into view) ─────
  useEffect(() => {
    if (pan.x < -maxPanX) {
      setPan((prev) => ({ ...prev, x: Math.max(-maxPanX, prev.x) }))
    }
  }, [maxPanX, pan.x]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Custom vertical scrollbar thumb drag ───────────────────────────────────
  const thumbDragStart = useRef<{ mouseY: number; panY: number } | null>(null)

  const onThumbPointerDown = (e: ReactPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    thumbDragStart.current = { mouseY: e.clientY, panY: pan.y }
  }
  const onThumbPointerMove = (e: ReactPointerEvent) => {
    if (!thumbDragStart.current) {
      return
    }
    e.stopPropagation()
    const dy = e.clientY - thumbDragStart.current.mouseY
    const newY =
      thumbTrack > 0
        ? thumbDragStart.current.panY - (dy / thumbTrack) * maxPanYRef.current
        : 0
    setPan((prev) => ({
      ...prev,
      y: Math.min(0, Math.max(-maxPanYRef.current, newY)),
    }))
  }
  const onThumbPointerUp = (e: ReactPointerEvent) => {
    e.stopPropagation()
    thumbDragStart.current = null
  }

  // ── Custom horizontal scrollbar thumb drag ─────────────────────────────────
  const xThumbDragStart = useRef<{ mouseX: number; panX: number } | null>(null)

  const onXThumbPointerDown = (e: ReactPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    xThumbDragStart.current = { mouseX: e.clientX, panX: pan.x }
  }
  const onXThumbPointerMove = (e: ReactPointerEvent) => {
    if (!xThumbDragStart.current) return
    e.stopPropagation()
    const dx = e.clientX - xThumbDragStart.current.mouseX
    const newX =
      xThumbTrack > 0
        ? xThumbDragStart.current.panX - (dx / xThumbTrack) * maxPanXRef.current
        : 0
    setPan((prev) => ({
      ...prev,
      x: Math.min(0, Math.max(-maxPanXRef.current, newX)),
    }))
  }
  const onXThumbPointerUp = (e: ReactPointerEvent) => {
    e.stopPropagation()
    xThumbDragStart.current = null
  }

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button === 1 || (spaceDown.current && e.button === 0)) {
      isPanning.current = true
      panStart.current = {
        mouse: { x: e.clientX, y: e.clientY },
        origin: { ...pan },
      }
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    if (e.target === e.currentTarget) {
      setActiveCollectionId(null)
      setActiveDrawId(null)
    }
  }

  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (isPanning.current && panStart.current) {
      const dx = e.clientX - panStart.current.mouse.x
      const dy = e.clientY - panStart.current.mouse.y
      const newX = Math.min(
        0,
        Math.max(-maxPanXRef.current, panStart.current.origin.x + dx),
      )
      const newY = Math.min(
        0,
        Math.max(-maxPanYRef.current, panStart.current.origin.y + dy),
      )
      setPan({ x: newX, y: newY })
      return
    }
  }

  const onMouseUp = (_e: MouseEvent<HTMLDivElement>) => {
    if (isPanning.current) {
      isPanning.current = false
      panStart.current = null
      return
    }
  }

  const lines = plane.elements.filter(
    (e): e is CanvasLineElement => e.type === "line",
  )
  const nonLines = plane.elements.filter((e) => e.type !== "line")

  return (
    <Box style={{ position: "relative", height: "100%", display: "flex" }}>
      {/* Canvas + scrollbars */}
      <Box
        style={{
          flex: 1,
          position: "relative",
          display: "flex",
          overflow: "hidden",
        }}
      >
        {/* Column: canvas area + optional horizontal scrollbar */}
        <Box
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <Box
            ref={containerRef}
            style={{
              flex: 1,
              position: "relative",
              overflow: "hidden",
              cursor: "default",
              background: isDark
                ? "var(--mantine-color-dark-7)"
                : "var(--mantine-color-gray-0)",
            }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onDragOver={(e: ReactDragEvent<HTMLDivElement>) => {
              const hasFiles = e.dataTransfer.types.includes("Files")
              const hasRef = e.dataTransfer.types.includes(
                COLLECTION_REF_DRAG_MIME,
              )
              const hasEl = e.dataTransfer.types.includes(
                COLLECTION_ELEMENT_DRAG_MIME,
              )
              if (!hasRef && !hasEl && !hasFiles) return
              // Allow the drop (files or collection refs) and highlight the
              // cell / collection under the cursor so the user sees the target.
              e.preventDefault()
              const rect = containerRef.current?.getBoundingClientRect()
              if (!rect) return
              const childPan = { x: pan.x, y: pan.y + CELL_TOP_MARGIN }
              const cx = e.clientX - rect.left - childPan.x
              const cy = e.clientY - rect.top - childPan.y
              const col = Math.floor(cx / CELL_STRIDE_W)
              const row = Math.floor(cy / CELL_STRIDE_H)
              if (col >= 0 && row >= 0) setDragOverCellKey(`${col},${row}`)
            }}
            onDragLeave={(e: ReactDragEvent<HTMLDivElement>) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                setDragOverCellKey(null)
              }
            }}
            onDrop={(e: ReactDragEvent<HTMLDivElement>) => {
              setDragOverCellKey(null)
              setDraggingCollectionId(null)

              const rect = containerRef.current?.getBoundingClientRect()

              // File drop → start (or refuse) an upload flow. handleFileDrop
              // resolves-or-creates the collection at this cell so the pending
              // marker always has a home.
              if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                e.preventDefault()
                let dropCell: { col: number; row: number } | null = null
                if (rect) {
                  const childPan = { x: pan.x, y: pan.y + CELL_TOP_MARGIN }
                  dropCell = {
                    col: Math.floor(
                      (e.clientX - rect.left - childPan.x) / CELL_STRIDE_W,
                    ),
                    row: Math.floor(
                      (e.clientY - rect.top - childPan.y) / CELL_STRIDE_H,
                    ),
                  }
                }
                handleFileDrop(e.dataTransfer.files, dropCell)
                return
              }

              if (!rect) return
              const childPan = { x: pan.x, y: pan.y + CELL_TOP_MARGIN }
              const cx = e.clientX - rect.left - childPan.x
              const cy = e.clientY - rect.top - childPan.y
              const col = Math.floor(cx / CELL_STRIDE_W)
              const row = Math.floor(cy / CELL_STRIDE_H)
              if (col < 0 || row < 0) return

              // Whole-collection move
              const elRaw = e.dataTransfer.getData(COLLECTION_ELEMENT_DRAG_MIME)
              if (elRaw) {
                try {
                  const payload = JSON.parse(
                    elRaw,
                  ) as CollectionElementDragPayload
                  if (payload?.collectionId) {
                    e.preventDefault()
                    handleMoveCollection(payload.collectionId, col, row)
                  }
                } catch {}
                return
              }

              // Ref-level drop (existing behavior)
              const raw =
                e.dataTransfer.getData(COLLECTION_REF_DRAG_MIME) ||
                e.dataTransfer.getData("text/plain")
              if (!raw) return
              try {
                const payload = JSON.parse(raw) as CollectionRefDragPayload
                if (
                  !payload?.sourceCollectionId ||
                  !Array.isArray(payload.refIds)
                )
                  return
                e.preventDefault()
                handleDropToCell(col, row, payload)
              } catch {}
            }}
          >
            {/* Idle hint: no active upload → tell the user how to start one.
                Non-interactive overlay so it never blocks drops. */}
            {!uploadFlow && (
              <Box
                style={{
                  position: "absolute",
                  top: 10,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 5,
                  pointerEvents: "none",
                }}
              >
                <Group
                  gap={8}
                  wrap="nowrap"
                  style={{
                    padding: "6px 14px",
                    borderRadius: 999,
                    background: isDark
                      ? "var(--mantine-color-dark-6)"
                      : "var(--mantine-color-white)",
                    border: "1px dashed var(--mantine-color-red-4)",
                    boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
                  }}
                >
                  <IconCloudUpload
                    size={18}
                    color="var(--mantine-color-red-6)"
                  />
                  <Text size="sm" fw={600} c="red.7">
                    Place files onto Plane for upload
                  </Text>
                </Group>
              </Box>
            )}

            {/* Unified grid: empty ghost cells + all canvas elements */}
            {(() => {
              const childPan = { x: pan.x, y: pan.y + CELL_TOP_MARGIN }
              const startCol = Math.max(
                0,
                Math.floor(-childPan.x / CELL_STRIDE_W),
              )
              const startRow = Math.max(
                0,
                Math.floor(-childPan.y / CELL_STRIDE_H),
              )
              const endCol =
                Math.ceil((containerWidth - childPan.x) / CELL_STRIDE_W) + 1
              const endRow =
                Math.ceil((containerHeight - childPan.y) / CELL_STRIDE_H) + 1

              // Build lookup: cell key → element
              const elementByCell = new Map<string, CanvasElement>()
              for (const el of nonLines) {
                const elCol = Math.round(el.position.x / CELL_W)
                const elRow = Math.round(el.position.y / CELL_H)
                elementByCell.set(`${elCol},${elRow}`, el)
              }

              // Track ALL cells covered by text/note elements (origin + spanned cells).
              // Drag-drop is blocked on these, and EmptyCellEl is not rendered for non-origin spans.
              const textCellKeys = new Set<string>()
              for (const el of nonLines) {
                if (el.type === "text" || el.type === "plaintext") {
                  const elCol = Math.round(el.position.x / CELL_W)
                  const elRow = Math.round(el.position.y / CELL_H)
                  const spanCols = Math.max(1, Math.round(el.size.x / CELL_W))
                  const spanRows = Math.max(1, Math.round(el.size.y / CELL_H))
                  for (let r = elRow; r < elRow + spanRows; r++) {
                    for (let c = elCol; c < elCol + spanCols; c++) {
                      textCellKeys.add(`${c},${r}`)
                    }
                  }
                }
              }

              const cells: React.ReactNode[] = []
              for (let row = startRow; row <= endRow; row++) {
                for (let col = startCol; col <= endCol; col++) {
                  const cellKey = `${col},${row}`
                  const cellX = col * CELL_W
                  const cellY = row * CELL_H
                  const visualX = col * CELL_STRIDE_W + childPan.x
                  const visualY = row * CELL_STRIDE_H + childPan.y
                  const el = elementByCell.get(cellKey)
                  const isDragOver =
                    dragOverCellKey === cellKey && !textCellKeys.has(cellKey)
                  // Per-element pan adjusted for gap (so el.position + elementPan = visualX/Y)
                  const elementPan = {
                    x: childPan.x + col * CELL_GAP,
                    y: childPan.y + row * CELL_GAP,
                  }

                  if (!el) {
                    // Skip empty cells covered by a multi-cell text element
                    if (textCellKeys.has(cellKey)) continue
                    cells.push(
                      <EmptyCellEl
                        key={cellKey}
                        cellX={cellX}
                        cellY={cellY}
                        visualX={visualX}
                        visualY={visualY}
                        isDragOver={isDragOver}
                        planeId={plane.id}
                        isFirstPlane={isFirstPlane}
                        nextCollectionColor={nextCollectionColor}
                        onCreateNote={() => handleCreateNote(cellX, cellY)}
                        onCreateText={() => handleCreateText(cellX, cellY)}
                      />,
                    )
                  } else if (el.type === "text") {
                    const tel = el as CanvasTextElement
                    cells.push(
                      <TextEl
                        key={el.id}
                        el={tel}
                        onUpdate={(updated) => updateElement(plane.id, updated)}
                        onDelete={() => deleteElement(plane.id, el.id)}
                        onStartEdit={undefined}
                        onEditEnd={undefined}
                        pan={elementPan}
                      />,
                    )
                  } else if (el.type === "plaintext") {
                    const ptel = el as CanvasPlainTextElement
                    cells.push(
                      <PlainTextEl
                        key={el.id}
                        el={ptel}
                        onUpdate={(updated) => updateElement(plane.id, updated)}
                        onDelete={() => deleteElement(plane.id, el.id)}
                        onStartEdit={() => {
                          plaintextEditingRef.current = true
                        }}
                        onEditEnd={() => {
                          plaintextEditingRef.current = false
                        }}
                        pan={elementPan}
                      />,
                    )
                  } else if (el.type === "collection") {
                    cells.push(
                      <CollectionEl
                        key={el.id}
                        el={el as CanvasCollectionElement}
                        planeId={plane.id}
                        isFirstPlane={isFirstPlane}
                        onUpdate={(updated) => updateElement(plane.id, updated)}
                        onDelete={() => deleteElement(plane.id, el.id)}
                        pan={elementPan}
                        isDragOver={
                          isDragOver && draggingCollectionId !== el.id
                        }
                        isDragging={draggingCollectionId === el.id}
                        onStartDivide={() => {
                          handleStartDivide(el as CanvasCollectionElement)
                        }}
                        onDragCollectionStart={() =>
                          setDraggingCollectionId(el.id)
                        }
                        onDragCollectionEnd={() =>
                          setDraggingCollectionId(null)
                        }
                        onCreateNote={() => handleCreateNote(cellX, cellY)}
                        onCreateText={() => handleCreateText(cellX, cellY)}
                      />,
                    )
                  }
                }
              }
              return cells
            })()}

            {/* SVG line layer */}
            <LineOverlay
              lines={lines}
              pan={{ x: pan.x, y: pan.y + CELL_TOP_MARGIN }}
              canMove={false}
              activeId={activeDrawId}
              setActiveId={setActiveDrawId}
              onUpdate={(el) => updateElement(plane.id, el)}
              onDelete={(id) => deleteElement(plane.id, id)}
            />

            {/* Onboarding guidance banner — only on the first plane */}
            {isFirstPlane && <OnboardingBanner level={obLevel} />}
          </Box>

          {/* Horizontal scrollbar — only shown when elements overflow to the right */}
          {maxPanX > 0 && (
            <div
              role="scrollbar"
              aria-controls="canvas-area"
              aria-orientation="horizontal"
              aria-valuenow={0}
              aria-valuemin={0}
              aria-valuemax={100}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") {
                  setPan((prev) => ({ ...prev, x: Math.min(0, prev.x + 40) }))
                } else if (e.key === "ArrowRight") {
                  setPan((prev) => ({
                    ...prev,
                    x: Math.max(-maxPanXRef.current, prev.x - 40),
                  }))
                }
              }}
              style={{
                height: 10,
                flexShrink: 0,
                background: "var(--mantine-color-gray-1)",
                borderTop: "1px solid var(--mantine-color-default-border)",
                position: "relative",
                cursor: "default",
                userSelect: "none",
              }}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const frac = (e.clientX - rect.left) / rect.width
                setPan((prev) => ({
                  ...prev,
                  x: Math.min(
                    0,
                    Math.max(-maxPanXRef.current, -frac * maxPanXRef.current),
                  ),
                }))
              }}
            >
              {xThumbW > 0 && (
                <div
                  style={{
                    position: "absolute",
                    left: xThumbLeft,
                    top: 1,
                    bottom: 1,
                    width: xThumbW,
                    background: "var(--mantine-color-gray-5)",
                    borderRadius: 3,
                    cursor: "grab",
                    userSelect: "none",
                    touchAction: "none",
                  }}
                  onPointerDown={onXThumbPointerDown}
                  onPointerMove={onXThumbPointerMove}
                  onPointerUp={onXThumbPointerUp}
                />
              )}
            </div>
          )}
        </Box>
        {/* end column wrapper */}

        {/* Custom vertical scrollbar track */}
        <div
          role="scrollbar"
          aria-controls="canvas-area"
          aria-valuenow={0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-orientation="vertical"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              setPan((prev) => ({ ...prev, y: Math.min(0, prev.y + 40) }))
            } else if (e.key === "ArrowDown") {
              setPan((prev) => ({
                ...prev,
                y: Math.max(-maxPanYRef.current, prev.y - 40),
              }))
            }
          }}
          style={{
            width: 10,
            flexShrink: 0,
            background: "var(--mantine-color-gray-1)",
            borderLeft: "1px solid var(--mantine-color-default-border)",
            position: "relative",
            cursor: "default",
            userSelect: "none",
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const frac = (e.clientY - rect.top) / rect.height
            setPan((prev) => ({
              ...prev,
              y: Math.min(
                0,
                Math.max(-maxPanYRef.current, -frac * maxPanYRef.current),
              ),
            }))
          }}
        >
          {thumbH > 0 && (
            <div
              style={{
                position: "absolute",
                top: thumbTop,
                left: 1,
                right: 1,
                height: thumbH,
                background: "var(--mantine-color-gray-5)",
                borderRadius: 3,
                cursor: "grab",
                userSelect: "none",
                touchAction: "none",
              }}
              onPointerDown={onThumbPointerDown}
              onPointerMove={onThumbPointerMove}
              onPointerUp={onThumbPointerUp}
            />
          )}
        </div>
      </Box>

      {/* ── Division dialog ───────────────────────────────────────────────────────── */}
      {dividingCollection && (
        <DivisionOverlay
          collection={dividingCollection}
          onCancel={handleCancelDivide}
          onConfirm={handleConfirmDivide}
        />
      )}

      {/* ── Transfer-to-plane dialog ──────────────────────────────────────────── */}
      <Modal
        opened={!!transferDialog}
        onClose={() => setTransferDialog(null)}
        title="Transfer to Plane"
        size="sm"
        centered
      >
        {transferDialog &&
          (() => {
            const targetPlane = planes.find(
              (p) => p.id === transferDialog.targetPlaneId,
            )
            const sourceSharedWith = plane.sharedWith ?? []
            const targetSharedWith = targetPlane?.sharedWith ?? []
            const userLabel = (u: {
              email: string
              full_name: string | null
            }) => u.full_name || u.email
            return (
              <Stack gap="md">
                <Text size="sm">
                  Move or copy{" "}
                  <Text span fw={600}>
                    "{transferDialog.element.name}"
                  </Text>{" "}
                  ({transferDialog.element.refs.length} item
                  {transferDialog.element.refs.length !== 1 ? "s" : ""}) to{" "}
                  <Text span fw={600}>
                    "{targetPlane?.name ?? "Unknown"}"
                  </Text>
                  ?
                </Text>
                {targetSharedWith.length > 0 && (
                  <Alert color="yellow" variant="light">
                    <Text size="sm">
                      Moving to a shared plane will grant access to:{" "}
                      <strong>
                        {targetSharedWith.map(userLabel).join(", ")}
                      </strong>
                    </Text>
                  </Alert>
                )}
                {sourceSharedWith.length > 0 && (
                  <Alert color="orange" variant="light">
                    <Text size="sm">
                      Moving away from a shared plane means:{" "}
                      <strong>
                        {sourceSharedWith.map(userLabel).join(", ")}
                      </strong>{" "}
                      will lose access to these items.
                    </Text>
                  </Alert>
                )}
                <Group justify="flex-end" gap="sm">
                  <Button
                    variant="default"
                    onClick={() => setTransferDialog(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    leftSection={<IconCopy size={16} />}
                    variant="light"
                    onClick={() => {
                      copyElementToPlane(
                        transferDialog.element,
                        transferDialog.targetPlaneId,
                      )
                      setTransferDialog(null)
                    }}
                  >
                    Copy
                  </Button>
                  <Button
                    leftSection={<IconArrowRight size={16} />}
                    onClick={() => {
                      moveElementToPlane(
                        transferDialog.element,
                        plane.id,
                        transferDialog.targetPlaneId,
                      )
                      setTransferDialog(null)
                    }}
                  >
                    Move
                  </Button>
                </Group>
              </Stack>
            )
          })()}
      </Modal>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Plane tab label (editable double-click, close button)
// ─────────────────────────────────────────────────────────────────────────────

function PlaneTabLabel({
  plane,
  onRename,
  onClose,
  canClose,
  autoStartEdit = false,
}: {
  plane: Plane
  onRename: (name: string) => void
  onClose: () => void
  canClose: boolean
  autoStartEdit?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [buf, setBuf] = useState(plane.name)

  // Keep buf in sync when the plane name is changed externally (e.g. via card inline edit)
  useEffect(() => {
    if (!editing) {
      setBuf(plane.name)
    }
  }, [plane.name, editing])

  // Trigger edit mode once when autoStartEdit becomes true
  useEffect(() => {
    if (autoStartEdit) {
      setEditing(true)
    }
  }, [autoStartEdit])

  const commit = () => {
    onRename(buf.trim() || plane.name)
    setEditing(false)
  }

  if (editing) {
    return (
      <TextInput
        size="xs"
        value={buf}
        autoFocus
        onFocus={(e) => {
          e.currentTarget?.select()
        }}
        onChange={(e) => setBuf(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit()
          }
          if (e.key === "Escape") {
            setBuf(plane.name)
            setEditing(false)
          }
        }}
        style={{ width: rem(100) }}
        onClick={(e) => e.stopPropagation()}
      />
    )
  }

  return (
    <Group gap={6} wrap="nowrap">
      <Badge
        size="xs"
        color={(plane.sharedWith?.length ?? 0) > 0 ? "red" : "green"}
        variant="light"
      >
        {(plane.sharedWith?.length ?? 0) > 0 ? "s" : "p"}
      </Badge>
      <Text
        size="sm"
        onDoubleClick={() => setEditing(true)}
        style={{ cursor: "text" }}
      >
        {plane.name}
      </Text>
      {canClose && (
        <ActionIcon
          component="span"
          size="xs"
          variant="subtle"
          color="gray"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <IconX size={10} />
        </ActionIcon>
      )}
    </Group>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Welcome / General plane overview
// ─────────────────────────────────────────────────────────────────────────────

function WelcomePlaneView() {
  const { planes, addPlane, setActivePlaneId, setPlanes, flushSave } =
    useAppContext()
  const { user } = useAuth()
  const [sharingPlaneId, setSharingPlaneId] = useState<string | null>(null)
  const [newPlaneEditingId, setNewPlaneEditingId] = useState<string | null>(
    null,
  )
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery] = useDebouncedValue(searchQuery, 300)
  const [searchResults, setSearchResults] = useState<
    Array<{ id: string; email: string; full_name?: string | null }>
  >([])
  const [isSearching, setIsSearching] = useState(false)
  const [hoveredPlaneId, setHoveredPlaneId] = useState<string | null>(null)
  /** Count items referenced by collections on a given plane */
  const getPlaneItemCounts = (plane: Plane) => {
    const expIds = new Set<string>()
    for (const el of plane.elements) {
      if (el.type !== "collection") continue
      const col = el as CanvasCollectionElement
      for (const ref of col.refs) {
        if (ref.kind === "experiment") expIds.add(ref.id)
      }
    }
    return {
      experiments: expIds.size,
      collections: plane.elements.filter((e) => e.type === "collection").length,
    }
  }

  const handleAddPlane = () => {
    const p = addPlane(`Plane ${planes.length + 1}`, user?.id)
    setActivePlaneId(p.id)
    setNewPlaneEditingId(p.id)
  }

  const handleOpenShareModal = async (planeId: string, e: MouseEvent) => {
    e.stopPropagation()
    // Ensure plane is saved to backend before opening share modal
    await flushSave()
    setSharingPlaneId(planeId)
    setSearchQuery("")
    setSearchResults([])
  }

  const handleCloseShareModal = () => {
    setSharingPlaneId(null)
    setSearchQuery("")
    setSearchResults([])
  }

  const reloadPlanes = useCallback(async () => {
    try {
      const response = await PlanesService.readPlanes({})
      if (response.data) {
        const serverData = response.data
        setPlanes((prev) => {
          const localById = new Map(prev.map((p) => [p.id, p]))
          const serverIds = new Set(serverData.map((p) => p.id))
          const converted = serverData.map((apiPlane) => {
            const currentPlane = localById.get(apiPlane.id)
            const apiPlaneCompat = {
              id: apiPlane.id,
              name: apiPlane.name,
              owner_id: apiPlane.owner_id,
              owner: {
                id: apiPlane.owner.id,
                email: apiPlane.owner.email,
                full_name: apiPlane.owner.full_name ?? null,
              },
              created_at: apiPlane.created_at ?? null,
              elements: [
                ...(apiPlane.sticky_notes ?? []).map((sn) => ({
                  id: sn.id,
                  element_type: "sticky_note",
                  x: sn.i ?? 0,
                  y: sn.j ?? 0,
                  width: sn.di ?? 100,
                  height: sn.dj ?? 100,
                  content: sn.content ?? null,
                  color: sn.color ?? null,
                })),
                ...(apiPlane.text_fields ?? []).map((tf) => ({
                  id: tf.id,
                  element_type: "text_field",
                  x: tf.i ?? 0,
                  y: tf.j ?? 0,
                  width: tf.di ?? 100,
                  height: tf.dj ?? 100,
                  content: tf.content ?? null,
                  color: tf.color ?? null,
                })),
                ...(apiPlane.collections ?? []).map((c) => ({
                  id: c.id,
                  element_type: "collection",
                  x: c.i ?? 0,
                  y: c.j ?? 0,
                  width: 100,
                  height: 100,
                  content: c.name ?? null,
                  color: c.color ?? null,
                })),
              ],
              shared_with:
                apiPlane.shared_with?.map((u) => ({
                  id: u.id,
                  email: u.email,
                  full_name: u.full_name ?? null,
                })) ?? [],
            }
            const serverPlane = apiPlaneToPlane(apiPlaneCompat)
            // For existing local planes: preserve elements (local is authoritative),
            // and update name + sharing metadata from server.
            if (currentPlane) {
              return {
                ...currentPlane,
                name: serverPlane.name,
                ownerId: serverPlane.ownerId,
                owner: serverPlane.owner,
                sharedWith: serverPlane.sharedWith,
              }
            }
            // New plane from server (e.g. shared by another user since last session)
            return serverPlane
          })
          // Preserve local-only planes (created but not yet synced to server)
          const localOnly = prev.filter((p) => !serverIds.has(p.id))
          return [...converted, ...localOnly]
        })
      }
    } catch (error) {
      console.error("Failed to reload planes:", error)
    }
  }, [setPlanes])

  useEffect(() => {
    void reloadPlanes()
  }, [reloadPlanes])

  const handleShareWithUser = async (userId: string) => {
    if (!sharingPlaneId) return
    try {
      // Ensure plane is persisted to backend before sharing
      await flushSave()
      await PlanesService.sharePlane({
        id: sharingPlaneId,
        requestBody: { user_id: userId },
      })
      await reloadPlanes()
      setSearchQuery("")
      setSearchResults([])
    } catch (error) {
      console.error("Failed to share plane:", error)
    }
  }

  const handleRemoveShare = async (planeId: string, userId: string) => {
    try {
      // Ensure plane state is persisted before modifying shares
      await flushSave()
      await PlanesService.unsharePlane({
        id: planeId,
        userId: userId,
      })
      await reloadPlanes()
    } catch (error) {
      console.error("Failed to remove share:", error)
    }
  }

  const sharingPlane = planes.find((p) => p.id === sharingPlaneId)

  // Search users when debounced query changes
  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setSearchResults([])
      return
    }
    setIsSearching(true)
    PlanesService.searchUsers({
      q: debouncedQuery,
      limit: 10,
    })
      .then((users) => {
        // Filter out current user and users already shared with
        const alreadySharedIds = new Set(
          sharingPlane?.sharedWith?.map((u) => u.id) ?? [],
        )
        const filtered = users.filter(
          (u) => u.id !== user?.id && !alreadySharedIds.has(u.id),
        )
        setSearchResults(filtered)
      })
      .catch((error) => {
        console.error("Failed to search users:", error)
        setSearchResults([])
      })
      .finally(() => {
        setIsSearching(false)
      })
  }, [debouncedQuery, user?.id, sharingPlane?.sharedWith])
  const isOwner = (plane: Plane) => plane.ownerId === user?.id
  const isShared = (plane: Plane) => (plane.sharedWith?.length ?? 0) > 0
  const ownerLabel = (plane: Plane) =>
    plane.owner?.full_name || plane.owner?.email || "Unknown user"

  const renderPlaneCard = (plane: Plane) => {
    const counts = getPlaneItemCounts(plane)
    const sharedWith = plane.sharedWith ?? []
    const badgeColor = isShared(plane) ? "red" : "green"
    const badgeLabel = isShared(plane) ? "Shared" : "Private"
    const isNewlyCreated = newPlaneEditingId === plane.id

    return (
      <Paper
        key={plane.id}
        withBorder
        shadow="sm"
        p="md"
        style={{
          width: 220,
          cursor: "pointer",
          transition: "box-shadow 150ms ease",
          position: "relative",
        }}
        onMouseEnter={() => setHoveredPlaneId(plane.id)}
        onMouseLeave={() => setHoveredPlaneId(null)}
        onClick={() => setActivePlaneId(plane.id)}
      >
        {isOwner(plane) && (
          <ActionIcon
            variant="subtle"
            color={hoveredPlaneId === plane.id ? "blue" : "gray"}
            size="sm"
            onClick={(e) => handleOpenShareModal(plane.id, e)}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 10,
            }}
            title="Share this plane"
          >
            <IconShare size={16} />
          </ActionIcon>
        )}

        <Group justify="space-between" mb="xs" pr={isOwner(plane) ? 24 : 0}>
          {isNewlyCreated ? (
            <TextInput
              size="xs"
              value={plane.name}
              autoFocus
              onFocus={(e) => {
                e.currentTarget?.select()
              }}
              onChange={(e) => {
                const value = e.currentTarget.value
                setPlanes((prev) =>
                  prev.map((current) =>
                    current.id === plane.id
                      ? { ...current, name: value }
                      : current,
                  ),
                )
              }}
              onBlur={() => setNewPlaneEditingId(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setNewPlaneEditingId(null)
                }
                if (e.key === "Escape") {
                  setNewPlaneEditingId(null)
                }
              }}
              style={{ flex: 1, minWidth: 0 }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <Text fw={600} size="md">
              {plane.name}
            </Text>
          )}
          <Badge size="xs" color={badgeColor} variant="light">
            {badgeLabel}
          </Badge>
        </Group>

        {sharedWith.length > 0 && (
          <Text size="xs" c="dimmed" mb="xs">
            Shared with:{" "}
            {sharedWith.map((u) => u.full_name || u.email).join(", ")}
          </Text>
        )}

        <Stack gap={4}>
          <Group gap={6}>
            <IconPlayerPlay size={14} color="var(--mantine-color-grape-6)" />
            <Text size="xs" c="dimmed">
              {counts.experiments} experiment
              {counts.experiments !== 1 ? "s" : ""}
            </Text>
          </Group>
          <Group gap={6}>
            <IconFolderPlus size={14} color="var(--mantine-color-gray-6)" />
            <Text size="xs" c="dimmed">
              {counts.collections} collection
              {counts.collections !== 1 ? "s" : ""}
            </Text>
          </Group>
        </Stack>
      </Paper>
    )
  }

  const ownedPlanes = planes.filter(isOwner)
  const sharedPlanes = planes.filter((plane) => !isOwner(plane))
  const sharedByGroups = sharedPlanes.reduce<
    Array<{ label: string; planes: Plane[] }>
  >((groups, plane) => {
    const label = ownerLabel(plane)
    const current = groups.find((group) => group.label === label)
    if (current) {
      current.planes.push(plane)
    } else {
      groups.push({ label, planes: [plane] })
    }
    return groups
  }, [])

  return (
    <Box p="xl">
      <Text size="xl" fw={700} mb="lg">
        Planes Overview & Data Sharing
      </Text>
      <Text size="sm" c="dimmed" mb="lg">
        Share planes with other users to grant full read and write access to all
        data and collections
      </Text>
      <Stack gap="xl" mb="lg">
        {ownedPlanes.length > 0 && (
          <Stack gap="sm">
            <Text size="sm" fw={600} c="dimmed">
              My planes
            </Text>
            <Group gap="md" wrap="wrap">
              {ownedPlanes.map(renderPlaneCard)}
            </Group>
          </Stack>
        )}

        {sharedByGroups.map((group) => (
          <Stack gap="sm" key={group.label}>
            <Text size="sm" fw={600} c="dimmed">
              Shared by {group.label}
            </Text>
            <Group gap="md" wrap="wrap">
              {group.planes.map(renderPlaneCard)}
            </Group>
          </Stack>
        ))}

        <Paper
          withBorder
          shadow="sm"
          p="md"
          style={{
            width: 220,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 140,
            border: "2px dashed var(--mantine-color-gray-4)",
          }}
          onClick={handleAddPlane}
        >
          <Stack align="center" gap={4}>
            <IconPlus size={24} color="var(--mantine-color-gray-5)" />
            <Text size="sm" c="dimmed">
              Add Plane
            </Text>
          </Stack>
        </Paper>
      </Stack>

      {/* Share Modal */}
      <Modal
        opened={sharingPlaneId !== null}
        onClose={handleCloseShareModal}
        title={`Share "${sharingPlane?.name}"`}
        size="md"
      >
        <Stack gap="md">
          <Text size="sm" c="orange">
            ⚠️ Sharing will grant full read and write access to all data and
            collections on this plane
          </Text>

          <TextInput
            label="Search users"
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
            rightSection={isSearching ? <Loader size="xs" /> : null}
          />

          {searchQuery.length >= 2 &&
            searchResults.length === 0 &&
            !isSearching && (
              <Text size="xs" c="dimmed" ta="center" py="md">
                No users found. Users already shared with or yourself are
                excluded.
              </Text>
            )}

          {searchResults.length > 0 && (
            <Stack gap="xs">
              <Text size="xs" fw={600} c="dimmed">
                Search Results
              </Text>
              {searchResults.map((searchUser) => (
                <Paper key={searchUser.id} p="xs" withBorder>
                  <Group justify="space-between">
                    <Stack gap={0}>
                      <Text size="sm">{searchUser.full_name || "No name"}</Text>
                      <Text size="xs" c="dimmed">
                        {searchUser.email}
                      </Text>
                    </Stack>
                    <Button
                      size="xs"
                      onClick={() => handleShareWithUser(searchUser.id)}
                    >
                      Share
                    </Button>
                  </Group>
                </Paper>
              ))}
            </Stack>
          )}

          {sharingPlane?.sharedWith && sharingPlane.sharedWith.length > 0 && (
            <>
              <Divider />
              <Stack gap="xs">
                <Text size="xs" fw={600} c="dimmed">
                  Currently Shared With
                </Text>
                {sharingPlane.sharedWith.map((sharedUser) => (
                  <Paper key={sharedUser.id} p="xs" withBorder>
                    <Group justify="space-between">
                      <Stack gap={0}>
                        <Text size="sm">
                          {sharedUser.full_name || "No name"}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {sharedUser.email}
                        </Text>
                      </Stack>
                      <ActionIcon
                        color="red"
                        variant="subtle"
                        onClick={() =>
                          handleRemoveShare(sharingPlane.id, sharedUser.id)
                        }
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </Paper>
                ))}
              </Stack>
            </>
          )}
        </Stack>
      </Modal>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Organization page
// ─────────────────────────────────────────────────────────────────────────────

export function OrganizationPage() {
  const {
    planes,
    addPlane,
    updatePlane,
    deletePlane,
    activePlaneId,
    setActivePlaneId,
  } = useAppContext()
  const { user } = useAuth()

  const hoveredPlaneTabId: string | null = null
  const [newPlaneEditingId, setNewPlaneEditingId] = useState<string | null>(
    null,
  )

  // Keep the user on a concrete plane; if the current plane disappears,
  // fall back to the first available plane.
  useEffect(() => {
    if (activePlaneId && !planes.find((p) => p.id === activePlaneId)) {
      setActivePlaneId(planes[0]?.id ?? null)
    }
  }, [planes, activePlaneId, setActivePlaneId])

  const handleAddPlane = () => {
    const p = addPlane(`Plane ${planes.length + 1}`, user?.id)
    setActivePlaneId(p.id)
    setNewPlaneEditingId(p.id)
  }

  const handleDeletePlane = (id: string) => {
    const target = planes.find((p) => p.id === id)
    if (!target) return

    const isOwned = !target.ownerId || target.ownerId === user?.id

    if (!isOwned) {
      // Non-owner: offer to leave the shared plane
      modals.openConfirmModal({
        title: "Leave shared plane",
        children: (
          <Text size="sm">
            Leave <strong>"{target.name}"</strong>? You will lose access to this
            shared plane. The owner's data won't be affected.
          </Text>
        ),
        labels: { confirm: "Leave", cancel: "Cancel" },
        confirmProps: { color: "orange" },
        onConfirm: async () => {
          try {
            await PlanesService.unsharePlane({ id, userId: user!.id })
          } catch {
            // Best-effort — remove from local view regardless
          }
          deletePlane(id)
          if (activePlaneId === id) {
            const remainingPlanes = planes.filter((p) => p.id !== id)
            setActivePlaneId(remainingPlanes[0]?.id ?? null)
          }
        },
      })
      return
    }

    // Owner: block deleting the last owned plane
    const ownedCount = planes.filter(
      (p) => !p.ownerId || p.ownerId === user?.id,
    ).length
    if (ownedCount <= 1) return

    modals.openConfirmModal({
      title: "Delete plane",
      children: <Text size="sm">Delete this plane and all its content?</Text>,
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        deletePlane(id)
        if (activePlaneId === id) {
          const remainingPlanes = planes.filter((p) => p.id !== id)
          setActivePlaneId(remainingPlanes[0]?.id ?? null)
        }
      },
    })
  }

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        height:
          "calc(100dvh - var(--app-shell-header-height, 60px) - var(--app-shell-padding, 16px) * 2)",
      }}
    >
      <Tabs
        value={activePlaneId ?? "__general__"}
        onChange={(v) => {
          if (v === "__general__") {
            setActivePlaneId(null)
          } else if (v) {
            setActivePlaneId(v)
          }
        }}
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          overflow: "hidden",
        }}
        keepMounted={false}
      >
        <Group
          align="flex-end"
          gap={0}
          px="md"
          style={{ flexShrink: 0, flexWrap: "nowrap", overflowX: "auto" }}
        >
          <ScrollArea type="never" style={{ flex: 1 }}>
            <Tabs.List style={{ flexWrap: "nowrap", borderBottom: "none" }}>
              <Tabs.Tab value="__general__">
                <Text size="sm">Overview & Data Sharing</Text>
              </Tabs.Tab>
              {planes.map((p) => (
                <Tabs.Tab
                  value={p.id}
                  key={p.id}
                  data-plane-tab-id={p.id}
                  style={
                    hoveredPlaneTabId === p.id
                      ? {
                          background: "var(--mantine-color-blue-1)",
                          outline: "2px solid var(--mantine-color-blue-4)",
                          outlineOffset: -2,
                          borderRadius: "var(--mantine-radius-sm)",
                          transition:
                            "background 0.15s ease, outline 0.15s ease",
                        }
                      : {
                          transition:
                            "background 0.15s ease, outline 0.15s ease",
                        }
                  }
                >
                  <PlaneTabLabel
                    plane={p}
                    onRename={(name) => updatePlane({ ...p, name })}
                    onClose={() => handleDeletePlane(p.id)}
                    canClose={
                      !p.ownerId || p.ownerId === user?.id
                        ? planes.filter(
                            (q) => !q.ownerId || q.ownerId === user?.id,
                          ).length > 1
                        : true // non-owner can always leave
                    }
                    autoStartEdit={newPlaneEditingId === p.id}
                  />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </ScrollArea>
          <Tooltip label="Add plane">
            <ActionIcon
              variant="subtle"
              size="sm"
              mb={4}
              ml={4}
              onClick={handleAddPlane}
            >
              <IconPlus size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>

        {/* Tab panels */}
        <Box
          style={{
            flex: 1,
            overflow: "hidden",
            borderTop: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Tabs.Panel
            key="__general__"
            value="__general__"
            style={{ height: "100%", overflow: "auto" }}
          >
            <WelcomePlaneView />
          </Tabs.Panel>
          {planes.map((p) => (
            <Tabs.Panel key={p.id} value={p.id} style={{ height: "100%" }}>
              <PlaneCanvas plane={p} />
            </Tabs.Panel>
          ))}
        </Box>
      </Tabs>
    </Box>
  )
}
