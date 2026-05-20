import {
  ActionIcon,
  Badge,
  Box,
  Button,
  ColorSwatch,
  Divider,
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
  IconAtom,
  IconBold,
  IconBox,
  IconChartBar,
  IconCheck,
  IconCopy,
  IconDownload,
  IconFlask,
  IconFolderPlus,
  IconHandGrab,
  IconItalic,
  IconLayersLinked,
  IconLetterT,
  IconMinus,
  IconNote,
  IconPackage,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconPointer,
  IconSeparatorVertical,
  IconShare,
  IconSquare,
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
  useRef,
  useState,
} from "react"
import { PlanesService } from "../client"
import useAuth from "../hooks/useAuth"
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
  type Material,
  type MaterialCategory,
  type Plane,
  type Process,
  type Solution,
  type TextFormatting,
  useAppContext,
  type Vec2,
} from "../store/AppContext"
import { apiPlaneToPlane } from "../store/apiTypes"

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GRID = 20 // px – subtle grid snap
const ELEMENT_PICKER_DISMISS_DISTANCE = 220 // px from popup origin
const COLLECTION_REF_DRAG_MIME = "application/x-plains-collection-ref-drag"

// Neutral grayish-blue for default selections
const DEFAULT_ACCENT = "#94a3b8"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function snapToGrid(v: number): number {
  return Math.round(v / GRID) * GRID
}

function canvasCoords(
  e: MouseEvent<HTMLDivElement>,
  containerRef: React.RefObject<HTMLDivElement | null>,
  pan: Vec2,
): Vec2 {
  const rect = containerRef.current!.getBoundingClientRect()
  return {
    x: snapToGrid(e.clientX - rect.left - pan.x),
    y: snapToGrid(e.clientY - rect.top - pan.y),
  }
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

/** Approximate rendered bounding box of a CollectionEl card */
const COL_W = 156
const COL_H = 110

function collectionsOverlap(aPos: Vec2, bPos: Vec2): boolean {
  return (
    aPos.x < bPos.x + COL_W &&
    aPos.x + COL_W > bPos.x &&
    aPos.y < bPos.y + COL_H &&
    aPos.y + COL_H > bPos.y
  )
}

/** Average RGB of two hex colors */
function mixColors(hex1: string, hex2: string): string {
  const h1 = hex1.replace("#", "")
  const h2 = hex2.replace("#", "")
  const r = Math.round(
    (parseInt(h1.slice(0, 2), 16) + parseInt(h2.slice(0, 2), 16)) / 2,
  )
  const g = Math.round(
    (parseInt(h1.slice(2, 4), 16) + parseInt(h2.slice(2, 4), 16)) / 2,
  )
  const b = Math.round(
    (parseInt(h1.slice(4, 6), 16) + parseInt(h2.slice(4, 6), 16)) / 2,
  )
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`
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

// Inject keyframes for bubble animation
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
  `
  document.head.appendChild(style)
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
  const dragStart = useRef<{ mouse: Vec2; origin: Vec2 } | null>(null)
  const resizeStart = useRef<{ mouse: Vec2; size: Vec2 } | null>(null)
  const prevEditing = useRef(editing)

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
        x: snapToGrid(dragStart.current.origin.x + dx),
        y: snapToGrid(dragStart.current.origin.y + dy),
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
        x: Math.max(100, snapToGrid(resizeStart.current.size.x + dx)),
        y: Math.max(60, snapToGrid(resizeStart.current.size.y + dy)),
      },
    })
  }

  const stopResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.stopPropagation()
    resizeStart.current = null
  }

  const textColor = el.color || "#000000"
  const textFormatting = el.formatting || {
    bold: false,
    italic: false,
    underline: false,
  }

  useEffect(() => {
    if (!prevEditing.current && editing) {
      onStartEdit?.()
    }
    if (prevEditing.current && !editing) {
      onEditEnd?.()
    }
    prevEditing.current = editing
  }, [editing, onEditEnd, onStartEdit])

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

        {/* Delete button – top-right, outside fold area */}
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
            onPointerDown={(e) => e.stopPropagation()}
            styles={{
              input: {
                background: "transparent",
                border: "none",
                resize: "none",
                color: textColor,
                fontFamily: "inherit",
                fontSize: "0.85rem",
                fontWeight: textFormatting.bold ? 700 : 400,
                fontStyle: textFormatting.italic ? "italic" : "normal",
                textDecoration: textFormatting.underline ? "underline" : "none",
                padding: 0,
              },
            }}
          />
        ) : (
          <Text
            size="sm"
            style={{
              whiteSpace: "pre-wrap",
              minHeight: rem(40),
              color: textColor,
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
            {el.content || (
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
        x: snapToGrid(dragStart.current.origin.x + dx),
        y: snapToGrid(dragStart.current.origin.y + dy),
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
        x: Math.max(60, snapToGrid(resizeStart.current.size.x + dx)),
        y: Math.max(24, snapToGrid(resizeStart.current.size.y + dy)),
      },
    })
  }

  const stopResize = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.stopPropagation()
    resizeStart.current = null
  }

  // Calculate font size based on element height (responsive to resize)
  const fontSize = Math.max(12, Math.min(48, el.size.y * 0.6))

  const textStyle: React.CSSProperties = {
    color: el.color,
    fontWeight: el.formatting.bold ? 700 : 400,
    fontStyle: el.formatting.italic ? "italic" : "normal",
    textDecoration: el.formatting.underline ? "underline" : "none",
    fontSize,
    lineHeight: 1.2,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
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
              onEditEnd?.()
            }}
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
            {el.content || (
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
// Collection element – minimal card with speech-bubble actions when selected
// ─────────────────────────────────────────────────────────────────────────────

/** Speech-bubble action button rendered outside the collection card */
// Sub-menu items for material category selection
const MATERIAL_SUBMENU_ITEMS: {
  label: string
  color: string
  Icon: React.ElementType
  category: MaterialCategory
}[] = [
  {
    label: "Compound",
    color: "teal",
    Icon: IconAtom,
    category: "chemical_compound",
  },
  {
    label: "Com. Mixture",
    color: "cyan",
    Icon: IconPackage,
    category: "commercial_mixture",
  },
  {
    label: "Substrate Mat.",
    color: "lime",
    Icon: IconLayersLinked,
    category: "substrate_material",
  },
]

function MaterialActionBubble({
  index,
  onSelect,
  onHoverStart,
  onHoverEnd,
}: {
  index: number
  onSelect: (category: MaterialCategory) => void
  onHoverStart?: () => void
  onHoverEnd?: () => void
}) {
  const [open, setOpen] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleClose = () => {
    hideTimerRef.current = setTimeout(() => setOpen(false), 200)
  }
  const cancelClose = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
  }

  return (
    <>
      <ActionIcon
        size="md"
        variant="filled"
        color="teal"
        radius="xl"
        onMouseEnter={() => {
          cancelClose()
          setOpen(true)
          onHoverStart?.()
        }}
        onMouseLeave={() => {
          scheduleClose()
          onHoverEnd?.()
        }}
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerUp={(e) => {
          e.stopPropagation()
          e.preventDefault()
          ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
        }}
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onSelect("chemical_compound")
        }}
        style={{
          position: "absolute",
          right: -44,
          top: 4 + index * 36,
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          animation: "bubble-in 150ms ease-out",
          touchAction: "none",
        }}
      >
        <IconBox size={16} />
      </ActionIcon>
      {open && (
        <Paper
          shadow="md"
          p={4}
          radius="sm"
          onMouseEnter={() => {
            cancelClose()
            onHoverStart?.()
          }}
          onMouseLeave={() => {
            scheduleClose()
            onHoverEnd?.()
          }}
          style={{
            position: "absolute",
            right: -185,
            top: 4 + index * 36 - 2,
            zIndex: 200,
            minWidth: 130,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {MATERIAL_SUBMENU_ITEMS.map((item) => (
            <Tooltip
              key={item.category}
              label={`Add ${item.label}`}
              position="right"
              withArrow
            >
              <Button
                size="compact-xs"
                variant="subtle"
                color={item.color}
                leftSection={<item.Icon size={13} />}
                styles={{ inner: { justifyContent: "flex-start" } }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  setOpen(false)
                  onSelect(item.category)
                }}
              >
                {item.label}
              </Button>
            </Tooltip>
          ))}
        </Paper>
      )}
    </>
  )
}

function ActionBubble({
  label,
  Icon,
  color,
  onClick,
  index,
  onHoverStart,
  onHoverEnd,
}: {
  label: string
  Icon: React.ElementType
  color: string
  onClick: () => void
  index: number
  onHoverStart?: () => void
  onHoverEnd?: () => void
}) {
  // Position bubbles in a vertical stack to the right of the collection
  return (
    <Tooltip label={label} position="right" withArrow>
      <ActionIcon
        size="md"
        variant="filled"
        color={color}
        radius="xl"
        onClick={(e) => {
          e.stopPropagation()
          e.preventDefault()
          onClick()
        }}
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        }}
        onPointerUp={(e) => {
          e.stopPropagation()
          e.preventDefault()
          ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
        }}
        onMouseEnter={onHoverStart}
        onMouseLeave={onHoverEnd}
        style={{
          position: "absolute",
          right: -44,
          top: 4 + index * 36,
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          animation: "bubble-in 150ms ease-out",
          touchAction: "none",
        }}
      >
        <Icon size={16} />
      </ActionIcon>
    </Tooltip>
  )
}

function ExperimentActionBubble({
  index,
  processes,
  onSelectProcess,
  onHoverStart,
  onHoverEnd,
}: {
  index: number
  processes: Array<{ id: string; name: string }>
  onSelectProcess: (processId: string) => void
  onHoverStart?: () => void
  onHoverEnd?: () => void
}) {
  const [open, setOpen] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleClose = () => {
    hideTimerRef.current = setTimeout(() => setOpen(false), 220)
  }
  const cancelClose = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
  }

  return (
    <>
      <Tooltip label="Add Experiment" position="left" withArrow>
        <ActionIcon
          size="md"
          variant="filled"
          color="grape"
          radius="xl"
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
            onHoverStart?.()
          }}
          onMouseLeave={() => {
            scheduleClose()
            onHoverEnd?.()
          }}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            e.stopPropagation()
            e.preventDefault()
            ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
          }}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          style={{
            position: "absolute",
            right: -44,
            top: 4 + index * 36,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            animation: "bubble-in 150ms ease-out",
            touchAction: "none",
          }}
        >
          <IconPlayerPlay size={16} />
        </ActionIcon>
      </Tooltip>

      {open && (
        <Paper
          shadow="md"
          p={6}
          radius="sm"
          onMouseEnter={() => {
            cancelClose()
            onHoverStart?.()
          }}
          onMouseLeave={() => {
            scheduleClose()
            onHoverEnd?.()
          }}
          style={{
            position: "absolute",
            right: -300,
            top: 4 + index * 36 - 2,
            zIndex: 210,
            minWidth: 245,
          }}
        >
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed">
              Create experiment from process
            </Text>
            {processes.length === 0 ? (
              <Text size="xs" c="dimmed">
                No process available yet.
              </Text>
            ) : (
              processes.map((p) => (
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
                    e.preventDefault()
                    setOpen(false)
                    onSelectProcess(p.id)
                  }}
                >
                  {p.name || p.id}
                </Button>
              ))
            )}
          </Stack>
        </Paper>
      )}
    </>
  )
}

function ResultsActionBubble({
  index,
  groupedExperiments,
  onSelectExperiment,
  onHoverStart,
  onHoverEnd,
}: {
  index: number
  groupedExperiments: Array<{
    processId: string
    processName: string
    experiments: Array<{ id: string; name: string; date: string }>
  }>
  onSelectExperiment: (experimentId: string) => void
  onHoverStart?: () => void
  onHoverEnd?: () => void
}) {
  const [open, setOpen] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleClose = () => {
    hideTimerRef.current = setTimeout(() => setOpen(false), 220)
  }
  const cancelClose = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
  }

  return (
    <>
      <Tooltip label="Add Results" position="left" withArrow>
        <ActionIcon
          size="md"
          variant="filled"
          color="orange"
          radius="xl"
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
            onHoverStart?.()
          }}
          onMouseLeave={() => {
            scheduleClose()
            onHoverEnd?.()
          }}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            e.stopPropagation()
            e.preventDefault()
            ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
          }}
          onClick={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          style={{
            position: "absolute",
            right: -44,
            top: 4 + index * 36,
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            animation: "bubble-in 150ms ease-out",
            touchAction: "none",
          }}
        >
          <IconDownload size={16} />
        </ActionIcon>
      </Tooltip>

      {open && (
        <Paper
          shadow="md"
          p={6}
          radius="sm"
          onMouseEnter={() => {
            cancelClose()
            onHoverStart?.()
          }}
          onMouseLeave={() => {
            scheduleClose()
            onHoverEnd?.()
          }}
          style={{
            position: "absolute",
            right: -360,
            top: 4 + index * 36 - 2,
            zIndex: 210,
            minWidth: 305,
            maxHeight: 320,
          }}
        >
          <Stack gap={4}>
            <Text size="xs" fw={600} c="dimmed">
              Upload results for experiment
            </Text>
            {groupedExperiments.length === 0 ? (
              <Text size="xs" c="dimmed">
                No experiment available yet.
              </Text>
            ) : (
              <ScrollArea h={260}>
                <Stack gap={6}>
                  {groupedExperiments.map((group) => (
                    <Stack key={group.processId} gap={4}>
                      <Text size="xs" fw={600} c="gray.7">
                        {group.processName}
                      </Text>
                      {group.experiments.map((exp) => (
                        <Button
                          key={exp.id}
                          size="compact-xs"
                          variant="subtle"
                          color="orange"
                          styles={{
                            inner: { justifyContent: "space-between" },
                          }}
                          onPointerDown={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            e.preventDefault()
                            setOpen(false)
                            onSelectExperiment(exp.id)
                          }}
                        >
                          <span>{exp.name || exp.id}</span>
                          <span style={{ opacity: 0.7 }}>
                            {exp.date || "-"}
                          </span>
                        </Button>
                      ))}
                      <Divider />
                    </Stack>
                  ))}
                </Stack>
              </ScrollArea>
            )}
          </Stack>
        </Paper>
      )}
    </>
  )
}

function CollectionEl({
  el,
  planeId,
  onUpdate,
  onDelete,
  pan,
  isFuseCandidate,
  onDragPositionUpdate,
  onDropped,
  onDropRefs,
  onStartDivide,
  onHoveredPlaneTabChange,
}: {
  el: CanvasCollectionElement
  planeId: string
  onUpdate: (e: CanvasElement) => void
  onDelete: () => void
  pan: Vec2
  isFuseCandidate: boolean
  onDragPositionUpdate: (pos: Vec2) => void
  onDropped: (
    srcId: string,
    finalPos: Vec2,
    originPos: Vec2,
    didMove: boolean,
    droppedOnPlaneId?: string,
  ) => void
  onDropRefs: (
    targetCollectionId: string,
    payload: CollectionRefDragPayload,
    isCopy: boolean,
  ) => void
  onStartDivide: () => void
  onHoveredPlaneTabChange?: (planeId: string | null) => void
}) {
  const {
    activeCollectionId,
    materials,
    solutions,
    processes,
    experiments,
    results,
    setActiveCollectionId,
    setActivePlaneId,
    setActiveEntity,
    setPendingCollectionLink,
  } = useAppContext()
  const navigate = useNavigate()
  const [dragging, setDragging] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameBuffer, setNameBuffer] = useState(el.name)
  const dragStart = useRef<{ mouse: Vec2; origin: Vec2 } | null>(null)
  /** Screen-space position of the element while dragging (for fixed overlay) */
  const [dragScreenPos, setDragScreenPos] = useState<Vec2 | null>(null)
  const [hoveredRefKind, setHoveredRefKind] = useState<
    CollectionRef["kind"] | null
  >(null)
  const [isHovered, setIsHovered] = useState(false)
  const hoverHideTimeoutRef = useRef<number | null>(null)
  const finalPosRef = useRef<Vec2>(el.position)
  const didMove = useRef(false)
  const lastPointerEvent = useRef<{ clientX: number; clientY: number } | null>(
    null,
  )
  const isActive = activeCollectionId === el.id
  const showCollectionControls = isActive || isHovered

  // Drag-over state for showing drop zones
  const [isDragOver, setIsDragOver] = useState(false)
  const [dropZoneHovered, setDropZoneHovered] = useState<
    "copy" | "move" | null
  >(null)
  const dragOverPayloadRef = useRef<CollectionRefDragPayload | null>(null)

  const parseRefDragPayload = (
    e: ReactDragEvent<HTMLElement>,
  ): CollectionRefDragPayload | null => {
    const raw =
      e.dataTransfer.getData(COLLECTION_REF_DRAG_MIME) ||
      e.dataTransfer.getData("text/plain")
    if (!raw) {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as CollectionRefDragPayload
      if (
        !parsed ||
        typeof parsed.sourceCollectionId !== "string" ||
        typeof parsed.kind !== "string" ||
        !Array.isArray(parsed.refIds)
      ) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

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

  const clearHoverHideTimeout = () => {
    if (hoverHideTimeoutRef.current !== null) {
      window.clearTimeout(hoverHideTimeoutRef.current)
      hoverHideTimeoutRef.current = null
    }
  }

  const activateHover = () => {
    clearHoverHideTimeout()
    setIsHovered(true)
  }

  const scheduleHoverHide = () => {
    clearHoverHideTimeout()
    hoverHideTimeoutRef.current = window.setTimeout(() => {
      setIsHovered(false)
      setHoveredRefKind(null)
    }, 320)
  }

  useEffect(() => () => clearHoverHideTimeout(), [clearHoverHideTimeout])

  const startDrag = (ev: ReactPointerEvent<HTMLDivElement>) => {
    setDragging(true)
    didMove.current = false
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
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
      didMove.current = true
    }
    const newPos = {
      x: snapToGrid(dragStart.current.origin.x + dx),
      y: snapToGrid(dragStart.current.origin.y + dy),
    }
    finalPosRef.current = newPos
    lastPointerEvent.current = { clientX: ev.clientX, clientY: ev.clientY }
    // Track screen position for the fixed-position drag overlay
    setDragScreenPos({ x: ev.clientX - 70, y: ev.clientY - 20 })
    onDragPositionUpdate(newPos)
    onUpdate({ ...el, position: newPos })
    // Detect hovered plane tab for animation.
    // elementsFromPoint (plural) is needed because the dragged card itself
    // sits on top at z-index 10000 and would be the only hit for the
    // single-element variant.
    if (onHoveredPlaneTabChange) {
      const hits = document.elementsFromPoint(ev.clientX, ev.clientY)
      let foundTabId: string | null = null
      for (const hit of hits) {
        const tabEl = (hit as HTMLElement).closest?.(
          "[data-plane-tab-id]",
        ) as HTMLElement | null
        if (tabEl) {
          foundTabId = tabEl.dataset.planeTabId ?? null
          break
        }
      }
      onHoveredPlaneTabChange(foundTabId)
    }
  }

  const stopDrag = () => {
    const origin = dragStart.current?.origin ?? el.position
    // Detect if dropped on a plane tab.
    // Use elementsFromPoint (plural) to see through the dragged card overlay.
    let droppedOnPlaneId: string | undefined
    if (lastPointerEvent.current) {
      const hits = document.elementsFromPoint(
        lastPointerEvent.current.clientX,
        lastPointerEvent.current.clientY,
      )
      for (const hit of hits) {
        const planeTab = (hit as HTMLElement).closest?.(
          "[data-plane-tab-id]",
        ) as HTMLElement | null
        if (planeTab) {
          droppedOnPlaneId = planeTab.dataset.planeTabId
          break
        }
      }
    }
    onDropped(
      el.id,
      finalPosRef.current,
      origin,
      didMove.current,
      droppedOnPlaneId,
    )
    setDragging(false)
    setDragScreenPos(null)
    dragStart.current = null
    lastPointerEvent.current = null
    onHoveredPlaneTabChange?.(null)
  }

  const commitName = () => {
    onUpdate({ ...el, name: nameBuffer.trim() || el.name })
    setEditingName(false)
  }

  // Count refs by type
  const refCounts = el.refs.reduce<Record<string, number>>((acc, r) => {
    acc[r.kind] = (acc[r.kind] || 0) + 1
    return acc
  }, {})

  // const hasExperiment = el.refs.some((r) => r.kind === "experiment")

  // Build action bubbles - icons must match nav menu (AppLayout.icons.tsx)
  const routeForKind: Record<CollectionRef["kind"], string> = {
    material: "/materials",
    solution: "/solutions",
    experiment: "/experiments",
    process: "/processes",
    result: "/results",
    analysis: "/analysis",
  }

  const handleBubbleClick = (
    kind: CollectionRef["kind"],
    materialCategory?: MaterialCategory,
  ) => {
    setPendingCollectionLink({
      collectionId: el.id,
      planeId,
      kind,
      materialCategory,
      requestId: crypto.randomUUID(),
    })
    navigate({ to: routeForKind[kind] })
  }

  const handleAddExperimentFromProcess = (processId: string) => {
    setPendingCollectionLink({
      collectionId: el.id,
      planeId,
      kind: "experiment",
      selectedProcessId: processId,
      requestId: crypto.randomUUID(),
    })
    navigate({ to: routeForKind.experiment })
  }

  const handleAddResultsForExperiment = (experimentId: string) => {
    setPendingCollectionLink({
      collectionId: el.id,
      planeId,
      kind: "result",
      selectedExperimentId: experimentId,
      requestId: crypto.randomUUID(),
    })
    navigate({ to: routeForKind.result })
  }

  const handleRefIconClick = (kind: CollectionRef["kind"]) => {
    setActiveCollectionId(el.id)
    setActivePlaneId(planeId)
    navigate({ to: routeForKind[kind] })
  }

  const handleRefItemClick = (kind: CollectionRef["kind"], id: string) => {
    setActiveCollectionId(el.id)
    setActivePlaneId(planeId)
    if (
      kind === "material" ||
      kind === "solution" ||
      kind === "process" ||
      kind === "experiment"
    ) {
      setActiveEntity({ kind, id })
    }
    navigate({ to: routeForKind[kind] })
  }

  const labelForRef = (kind: CollectionRef["kind"], id: string) => {
    if (kind === "material") {
      const m = materials.find((x) => x.id === id)
      return m ? m.name || m.inventoryLabel || m.casNumber || m.id : id
    }
    if (kind === "solution") {
      const s = solutions.find((x) => x.id === id)
      return s ? s.name || s.id : id
    }
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
      if (!r) {
        return id
      }
      const exp = experiments.find((x) => x.id === r.experimentId)
      return `Results for experiment ${exp ? exp.name || exp.id : r.experimentId}`
    }
    return id
  }

  const nonMaterialActions: {
    label: string
    Icon: React.ElementType
    color: string
    kind: CollectionRef["kind"]
  }[] = [
    { label: "Add Solution", Icon: IconFlask, color: "blue", kind: "solution" },
    { label: "Add Process", Icon: IconStack3, color: "gray", kind: "process" },
  ]

  const processOptions = [...processes]
    .map((p) => ({ id: p.id, name: p.name || p.id }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const groupedExperiments = [...experiments]
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
      if (existing) {
        existing.experiments.push(payload)
      } else {
        acc.push({ processId, processName, experiments: [payload] })
      }
      return acc
    }, [])
    .sort((a, b) => a.processName.localeCompare(b.processName))

  // When dragging, render using fixed positioning so the element appears above
  // the toolbar and plane tabs instead of being clipped by overflow:hidden.
  const boxStyle: React.CSSProperties =
    dragging && dragScreenPos
      ? {
          position: "fixed",
          left: dragScreenPos.x,
          top: dragScreenPos.y,
          cursor: "grabbing",
          userSelect: "none",
          zIndex: 10000,
          pointerEvents: "auto",
        }
      : {
          position: "absolute",
          left: el.position.x + pan.x,
          top: el.position.y + pan.y,
          cursor: "pointer",
          userSelect: "none",
        }

  return (
    <Box
      style={boxStyle}
      onPointerDown={startDrag}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onDragOver={(e) => {
        const payload = parseRefDragPayload(e)
        if (!payload || payload.sourceCollectionId === el.id) {
          setIsDragOver(false)
          dragOverPayloadRef.current = null
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = dropZoneHovered === "copy" ? "copy" : "move"
        setIsDragOver(true)
        dragOverPayloadRef.current = payload
      }}
      onDragLeave={(e) => {
        // Only clear if we're actually leaving the collection (not entering a child)
        const relatedTarget = e.relatedTarget as HTMLElement | null
        if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
          setIsDragOver(false)
          setDropZoneHovered(null)
          dragOverPayloadRef.current = null
        }
      }}
      onDrop={(e) => {
        const payload = parseRefDragPayload(e)
        if (!payload || payload.sourceCollectionId === el.id) {
          setIsDragOver(false)
          setDropZoneHovered(null)
          dragOverPayloadRef.current = null
          return
        }
        e.preventDefault()
        e.stopPropagation()

        // Only execute drop if user dropped on one of the drop zones
        if (dropZoneHovered) {
          onDropRefs(el.id, payload, dropZoneHovered === "copy")
        }

        // Reset state
        setIsDragOver(false)
        setDropZoneHovered(null)
        dragOverPayloadRef.current = null
      }}
      onMouseEnter={activateHover}
      onMouseLeave={scheduleHoverHide}
    >
      {/* Main card */}
      {isFuseCandidate && !isDragOver && (
        <Badge
          color="violet"
          variant="filled"
          size="sm"
          style={{
            position: "absolute",
            top: -14,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}
        >
          ⊕ Combine
        </Badge>
      )}
      <Paper
        withBorder
        shadow={isActive ? "md" : "xs"}
        p="xs"
        style={{
          width: 140,
          border: isDragOver
            ? "3px dashed var(--mantine-color-blue-5)"
            : isFuseCandidate
              ? "3px dashed var(--mantine-color-violet-6)"
              : `3px solid ${el.color || DEFAULT_ACCENT}`,
          background: isFuseCandidate
            ? "var(--mantine-color-violet-0)"
            : "var(--mantine-color-body)",
          outline: isActive
            ? `3px solid ${el.color || DEFAULT_ACCENT}`
            : "none",
          outlineOffset: 3,
          transition:
            "box-shadow 100ms ease, outline 100ms ease, border 120ms ease, background 120ms ease",
        }}
      >
        {/* Name */}
        {editingName ? (
          <TextInput
            size="xs"
            value={nameBuffer}
            autoFocus
            onChange={(e) => setNameBuffer(e.currentTarget.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitName()
              }
              if (e.key === "Escape") {
                setEditingName(false)
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <Text
            fw={600}
            size="sm"
            mb={4}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditingName(true)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            style={{ cursor: "text" }}
          >
            {el.name}
          </Text>
        )}

        {/* Compact ref summary - show icons for present entity types */}
        {el.refs.length > 0 ? (
          <Group gap={4} wrap="wrap">
            {(
              [
                {
                  kind: "material",
                  Icon: IconBox,
                  color: "var(--mantine-color-teal-6)",
                },
                {
                  kind: "solution",
                  Icon: IconFlask,
                  color: "var(--mantine-color-blue-6)",
                },
                {
                  kind: "process",
                  Icon: IconStack3,
                  color: "var(--mantine-color-gray-6)",
                },
                {
                  kind: "experiment",
                  Icon: IconPlayerPlay,
                  color: "var(--mantine-color-grape-6)",
                },
                {
                  kind: "result",
                  Icon: IconDownload,
                  color: "var(--mantine-color-orange-6)",
                },
                {
                  kind: "analysis",
                  Icon: IconChartBar,
                  color: "var(--mantine-color-red-6)",
                },
              ] as const
            )
              .filter(({ kind }) => Boolean(refCounts[kind]))
              .map(({ kind, Icon, color }) => {
                const count = refCounts[kind]
                const refs = el.refs.filter((r) => r.kind === kind)
                return (
                  <Popover
                    key={kind}
                    opened={hoveredRefKind === kind}
                    withinPortal={false}
                    position="bottom-start"
                    offset={6}
                    shadow="md"
                  >
                    <Popover.Target>
                      <Box
                        onMouseEnter={() => setHoveredRefKind(kind)}
                        onMouseLeave={() => setHoveredRefKind(null)}
                      >
                        <Stack gap={0} align="center">
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="gray"
                            radius="xl"
                            draggable
                            onClick={(e) => {
                              e.stopPropagation()
                              e.preventDefault()
                              handleRefIconClick(kind)
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            onDragStart={(e) =>
                              startRefDrag(e, {
                                sourceCollectionId: el.id,
                                kind,
                                mode: "kind",
                                refIds: refs.map((r) => r.id),
                              })
                            }
                          >
                            <Icon size={14} color={color} />
                          </ActionIcon>
                          <Text
                            size="8px"
                            c="dimmed"
                            style={{ lineHeight: 1, marginTop: -1 }}
                          >
                            {count}
                          </Text>
                        </Stack>
                      </Box>
                    </Popover.Target>
                    <Popover.Dropdown
                      p={6}
                      onMouseEnter={() => setHoveredRefKind(kind)}
                      onMouseLeave={() => setHoveredRefKind(null)}
                    >
                      <Stack gap={4}>
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
                                maxWidth: 200,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              },
                            }}
                            onClick={(e) => {
                              e.stopPropagation()
                              e.preventDefault()
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
                      </Stack>
                    </Popover.Dropdown>
                  </Popover>
                )
              })}
          </Group>
        ) : (
          <Text size="xs" c="dimmed">
            Empty
          </Text>
        )}

        {/* Drop zones - shown when dragging elements over this collection */}
        {isDragOver && dragOverPayloadRef.current && (
          <Stack
            gap={4}
            mt={8}
            style={{
              borderTop: "1px solid var(--mantine-color-gray-3)",
              paddingTop: 6,
            }}
          >
            <Box
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDropZoneHovered("copy")
              }}
              style={{
                padding: "4px 8px",
                borderRadius: 4,
                background:
                  dropZoneHovered === "copy"
                    ? "var(--mantine-color-blue-1)"
                    : "var(--mantine-color-gray-0)",
                border:
                  dropZoneHovered === "copy"
                    ? "2px solid var(--mantine-color-blue-5)"
                    : "1px dashed var(--mantine-color-gray-4)",
                cursor: "copy",
                transition: "all 150ms ease",
              }}
            >
              <Text
                size="xs"
                fw={dropZoneHovered === "copy" ? 600 : 400}
                c={dropZoneHovered === "copy" ? "blue" : "dimmed"}
                ta="center"
              >
                📋 Place Copy here...
              </Text>
            </Box>
            <Box
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setDropZoneHovered("move")
              }}
              style={{
                padding: "4px 8px",
                borderRadius: 4,
                background:
                  dropZoneHovered === "move"
                    ? "var(--mantine-color-green-1)"
                    : "var(--mantine-color-gray-0)",
                border:
                  dropZoneHovered === "move"
                    ? "2px solid var(--mantine-color-green-5)"
                    : "1px dashed var(--mantine-color-gray-4)",
                cursor: "move",
                transition: "all 150ms ease",
              }}
            >
              <Text
                size="xs"
                fw={dropZoneHovered === "move" ? 600 : 400}
                c={dropZoneHovered === "move" ? "green" : "dimmed"}
                ta="center"
              >
                ➡️ Move here...
              </Text>
            </Box>
          </Stack>
        )}
      </Paper>

      {/* Speech-bubble actions (only when selected) */}
      {showCollectionControls && (
        <>
          <MaterialActionBubble
            index={0}
            onSelect={(cat) => handleBubbleClick("material", cat)}
            onHoverStart={activateHover}
            onHoverEnd={scheduleHoverHide}
          />
          {nonMaterialActions.map((a, i) => (
            <ActionBubble
              key={a.kind}
              label={a.label}
              Icon={a.Icon}
              color={a.color}
              onClick={() => handleBubbleClick(a.kind)}
              index={i + 1}
              onHoverStart={activateHover}
              onHoverEnd={scheduleHoverHide}
            />
          ))}
          {processOptions.length > 0 && (
            <ExperimentActionBubble
              index={3}
              processes={processOptions}
              onSelectProcess={handleAddExperimentFromProcess}
              onHoverStart={activateHover}
              onHoverEnd={scheduleHoverHide}
            />
          )}
          {experiments.length > 0 && (
            <ResultsActionBubble
              index={processOptions.length > 0 ? 4 : 3}
              groupedExperiments={groupedExperiments}
              onSelectExperiment={handleAddResultsForExperiment}
              onHoverStart={activateHover}
              onHoverEnd={scheduleHoverHide}
            />
          )}
        </>
      )}

      {showCollectionControls && el.refs.length > 0 && (
        <Tooltip label="Divide collection" position="left" withArrow>
          <ActionIcon
            size="xs"
            variant="filled"
            color="violet"
            radius="xl"
            onPointerDown={(e) => {
              e.stopPropagation()
              e.preventDefault()
              onStartDivide()
            }}
            onMouseEnter={activateHover}
            onMouseLeave={scheduleHoverHide}
            style={{
              position: "absolute",
              top: -8,
              right: 16,
              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
            }}
          >
            <IconSeparatorVertical size={10} />
          </ActionIcon>
        </Tooltip>
      )}

      {/* Delete button (only when selected) */}
      {showCollectionControls && (
        <ActionIcon
          size="xs"
          variant="filled"
          color="red"
          radius="xl"
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
            onDelete()
          }}
          onMouseEnter={activateHover}
          onMouseLeave={scheduleHoverHide}
          style={{
            position: "absolute",
            top: -8,
            right: -8,
            boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
          }}
        >
          <IconX size={10} />
        </ActionIcon>
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
  material: { Icon: IconBox, color: "teal" },
  solution: { Icon: IconFlask, color: "blue" },
  experiment: { Icon: IconPlayerPlay, color: "grape" },
  process: { Icon: IconStack3, color: "gray" },
  result: { Icon: IconDownload, color: "orange" },
  analysis: { Icon: IconChartBar, color: "red" },
}

/** Helper to get name for a ref from context data */
function useRefName() {
  const { materials, solutions, experiments } = useAppContext()
  return useCallback(
    (ref: CollectionRef): string => {
      switch (ref.kind) {
        case "material":
          return (
            materials.find((m) => m.id === ref.id)?.name ||
            `Material ${ref.id.slice(0, 6)}`
          )
        case "solution":
          return (
            solutions.find((s) => s.id === ref.id)?.name ||
            `Solution ${ref.id.slice(0, 6)}`
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
    [materials, solutions, experiments],
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

type CanvasTool =
  | "pointer"
  | "select"
  | "text"
  | "plaintext"
  | "line"
  | "pen"
  | "rectangle"
  | "collection"

function PlaneCanvas({
  plane,
  onHoveredPlaneTabChange,
}: {
  plane: Plane
  onHoveredPlaneTabChange?: (id: string | null) => void
}) {
  const {
    materials,
    setMaterials,
    solutions,
    setSolutions,
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
    addLineElement,
    addCollectionElement,
    fuseCollections,
    updatePlane,
    setActiveCollectionId,
    activeCollectionId,
    planes,
    removeCollectionRefs,
    copyElementToPlane,
    moveElementToPlane,
  } = useAppContext()

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

  const [tool, setTool] = useState<CanvasTool>("pointer")
  // Element picker popup state for pointer tool
  const [elementPickerPos, setElementPickerPos] = useState<Vec2 | null>(null)
  const [elementPickerOpen, setElementPickerOpen] = useState(false)
  // Start with a real color – gray default is not available for new elements
  const [selectedColor, setSelectedColor] = useState<string>(PALETTE[0]) // sky blue
  // Plain text formatting options (default: black text in light mode, white in dark)
  const [textColor, setTextColor] = useState<string>(
    isDark ? "#ffffff" : "#000000",
  )
  const [textFormatting, setTextFormatting] = useState<TextFormatting>({
    bold: false,
    italic: false,
    underline: false,
  })
  const [editingPlaintextId, setEditingPlaintextId] = useState<string | null>(
    null,
  )
  const [activeDrawId, setActiveDrawId] = useState<string | null>(null)
  const [strokeWidth, setStrokeWidth] = useState<number>(2)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const drawingLineId = useRef<string | null>(null)
  const drawingKindRef = useRef<"line" | "pen" | "rectangle" | null>(null)
  const plaintextEditingRef = useRef(false)

  // ── Track color scheme changes to auto-invert plain text colors ─────────
  const prevSchemeRef = useRef(colorScheme)
  useEffect(() => {
    if (prevSchemeRef.current === colorScheme) return
    const nowDark = colorScheme === "dark"
    prevSchemeRef.current = colorScheme
    // Update toolbar default text color
    setTextColor((prev) => {
      if (nowDark && prev === "#000000") return "#ffffff"
      if (!nowDark && prev === "#ffffff") return "#000000"
      return prev
    })
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

  // srcId = dragged collection, dstId = collection being hovered over
  const [fuseCandidate, setFuseCandidate] = useState<{
    srcId: string
    dstId: string
  } | null>(null)
  const [fuseDialog, setFuseDialog] = useState<{
    src: CanvasCollectionElement
    dst: CanvasCollectionElement
  } | null>(null)
  const [fuseName, setFuseName] = useState("")
  const [fuseColor, setFuseColor] = useState(DEFAULT_ACCENT)
  // Keep ref so that handleDrop closure always reads current fuseCandidate
  const fuseCandidateRef = useRef(fuseCandidate)
  fuseCandidateRef.current = fuseCandidate

  const handleDragPositionUpdate = (srcId: string, pos: Vec2) => {
    const collections = plane.elements.filter(
      (e): e is CanvasCollectionElement =>
        e.type === "collection" && e.id !== srcId,
    )
    const target = collections.find((c) => collectionsOverlap(pos, c.position))
    setFuseCandidate(target ? { srcId, dstId: target.id } : null)
  }

  // ── Transfer-to-plane dialog state ──────────────────────────────────────
  const [transferDialog, setTransferDialog] = useState<{
    element: CanvasCollectionElement
    targetPlaneId: string
  } | null>(null)

  const handleDrop = (
    srcId: string,
    _finalPos: Vec2,
    originPos: Vec2,
    didMove: boolean,
    droppedOnPlaneId?: string,
  ) => {
    const candidate = fuseCandidateRef.current
    if (candidate && candidate.srcId === srcId) {
      const src = plane.elements.find((e) => e.id === srcId) as
        | CanvasCollectionElement
        | undefined
      const dst = plane.elements.find((e) => e.id === candidate.dstId) as
        | CanvasCollectionElement
        | undefined
      if (src && dst) {
        // Revert the dragged element back to where it started
        updateElement(plane.id, { ...src, position: originPos })
        setFuseName(`${src.name} + ${dst.name}`)
        setFuseColor(
          mixColors(src.color || DEFAULT_ACCENT, dst.color || DEFAULT_ACCENT),
        )
        setFuseDialog({ src: { ...src, position: originPos }, dst })
        setFuseCandidate(null)
        return
      }
    }
    setFuseCandidate(null)

    // If dropped on a different plane tab, offer copy/move
    if (droppedOnPlaneId && droppedOnPlaneId !== plane.id) {
      const src = plane.elements.find((e) => e.id === srcId) as
        | CanvasCollectionElement
        | undefined
      if (src) {
        // Snap back to original position
        updateElement(plane.id, { ...src, position: originPos })
        setTransferDialog({
          element: { ...src, position: originPos },
          targetPlaneId: droppedOnPlaneId,
        })
        return
      }
    }

    // If the element was dragged (moved) but didn't land on a collection or tab,
    // check if it was dragged out of the canvas bounds (e.g. onto toolbar) — snap back
    if (didMove && _finalPos.y < -40) {
      const src = plane.elements.find((e) => e.id === srcId) as
        | CanvasCollectionElement
        | undefined
      if (src) {
        updateElement(plane.id, { ...src, position: originPos })
        return
      }
    }

    if (!didMove) {
      setActiveCollectionId(activeCollectionId === srcId ? null : srcId)
    }
  }

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
          if (ref.kind === "material") {
            const original = materials.find((m) => m.id === ref.id)
            if (original) {
              const copied: Material = {
                ...original,
                id: crypto.randomUUID(),
              }
              setMaterials((prev) => [...prev, copied])
              newRefs.push({ kind: "material", id: copied.id })
            }
          } else if (ref.kind === "solution") {
            const original = solutions.find((s) => s.id === ref.id)
            if (original) {
              const copied: Solution = {
                ...original,
                id: crypto.randomUUID(),
                components: original.components.map((c) => ({
                  ...c,
                  id: crypto.randomUUID(),
                })),
              }
              setSolutions((prev) => [...prev, copied])
              newRefs.push({ kind: "solution", id: copied.id })
            }
          } else if (ref.kind === "experiment") {
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
          if (
            ref.kind === "material" ||
            ref.kind === "solution" ||
            ref.kind === "process"
          ) {
            const deps = getDependentLocations(ref.kind, ref.id, {
              solutions,
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
              if (r.kind === "material") {
                return materials.find((m) => m.id === r.id)?.name || r.id
              }
              if (r.kind === "solution") {
                return solutions.find((s) => s.id === r.id)?.name || r.id
              }
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
                elements: plane.elements.map((e) => {
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
            elements: plane.elements.map((e) => {
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
      materials,
      setMaterials,
      solutions,
      setSolutions,
      experiments,
      setExperiments,
      processes,
      setProcesses,
      results,
      setResults,
      planes,
    ],
  )

  const handleFuse = () => {
    if (!fuseDialog) {
      return
    }
    const { src, dst } = fuseDialog
    const mergedRefs = [...src.refs]
    for (const r of dst.refs) {
      if (!mergedRefs.some((m) => m.kind === r.kind && m.id === r.id)) {
        mergedRefs.push(r)
      }
    }
    const merged: CanvasCollectionElement = {
      id: crypto.randomUUID(),
      type: "collection",
      position: {
        x: snapToGrid((src.position.x + dst.position.x) / 2),
        y: snapToGrid((src.position.y + dst.position.y) / 2),
      },
      size: src.size,
      name: fuseName,
      color: fuseColor,
      refs: mergedRefs,
    }
    fuseCollections(plane.id, src.id, dst.id, merged)
    if (activeCollectionId === src.id || activeCollectionId === dst.id) {
      setActiveCollectionId(merged.id)
    }
    setFuseDialog(null)
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
    // Create left collection
    const leftCol: CanvasCollectionElement = {
      id: crypto.randomUUID(),
      type: "collection",
      position: { x: original.position.x - 80, y: original.position.y },
      size: original.size,
      name: leftName,
      color: original.color,
      refs: leftRefs,
    }
    // Create right collection
    const rightCol: CanvasCollectionElement = {
      id: crypto.randomUUID(),
      type: "collection",
      position: { x: original.position.x + 80, y: original.position.y },
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

  const getRefDisplayName = useCallback(
    (ref: CollectionRef): string => {
      if (ref.kind === "material") {
        const m = materials.find((x) => x.id === ref.id)
        return m ? m.name || m.inventoryLabel || m.casNumber || m.id : ref.id
      }
      if (ref.kind === "solution") {
        const s = solutions.find((x) => x.id === ref.id)
        return s ? s.name || s.id : ref.id
      }
      if (ref.kind === "process") {
        const p = processes.find((x) => x.id === ref.id)
        return p ? p.name || p.id : ref.id
      }
      if (ref.kind === "experiment") {
        const e = experiments.find((x) => x.id === ref.id)
        return e ? e.name || e.id : ref.id
      }
      if (ref.kind === "result") {
        const r = results.find((x) => x.id === ref.id)
        if (!r) {
          return ref.id
        }
        const exp = experiments.find((x) => x.id === r.experimentId)
        return `Results for ${exp ? exp.name || exp.id : r.experimentId}`
      }
      return `Analysis ${ref.id}`
    },
    [materials, solutions, processes, experiments, results],
  )

  const handleDeleteCollection = useCallback(
    (collection: CanvasCollectionElement) => {
      const dedup = new Map<string, CollectionRef>()
      for (const ref of collection.refs) {
        dedup.set(`${ref.kind}:${ref.id}`, ref)
      }
      const refs = [...dedup.values()]

      const plannedDelete: Record<CollectionRef["kind"], Set<string>> = {
        material: new Set(),
        solution: new Set(),
        experiment: new Set(),
        result: new Set(),
        analysis: new Set(),
        process: new Set(),
      }
      for (const ref of refs) {
        plannedDelete[ref.kind].add(ref.id)
      }

      const blocked: {
        ref: CollectionRef
        name: string
        dependents: ReturnType<typeof getDependentLocations>
      }[] = []

      for (const ref of refs) {
        if (
          ref.kind !== "material" &&
          ref.kind !== "solution" &&
          ref.kind !== "process" &&
          ref.kind !== "experiment"
        ) {
          continue
        }
        const dependents = getDependentLocations(ref.kind, ref.id, {
          solutions,
          experiments,
          processes,
          planes,
        }).filter((dep) => !plannedDelete[dep.itemKind].has(dep.itemId))
        if (dependents.length > 0) {
          blocked.push({
            ref,
            name: getRefDisplayName(ref),
            dependents,
          })
        }
      }

      if (blocked.length > 0) {
        modals.open({
          title: "Cannot delete collection",
          size: "lg",
          children: (
            <>
              <Text size="sm" mb="sm">
                This collection cannot be deleted because the following elements
                still have dependencies.
              </Text>
              <Table withTableBorder withColumnBorders>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Element</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Blocking Dependencies</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {blocked.map((b) => (
                    <Table.Tr key={`${b.ref.kind}:${b.ref.id}`}>
                      <Table.Td>{b.name}</Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" tt="capitalize">
                          {b.ref.kind}
                        </Text>
                      </Table.Td>
                      <Table.Td>{b.dependents.length}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          ),
        })
        return
      }

      // Delete empty collections immediately without confirmation
      if (refs.length === 0) {
        deleteElement(plane.id, collection.id)
        if (activeCollectionId === collection.id) {
          setActiveCollectionId(null)
        }
        return
      }

      modals.openConfirmModal({
        title: "Delete collection",
        size: "lg",
        children: (
          <>
            <Text size="sm" mb="sm">
              Deleting this collection will delete the following elements:
            </Text>
            {refs.length > 0 ? (
              <ScrollArea.Autosize mah={280}>
                <Table withTableBorder withColumnBorders>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Element</Table.Th>
                      <Table.Th>Type</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {refs.map((ref) => (
                      <Table.Tr key={`${ref.kind}:${ref.id}`}>
                        <Table.Td>{getRefDisplayName(ref)}</Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed" tt="capitalize">
                            {ref.kind}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea.Autosize>
            ) : (
              <Text size="sm" c="dimmed">
                This collection is empty.
              </Text>
            )}
          </>
        ),
        labels: { confirm: "Delete", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: () => {
          const idsByKind: Record<CollectionRef["kind"], Set<string>> = {
            material: new Set(),
            solution: new Set(),
            experiment: new Set(),
            result: new Set(),
            analysis: new Set(),
            process: new Set(),
          }

          for (const ref of refs) {
            idsByKind[ref.kind].add(ref.id)
          }

          if (idsByKind.material.size > 0) {
            const ids = [...idsByKind.material]
            setMaterials((prev) => prev.filter((m) => !ids.includes(m.id)))
            removeCollectionRefs("material", ids)
          }
          if (idsByKind.solution.size > 0) {
            const ids = [...idsByKind.solution]
            setSolutions((prev) => prev.filter((s) => !ids.includes(s.id)))
            removeCollectionRefs("solution", ids)
          }
          if (idsByKind.process.size > 0) {
            const ids = [...idsByKind.process]
            setProcesses((prev) => prev.filter((p) => !ids.includes(p.id)))
            removeCollectionRefs("process", ids)
          }
          if (idsByKind.experiment.size > 0) {
            const ids = [...idsByKind.experiment]
            setExperiments((prev) => prev.filter((e) => !ids.includes(e.id)))
            removeCollectionRefs("experiment", ids)
          }
          if (idsByKind.result.size > 0) {
            const ids = [...idsByKind.result]
            setResults((prev) => prev.filter((r) => !ids.includes(r.id)))
            removeCollectionRefs("result", ids)
          }
          if (idsByKind.analysis.size > 0) {
            removeCollectionRefs("analysis", [...idsByKind.analysis])
          }

          deleteElement(plane.id, collection.id)
          if (activeCollectionId === collection.id) {
            setActiveCollectionId(null)
          }
        },
      })
    },
    [
      deleteElement,
      experiments,
      getRefDisplayName,
      activeCollectionId,
      plane.id,
      planes,
      processes,
      removeCollectionRefs,
      setActiveCollectionId,
      setExperiments,
      setMaterials,
      setProcesses,
      setResults,
      setSolutions,
      solutions,
    ],
  )

  // Find active collection's color
  const activeCollection = plane.elements.find(
    (e) => e.id === activeCollectionId && e.type === "collection",
  ) as CanvasCollectionElement | undefined
  const accentColor = activeCollection?.color || DEFAULT_ACCENT
  // Pre-compute for element picker preview — avoids IIFE in JSX
  const pickerNextColor = nextCollectionColor()

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

  // ── Mouse position for pointer-tool tooltip ─────────────────────────────────
  const [mouseCanvasPos, setMouseCanvasPos] = useState<{
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceDown.current = e.type === "keydown"
      }
      // Close element picker on Escape
      if (e.code === "Escape" && e.type === "keydown") {
        setElementPickerOpen(false)
        setElementPickerPos(null)
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

  // ── Close element picker when tool changes ─────────────────────────────────
  useEffect(() => {
    if (tool !== "pointer") {
      setElementPickerOpen(false)
      setElementPickerPos(null)
    }
  }, [tool])

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
    // Middle mouse or Space+left = pan
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      isPanning.current = true
      panStart.current = {
        mouse: { x: e.clientX, y: e.clientY },
        origin: { ...pan },
      }
      e.preventDefault()
      return
    }
    if (e.button !== 0) {
      return
    }

    // clicking bare canvas background deselects active collection and pans
    if (tool === "select") {
      setActiveCollectionId(null)
      setActiveDrawId(null)
      if (e.target === e.currentTarget) {
        isPanning.current = true
        panStart.current = {
          mouse: { x: e.clientX, y: e.clientY },
          origin: { ...pan },
        }
        return
      }
    }

    // Pointer tool: Show element picker popup on bare canvas click, or close if already open
    if (tool === "pointer" && e.target === e.currentTarget) {
      // If a collection is selected, first click on empty canvas should only deselect it.
      if (activeCollectionId) {
        setActiveCollectionId(null)
        setElementPickerOpen(false)
        setElementPickerPos(null)
        return
      }

      // If popup is already open, close it and reopen at new position
      if (elementPickerOpen) {
        setElementPickerOpen(false)
        setElementPickerPos(null)
        // Small delay to allow position update before reopening
        setTimeout(() => {
          const rect = containerRef.current?.getBoundingClientRect()
          if (rect) {
            setElementPickerPos({
              x: e.clientX - rect.left,
              y: e.clientY - rect.top,
            })
            setElementPickerOpen(true)
          }
        }, 10)
        return
      }
      // Store screen position for popup placement
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        setElementPickerPos({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        })
        setElementPickerOpen(true)
      }
      return
    }

    // Close element picker when clicking on existing elements or switching away from pointer
    if (elementPickerOpen) {
      setElementPickerOpen(false)
      setElementPickerPos(null)
    }

    // For placement tools, only act on the bare canvas background - bail if clicking on an existing element
    const isPlacementTool =
      tool === "text" ||
      tool === "plaintext" ||
      tool === "collection" ||
      tool === "line" ||
      tool === "pen" ||
      tool === "rectangle"
    if (isPlacementTool && e.target !== e.currentTarget) {
      return
    }

    const pos = canvasCoords(e, containerRef, pan)

    if (tool === "text") {
      const el = addTextElement(plane.id, pos)
      updateElement(plane.id, {
        ...el,
        color: textColor,
        formatting: textFormatting,
      })
      setTool("select")
    } else if (tool === "plaintext") {
      // Don't place if currently editing another plaintext element
      if (plaintextEditingRef.current) {
        return
      }
      e.preventDefault() // prevent canvas from stealing focus from the auto-focused Textarea
      plaintextEditingRef.current = true // mark as editing (new element auto-focuses)
      const newEl = addPlainTextElement(
        plane.id,
        pos,
        textColor,
        textFormatting,
      )
      setEditingPlaintextId(newEl.id)
      // keep tool selected so formatting options stay visible
    } else if (tool === "collection") {
      const color = nextCollectionColor()
      const el = addCollectionElement(plane.id, pos)
      updateElement(plane.id, { ...el, color })
      setSelectedColor(color)
      setTool("select")
    } else if (tool === "line") {
      const el = addLineElement(plane.id, pos)
      updateElement(plane.id, {
        ...el,
        color: selectedColor,
        strokeWidth,
        kind: "line",
      } as CanvasLineElement)
      drawingLineId.current = el.id
      drawingKindRef.current = "line"
    } else if (tool === "pen") {
      const el = addLineElement(plane.id, pos)
      updateElement(plane.id, {
        ...el,
        points: [pos, pos],
        color: selectedColor,
        strokeWidth,
        kind: "pen",
      } as CanvasLineElement)
      drawingLineId.current = el.id
      drawingKindRef.current = "pen"
    } else if (tool === "rectangle") {
      const el = addLineElement(plane.id, pos)
      updateElement(plane.id, {
        ...el,
        points: [pos, pos],
        color: selectedColor,
        strokeWidth,
        kind: "rectangle",
      } as CanvasLineElement)
      drawingLineId.current = el.id
      drawingKindRef.current = "rectangle"
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

    // Auto-dismiss pointer element picker if cursor moves too far away.
    if (tool === "pointer" && elementPickerOpen && elementPickerPos) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        const dx = e.clientX - rect.left - elementPickerPos.x
        const dy = e.clientY - rect.top - elementPickerPos.y
        const dist = Math.hypot(dx, dy)
        if (dist > ELEMENT_PICKER_DISMISS_DISTANCE) {
          setElementPickerOpen(false)
          setElementPickerPos(null)
        }
      }
    }

    // Track position for pointer-tool tooltip
    if (tool === "pointer" && plane.elements.length === 0) {
      const rect = containerRef.current?.getBoundingClientRect()
      if (rect) {
        setMouseCanvasPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
      }
    } else if (mouseCanvasPos !== null) {
      setMouseCanvasPos(null)
    }
    if (
      (tool === "line" || tool === "pen" || tool === "rectangle") &&
      drawingLineId.current
    ) {
      const pos = canvasCoords(e, containerRef, pan)
      const existing = plane.elements.find(
        (el) => el.id === drawingLineId.current,
      ) as CanvasLineElement | undefined
      if (existing && existing.points.length >= 2) {
        let newPoints = [...existing.points]
        if (drawingKindRef.current === "pen") {
          const last = newPoints[newPoints.length - 1]
          if (!last || last.x !== pos.x || last.y !== pos.y) {
            newPoints = [...newPoints, pos]
          }
        } else {
          // Update the last point (the "live" end)
          newPoints[newPoints.length - 1] = pos
        }
        updateElement(plane.id, {
          ...existing,
          points: newPoints,
        } as CanvasLineElement)
      }
    }
  }

  const onMouseUp = (_e: MouseEvent<HTMLDivElement>) => {
    if (isPanning.current) {
      isPanning.current = false
      panStart.current = null
      return
    }
    if (
      (tool === "line" || tool === "pen" || tool === "rectangle") &&
      drawingLineId.current
    ) {
      // Finalize the drawn element.
      const finishedId = drawingLineId.current
      drawingLineId.current = null
      drawingKindRef.current = null
      setActiveDrawId(finishedId)
      setTool("select")
    }
  }

  const lines = plane.elements.filter(
    (e): e is CanvasLineElement => e.type === "line",
  )
  const nonLines = plane.elements.filter((e) => e.type !== "line")

  // Tool button styling using accent color
  const toolStyle = (t: CanvasTool) => ({
    background: tool === t ? accentColor : undefined,
    color: tool === t ? "white" : "var(--mantine-color-gray-6)",
  })

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Toolbar */}
      <Group
        gap="xs"
        px="sm"
        py={6}
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
          background: "var(--mantine-color-body)",
          flexShrink: 0,
        }}
      >
        <Tooltip
          label={
            plane.elements.length === 0
              ? "Click to place elements"
              : "Pointer tool"
          }
          position="bottom"
        >
          <ActionIcon
            variant={tool === "pointer" ? "filled" : "subtle"}
            style={toolStyle("pointer")}
            onClick={() => {
              setTool("pointer")
              setElementPickerOpen(false)
              setElementPickerPos(null)
            }}
          >
            <IconPointer size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Select / Pan (or hold Space)" position="bottom">
          <ActionIcon
            variant={tool === "select" ? "filled" : "subtle"}
            style={toolStyle("select")}
            onClick={() => setTool("select")}
          >
            <IconHandGrab size={18} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Add sticky note" position="bottom">
          <ActionIcon
            variant={tool === "text" ? "filled" : "subtle"}
            style={toolStyle("text")}
            onClick={() => setTool("text")}
          >
            <IconNote size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Add plain text" position="bottom">
          <ActionIcon
            variant={tool === "plaintext" ? "filled" : "subtle"}
            style={toolStyle("plaintext")}
            onClick={() => setTool("plaintext")}
          >
            <IconLetterT size={16} />
          </ActionIcon>
        </Tooltip>
        {/* Text formatting options (visible when text/plaintext tool selected) */}
        {(tool === "plaintext" || tool === "text") && (
          <>
            <Divider orientation="vertical" />
            <Tooltip label="Bold" position="bottom">
              <ActionIcon
                variant={textFormatting.bold ? "filled" : "subtle"}
                color={textFormatting.bold ? "blue" : "gray"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const newFormatting = {
                    ...textFormatting,
                    bold: !textFormatting.bold,
                  }
                  setTextFormatting(newFormatting)
                  if (editingPlaintextId) {
                    const el = plane.elements.find(
                      (e) => e.id === editingPlaintextId,
                    ) as CanvasPlainTextElement | undefined
                    if (el) {
                      updateElement(plane.id, {
                        ...el,
                        formatting: newFormatting,
                      })
                    }
                  } else if (editingTextId) {
                    const el = plane.elements.find(
                      (e) => e.id === editingTextId,
                    ) as CanvasTextElement | undefined
                    if (el) {
                      updateElement(plane.id, {
                        ...el,
                        formatting: newFormatting,
                      })
                    }
                  }
                }}
              >
                <IconBold size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Italic" position="bottom">
              <ActionIcon
                variant={textFormatting.italic ? "filled" : "subtle"}
                color={textFormatting.italic ? "blue" : "gray"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const newFormatting = {
                    ...textFormatting,
                    italic: !textFormatting.italic,
                  }
                  setTextFormatting(newFormatting)
                  if (editingPlaintextId) {
                    const el = plane.elements.find(
                      (e) => e.id === editingPlaintextId,
                    ) as CanvasPlainTextElement | undefined
                    if (el) {
                      updateElement(plane.id, {
                        ...el,
                        formatting: newFormatting,
                      })
                    }
                  } else if (editingTextId) {
                    const el = plane.elements.find(
                      (e) => e.id === editingTextId,
                    ) as CanvasTextElement | undefined
                    if (el) {
                      updateElement(plane.id, {
                        ...el,
                        formatting: newFormatting,
                      })
                    }
                  }
                }}
              >
                <IconItalic size={16} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Underline" position="bottom">
              <ActionIcon
                variant={textFormatting.underline ? "filled" : "subtle"}
                color={textFormatting.underline ? "blue" : "gray"}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const newFormatting = {
                    ...textFormatting,
                    underline: !textFormatting.underline,
                  }
                  setTextFormatting(newFormatting)
                  if (editingPlaintextId) {
                    const el = plane.elements.find(
                      (e) => e.id === editingPlaintextId,
                    ) as CanvasPlainTextElement | undefined
                    if (el) {
                      updateElement(plane.id, {
                        ...el,
                        formatting: newFormatting,
                      })
                    }
                  } else if (editingTextId) {
                    const el = plane.elements.find(
                      (e) => e.id === editingTextId,
                    ) as CanvasTextElement | undefined
                    if (el) {
                      updateElement(plane.id, {
                        ...el,
                        formatting: newFormatting,
                      })
                    }
                  }
                }}
              >
                <IconUnderline size={16} />
              </ActionIcon>
            </Tooltip>
            <Divider orientation="vertical" />
            {/* Text color picker */}
            <Popover withArrow shadow="md">
              <Popover.Target>
                <Tooltip label="Text color" position="bottom">
                  <ActionIcon variant="subtle" color="gray">
                    <ColorSwatch color={textColor} size={16} />
                  </ActionIcon>
                </Tooltip>
              </Popover.Target>
              <Popover.Dropdown p={6}>
                <Stack gap={6}>
                  <Text size="xs" c="dimmed">
                    Text color
                  </Text>
                  <Group gap={4} wrap="wrap" w={120}>
                    {/* Black + dark colors for text */}
                    {[
                      "#000000",
                      "#343a40",
                      "#495057",
                      "#868e96",
                      "#fa5252",
                      "#e64980",
                      "#be4bdb",
                      "#7950f2",
                      "#4c6ef5",
                      "#228be6",
                      "#15aabf",
                      "#12b886",
                      "#40c057",
                      "#82c91e",
                      "#fab005",
                      "#fd7e14",
                    ].map((c) => (
                      <ColorSwatch
                        key={c}
                        color={c}
                        size={24}
                        style={{
                          cursor: "pointer",
                          outline:
                            textColor === c
                              ? "2px solid var(--mantine-color-blue-5)"
                              : "none",
                          outlineOffset: 2,
                        }}
                        onClick={() => {
                          setTextColor(c)
                          if (editingPlaintextId) {
                            const el = plane.elements.find(
                              (e) => e.id === editingPlaintextId,
                            ) as CanvasPlainTextElement | undefined
                            if (el) {
                              updateElement(plane.id, {
                                ...el,
                                color: c,
                              })
                            }
                          } else if (editingTextId) {
                            const el = plane.elements.find(
                              (e) => e.id === editingTextId,
                            ) as CanvasTextElement | undefined
                            if (el) {
                              updateElement(plane.id, {
                                ...el,
                                color: c,
                              })
                            }
                          }
                        }}
                      />
                    ))}
                  </Group>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          </>
        )}
        <Tooltip label="Draw line (click start, click end)" position="bottom">
          <ActionIcon
            variant={tool === "line" ? "filled" : "subtle"}
            style={toolStyle("line")}
            onClick={() => setTool("line")}
          >
            <IconMinus size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Free draw" position="bottom">
          <ActionIcon
            variant={tool === "pen" ? "filled" : "subtle"}
            style={toolStyle("pen")}
            onClick={() => setTool("pen")}
          >
            <IconPencil size={16} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Draw rectangle" position="bottom">
          <ActionIcon
            variant={tool === "rectangle" ? "filled" : "subtle"}
            style={toolStyle("rectangle")}
            onClick={() => setTool("rectangle")}
          >
            <IconSquare size={16} />
          </ActionIcon>
        </Tooltip>

        {(tool === "line" || tool === "pen" || tool === "rectangle") && (
          <>
            <Divider orientation="vertical" />
            <Tooltip label="Line strength" position="bottom">
              <Group gap={4}>
                {[1, 2, 4, 6].map((w) => (
                  <ActionIcon
                    key={w}
                    variant={strokeWidth === w ? "filled" : "subtle"}
                    color={strokeWidth === w ? "blue" : "gray"}
                    onClick={() => {
                      setStrokeWidth(w)
                      if (activeDrawId) {
                        const active = plane.elements.find(
                          (e) => e.id === activeDrawId && e.type === "line",
                        ) as CanvasLineElement | undefined
                        if (active) {
                          updateElement(plane.id, { ...active, strokeWidth: w })
                        }
                      }
                    }}
                  >
                    <Text size="xs" fw={700}>
                      {w}
                    </Text>
                  </ActionIcon>
                ))}
              </Group>
            </Tooltip>
          </>
        )}
        <Tooltip label="Add Collection folder" position="bottom">
          <ActionIcon
            variant={tool === "collection" ? "filled" : "subtle"}
            style={toolStyle("collection")}
            onClick={() => setTool("collection")}
          >
            <IconFolderPlus size={16} />
          </ActionIcon>
        </Tooltip>
        <Divider orientation="vertical" />
        {/* Color picker — hidden when text tools are active (they have their own picker) */}
        {tool !== "text" && tool !== "plaintext" && (
          <Popover withArrow shadow="md">
            <Popover.Target>
              <Tooltip
                label={
                  activeCollection
                    ? "Change collection color"
                    : "Select color for new elements"
                }
                position="bottom"
              >
                <ActionIcon variant="subtle" color="gray">
                  <ColorSwatch
                    color={
                      activeCollection?.color ??
                      (tool === "collection" ? pickerNextColor : selectedColor)
                    }
                    size={16}
                  />
                </ActionIcon>
              </Tooltip>
            </Popover.Target>
            <Popover.Dropdown p={6}>
              <Group gap={4} wrap="wrap" w={160}>
                {PALETTE.map((c) => {
                  const isSelected = activeCollection
                    ? activeCollection.color === c
                    : selectedColor === c
                  return (
                    <ColorSwatch
                      key={c}
                      color={c}
                      size={24}
                      style={{
                        cursor: "pointer",
                        outline: isSelected
                          ? `2px solid ${accentColor}`
                          : "none",
                        outlineOffset: 2,
                      }}
                      onClick={() => {
                        if (activeCollection) {
                          updateElement(plane.id, {
                            ...activeCollection,
                            color: c,
                          })
                        } else {
                          setSelectedColor(c)
                        }
                      }}
                    />
                  )
                })}
              </Group>
            </Popover.Dropdown>
          </Popover>
        )}
        <Divider orientation="vertical" />
        <Text size="xs" c="dimmed">
          {tool === "pointer" &&
            (plane.elements.length === 0
              ? "Click to place elements"
              : "Click to place elements")}
          {tool === "select" &&
            "Select or drag to pan · Middle-mouse drag also pans"}
          {tool === "text" && "Click anywhere to place a sticky note"}
          {tool === "plaintext" &&
            "Click on empty canvas to place text · Double-click existing text to edit"}
          {tool === "line" && "Click to start line, move, click to end"}
          {tool === "collection" &&
            "Click anywhere to place a Collection folder"}
        </Text>
      </Group>

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
              cursor:
                tool === "select" || spaceDown.current
                  ? isPanning.current
                    ? "grabbing"
                    : "grab"
                  : tool === "pointer"
                    ? "default"
                    : "crosshair",
              backgroundImage: `radial-gradient(circle, ${isDark ? "var(--mantine-color-dark-4)" : "var(--mantine-color-gray-4)"} 1px, transparent 1px)`,
              backgroundSize: `${GRID}px ${GRID}px`,
              backgroundPosition: `${pan.x % GRID}px ${pan.y % GRID}px`,
            }}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={() => setMouseCanvasPos(null)}
          >
            {/* SVG line layer */}
            <LineOverlay
              lines={lines}
              pan={pan}
              canMove={tool === "select"}
              activeId={activeDrawId}
              setActiveId={setActiveDrawId}
              onUpdate={(el) => updateElement(plane.id, el)}
              onDelete={(id) => deleteElement(plane.id, id)}
            />

            {/* Element layer */}
            {nonLines.map((el) => {
              if (el.type === "text") {
                const tel = el as CanvasTextElement
                return (
                  <TextEl
                    key={el.id}
                    el={tel}
                    onUpdate={(updated) => updateElement(plane.id, updated)}
                    onDelete={() => deleteElement(plane.id, el.id)}
                    onStartEdit={() => {
                      setEditingTextId(tel.id)
                      setTool("text")
                      setTextColor(tel.color || "#000000")
                      setTextFormatting(
                        tel.formatting || {
                          bold: false,
                          italic: false,
                          underline: false,
                        },
                      )
                    }}
                    onEditEnd={() => {
                      setEditingTextId((prev) =>
                        prev === tel.id ? null : prev,
                      )
                      setTool("select")
                    }}
                    pan={pan}
                  />
                )
              }
              if (el.type === "plaintext") {
                const ptel = el as CanvasPlainTextElement
                return (
                  <PlainTextEl
                    key={el.id}
                    el={ptel}
                    onUpdate={(updated) => updateElement(plane.id, updated)}
                    onDelete={() => deleteElement(plane.id, el.id)}
                    onStartEdit={() => {
                      plaintextEditingRef.current = true
                      setEditingPlaintextId(ptel.id)
                      setTool("plaintext")
                      setTextColor(ptel.color)
                      setTextFormatting(ptel.formatting)
                    }}
                    onEditEnd={() => {
                      plaintextEditingRef.current = false
                      setEditingPlaintextId(null)
                      setTool("select")
                    }}
                    pan={pan}
                  />
                )
              }
              if (el.type === "collection") {
                return (
                  <CollectionEl
                    key={el.id}
                    el={el as CanvasCollectionElement}
                    planeId={plane.id}
                    onUpdate={(updated) => updateElement(plane.id, updated)}
                    onDelete={() =>
                      handleDeleteCollection(el as CanvasCollectionElement)
                    }
                    pan={pan}
                    isFuseCandidate={fuseCandidate?.dstId === el.id}
                    onDragPositionUpdate={(pos) =>
                      handleDragPositionUpdate(el.id, pos)
                    }
                    onDropped={handleDrop}
                    onDropRefs={handleDropRefs}
                    onStartDivide={() => {
                      handleStartDivide(el as CanvasCollectionElement)
                    }}
                    onHoveredPlaneTabChange={onHoveredPlaneTabChange}
                  />
                )
              }
              return null
            })}

            {/* Pointer-tool follow tooltip on empty plane */}
            {tool === "pointer" &&
              plane.elements.length === 0 &&
              mouseCanvasPos &&
              !elementPickerOpen && (
                <Box
                  style={{
                    position: "absolute",
                    left: mouseCanvasPos.x + 14,
                    top: mouseCanvasPos.y - 10,
                    background: "var(--mantine-color-dark-7)",
                    color: "white",
                    borderRadius: 6,
                    padding: "4px 10px",
                    fontSize: 12,
                    pointerEvents: "none",
                    userSelect: "none",
                    zIndex: 10000,
                    whiteSpace: "nowrap",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.2)",
                  }}
                >
                  Click to place items
                </Box>
              )}

            {/* Element Picker Popup for Pointer Tool */}
            {elementPickerOpen && elementPickerPos && (
              <Stack
                gap={6}
                style={{
                  position: "absolute",
                  left: elementPickerPos.x - 90,
                  top: elementPickerPos.y - 24,
                  zIndex: 10001,
                  cursor: "default",
                  animation: "bubble-in 150ms ease-out both",
                }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {/* ── Primary action: Add Data Collection ── */}
                <Tooltip label="Add Data Collection" position="top" withArrow>
                  <Box
                    onClick={(e) => {
                      e.stopPropagation()
                      e.preventDefault()
                      const pos = canvasCoords(
                        {
                          clientX:
                            (containerRef.current?.getBoundingClientRect()
                              .left || 0) + elementPickerPos.x,
                          clientY:
                            (containerRef.current?.getBoundingClientRect()
                              .top || 0) + elementPickerPos.y,
                        } as MouseEvent<HTMLDivElement>,
                        containerRef,
                        pan,
                      )
                      const color = nextCollectionColor()
                      const el = addCollectionElement(plane.id, pos)
                      updateElement(plane.id, { ...el, color })
                      setSelectedColor(color)
                      setElementPickerOpen(false)
                      setElementPickerPos(null)
                    }}
                    style={{
                      cursor: "pointer",
                      borderRadius: 10,
                      border: `2px solid ${pickerNextColor}`,
                      boxShadow: `0 0 0 3px ${pickerNextColor}33`,
                      background: "var(--mantine-color-body)",
                      padding: "10px 16px",
                      transition: "box-shadow 120ms",
                    }}
                  >
                    <Group gap={6}>
                      <IconFolderPlus size={16} color={pickerNextColor} />
                      <Text size="sm" fw={600}>
                        Add Data Collection
                      </Text>
                    </Group>
                  </Box>
                </Tooltip>

                {/* ── Secondary actions (muted) ── */}
                <Group gap={6} justify="center">
                  {(
                    [
                      {
                        label: "Place Note",
                        Icon: IconNote,
                        action: () => {
                          const pos = canvasCoords(
                            {
                              clientX:
                                (containerRef.current?.getBoundingClientRect()
                                  .left || 0) + elementPickerPos.x,
                              clientY:
                                (containerRef.current?.getBoundingClientRect()
                                  .top || 0) + elementPickerPos.y,
                            } as MouseEvent<HTMLDivElement>,
                            containerRef,
                            pan,
                          )
                          const el = addTextElement(plane.id, pos)
                          updateElement(plane.id, {
                            ...el,
                            color: textColor,
                            formatting: textFormatting,
                          })
                          setElementPickerOpen(false)
                          setElementPickerPos(null)
                          setTool("text")
                        },
                      },
                      {
                        label: "Place Text",
                        Icon: IconLetterT,
                        action: () => {
                          const pos = canvasCoords(
                            {
                              clientX:
                                (containerRef.current?.getBoundingClientRect()
                                  .left || 0) + elementPickerPos.x,
                              clientY:
                                (containerRef.current?.getBoundingClientRect()
                                  .top || 0) + elementPickerPos.y,
                            } as MouseEvent<HTMLDivElement>,
                            containerRef,
                            pan,
                          )
                          plaintextEditingRef.current = true
                          const newEl = addPlainTextElement(
                            plane.id,
                            pos,
                            textColor,
                            textFormatting,
                          )
                          setEditingPlaintextId(newEl.id)
                          setElementPickerOpen(false)
                          setElementPickerPos(null)
                          setTool("plaintext")
                        },
                      },
                      {
                        label: "Draw Line",
                        Icon: IconMinus,
                        action: () => {
                          const pos = canvasCoords(
                            {
                              clientX:
                                (containerRef.current?.getBoundingClientRect()
                                  .left || 0) + elementPickerPos.x,
                              clientY:
                                (containerRef.current?.getBoundingClientRect()
                                  .top || 0) + elementPickerPos.y,
                            } as MouseEvent<HTMLDivElement>,
                            containerRef,
                            pan,
                          )
                          const el = addLineElement(plane.id, pos)
                          updateElement(plane.id, {
                            ...el,
                            color: selectedColor,
                            strokeWidth,
                            kind: "line",
                          } as CanvasLineElement)
                          drawingLineId.current = el.id
                          drawingKindRef.current = "line"
                          setElementPickerOpen(false)
                          setElementPickerPos(null)
                          setTool("line")
                        },
                      },
                      {
                        label: "Free Draw",
                        Icon: IconPencil,
                        action: () => {
                          const pos = canvasCoords(
                            {
                              clientX:
                                (containerRef.current?.getBoundingClientRect()
                                  .left || 0) + elementPickerPos.x,
                              clientY:
                                (containerRef.current?.getBoundingClientRect()
                                  .top || 0) + elementPickerPos.y,
                            } as MouseEvent<HTMLDivElement>,
                            containerRef,
                            pan,
                          )
                          const el = addLineElement(plane.id, pos)
                          updateElement(plane.id, {
                            ...el,
                            points: [pos, pos],
                            color: selectedColor,
                            strokeWidth,
                            kind: "pen",
                          } as CanvasLineElement)
                          drawingLineId.current = el.id
                          drawingKindRef.current = "pen"
                          setElementPickerOpen(false)
                          setElementPickerPos(null)
                          setTool("pen")
                        },
                      },
                      {
                        label: "Draw Rectangle",
                        Icon: IconSquare,
                        action: () => {
                          const pos = canvasCoords(
                            {
                              clientX:
                                (containerRef.current?.getBoundingClientRect()
                                  .left || 0) + elementPickerPos.x,
                              clientY:
                                (containerRef.current?.getBoundingClientRect()
                                  .top || 0) + elementPickerPos.y,
                            } as MouseEvent<HTMLDivElement>,
                            containerRef,
                            pan,
                          )
                          const el = addLineElement(plane.id, pos)
                          updateElement(plane.id, {
                            ...el,
                            points: [pos, pos],
                            color: selectedColor,
                            strokeWidth,
                            kind: "rectangle",
                          } as CanvasLineElement)
                          drawingLineId.current = el.id
                          drawingKindRef.current = "rectangle"
                          setElementPickerOpen(false)
                          setElementPickerPos(null)
                          setTool("rectangle")
                        },
                      },
                    ] as const
                  ).map(({ label, Icon, action }, i) => (
                    <Tooltip
                      key={label}
                      label={label}
                      position="bottom"
                      withArrow
                    >
                      <ActionIcon
                        size="md"
                        variant="default"
                        color="gray"
                        radius="md"
                        onClick={(e) => {
                          e.stopPropagation()
                          e.preventDefault()
                          action()
                        }}
                        style={{
                          opacity: 0.55,
                          animation: `bubble-in 150ms ease-out ${i * 40 + 60}ms both`,
                          cursor: "default",
                          border: "1px solid var(--mantine-color-gray-3)",
                          background: "var(--mantine-color-gray-1)",
                        }}
                      >
                        <Icon size={16} />
                      </ActionIcon>
                    </Tooltip>
                  ))}
                </Group>
              </Stack>
            )}
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

      {/* ── Fusion dialog ─────────────────────────────────────────────────── */}
      <Modal
        opened={!!fuseDialog}
        onClose={() => setFuseDialog(null)}
        title="Combine Collections"
        size="sm"
        centered
      >
        {fuseDialog && (
          <Stack gap="md">
            <TextInput
              label="New collection name"
              value={fuseName}
              onChange={(e) => setFuseName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && fuseName.trim()) {
                  handleFuse()
                }
              }}
            />
            <div>
              <Text size="sm" fw={500} mb={6}>
                Color
              </Text>
              <Group gap={4} wrap="wrap">
                {PALETTE.map((c) => (
                  <ColorSwatch
                    key={c}
                    color={c}
                    size={24}
                    style={{
                      cursor: "pointer",
                      outline:
                        fuseColor === c
                          ? "2px solid var(--mantine-color-violet-6)"
                          : "none",
                      outlineOffset: 2,
                    }}
                    onClick={() => setFuseColor(c)}
                  />
                ))}
              </Group>
              <Group gap={8} mt={8} align="center">
                <ColorSwatch
                  color={fuseDialog.src.color || DEFAULT_ACCENT}
                  size={16}
                />
                <Text size="xs" c="dimmed">
                  +
                </Text>
                <ColorSwatch
                  color={fuseDialog.dst.color || DEFAULT_ACCENT}
                  size={16}
                />
                <Text size="xs" c="dimmed">
                  =
                </Text>
                <ColorSwatch color={fuseColor} size={16} />
              </Group>
            </div>
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => setFuseDialog(null)}>
                Cancel
              </Button>
              <Button onClick={handleFuse} disabled={!fuseName.trim()}>
                OK
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

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
}: {
  plane: Plane
  onRename: (name: string) => void
  onClose: () => void
  canClose: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [buf, setBuf] = useState(plane.name)

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
    <Group gap={4} wrap="nowrap">
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
  const { planes, addPlane, setActivePlaneId, setPlanes } = useAppContext()
  const { user } = useAuth()
  const [sharingPlaneId, setSharingPlaneId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery] = useDebouncedValue(searchQuery, 300)
  const [searchResults, setSearchResults] = useState<
    Array<{ id: string; email: string; full_name?: string | null }>
  >([])
  const [isSearching, setIsSearching] = useState(false)
  const [hoveredPlaneId, setHoveredPlaneId] = useState<string | null>(null)

  /** Count items referenced by collections on a given plane */
  const getPlaneItemCounts = (plane: Plane) => {
    const matIds = new Set<string>()
    const solIds = new Set<string>()
    const expIds = new Set<string>()
    for (const el of plane.elements) {
      if (el.type !== "collection") continue
      const col = el as CanvasCollectionElement
      for (const ref of col.refs) {
        if (ref.kind === "material") matIds.add(ref.id)
        else if (ref.kind === "solution") solIds.add(ref.id)
        else if (ref.kind === "experiment") expIds.add(ref.id)
      }
    }
    return {
      materials: matIds.size,
      solutions: solIds.size,
      experiments: expIds.size,
      collections: plane.elements.filter((e) => e.type === "collection").length,
    }
  }

  const handleAddPlane = () => {
    const p = addPlane(`Plane ${planes.length + 1}`, user?.id)
    setActivePlaneId(p.id)
  }

  const handleOpenShareModal = (planeId: string, e: MouseEvent) => {
    e.stopPropagation()
    setSharingPlaneId(planeId)
    setSearchQuery("")
    setSearchResults([])
  }

  const handleCloseShareModal = () => {
    setSharingPlaneId(null)
    setSearchQuery("")
    setSearchResults([])
  }

  const reloadPlanes = async () => {
    try {
      const response = await PlanesService.readPlanes({})
      if (response.data) {
        // Convert PlanePublic (API) to Plane (AppContext)
        const convertedPlanes = response.data.map((apiPlane) => {
          // Create ApiPlane compatible object for the converter
          const apiPlaneCompat = {
            id: apiPlane.id,
            name: apiPlane.name,
            owner_id: apiPlane.owner_id,
            created_at: apiPlane.created_at ?? null,
            elements: (apiPlane.elements ?? []).map((e) => ({
              id: e.id,
              element_type: e.element_type,
              x: e.x ?? 0,
              y: e.y ?? 0,
              width: e.width ?? 100,
              height: e.height ?? 100,
              content: e.content ?? null,
              color: e.color ?? null,
            })),
            shared_with:
              apiPlane.shared_with?.map((u) => ({
                id: u.id,
                email: u.email,
                full_name: u.full_name ?? null,
              })) ?? [],
          }
          return apiPlaneToPlane(apiPlaneCompat)
        })
        setPlanes(convertedPlanes)
      }
    } catch (error) {
      console.error("Failed to reload planes:", error)
    }
  }

  const handleShareWithUser = async (userId: string) => {
    if (!sharingPlaneId) return
    try {
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
      await PlanesService.unsharePlane({
        id: planeId,
        userId: userId,
      })
      await reloadPlanes()
    } catch (error) {
      console.error("Failed to remove share:", error)
    }
  }

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
        setSearchResults(users)
      })
      .catch((error) => {
        console.error("Failed to search users:", error)
        setSearchResults([])
      })
      .finally(() => {
        setIsSearching(false)
      })
  }, [debouncedQuery])

  const sharingPlane = planes.find((p) => p.id === sharingPlaneId)
  const isOwner = (plane: Plane) => {
    // Debug: Check if we have user and plane data
    console.log('[Share Debug]', {
      userId: user?.id,
      planeId: plane.id,
      planeName: plane.name,
      planeOwnerId: plane.ownerId,
      isOwner: plane.ownerId === user?.id,
      userExists: !!user,
    })
    return plane.ownerId === user?.id
  }
  const isShared = (plane: Plane) => (plane.sharedWith?.length ?? 0) > 0

  return (
    <Box p="xl">
      <Text size="xl" fw={700} mb="lg">
        Planes Overview & Data Sharing
      </Text>
      <Text size="sm" c="dimmed" mb="lg">
        Share planes with other users to grant full read and write access to all
        data and collections
      </Text>
      <Group gap="md" wrap="wrap" mb="lg">
        {planes.map((plane) => {
          const counts = getPlaneItemCounts(plane)
          const owner = isOwner(plane)
          const shared = isShared(plane)
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
              {/* Share icon - always visible for owners */}
              {/* Show if: owner, OR if user is logged in and plane has no ownerId (default owner) */}
              {(owner || (user && !plane.ownerId)) && (
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
              
              <Group justify="space-between" mb="xs" pr={owner ? 24 : 0}>
                <Text fw={600} size="md">
                  {plane.name}
                </Text>
                {shared && (
                  <Badge
                    size="xs"
                    color={owner ? "blue" : "green"}
                    variant="light"
                  >
                    {owner ? "Shared" : "Shared with me"}
                  </Badge>
                )}
                {!shared && owner && (
                  <Badge size="xs" color="gray" variant="light">
                    Private
                  </Badge>
                )}
              </Group>
              <Stack gap={4}>
                <Group gap={6}>
                  <IconBox size={14} color="var(--mantine-color-teal-6)" />
                  <Text size="xs" c="dimmed">
                    {counts.materials} material
                    {counts.materials !== 1 ? "s" : ""}
                  </Text>
                </Group>
                <Group gap={6}>
                  <IconFlask size={14} color="var(--mantine-color-blue-6)" />
                  <Text size="xs" c="dimmed">
                    {counts.solutions} solution
                    {counts.solutions !== 1 ? "s" : ""}
                  </Text>
                </Group>
                <Group gap={6}>
                  <IconPlayerPlay
                    size={14}
                    color="var(--mantine-color-grape-6)"
                  />
                  <Text size="xs" c="dimmed">
                    {counts.experiments} experiment
                    {counts.experiments !== 1 ? "s" : ""}
                  </Text>
                </Group>
                <Group gap={6}>
                  <IconFolderPlus
                    size={14}
                    color="var(--mantine-color-gray-6)"
                  />
                  <Text size="xs" c="dimmed">
                    {counts.collections} collection
                    {counts.collections !== 1 ? "s" : ""}
                  </Text>
                </Group>
              </Stack>
            </Paper>
          )
        })}
        {/* Add plane card */}
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
      </Group>

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

          {searchResults.length > 0 && (
            <Stack gap="xs">
              <Text size="xs" fw={600} c="dimmed">
                Search Results
              </Text>
              {searchResults.map((searchUser) => {
                const alreadyShared = sharingPlane?.sharedWith?.some(
                  (u) => u.id === searchUser.id,
                )
                return (
                  <Paper key={searchUser.id} p="xs" withBorder>
                    <Group justify="space-between">
                      <Stack gap={0}>
                        <Text size="sm">
                          {searchUser.full_name || "No name"}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {searchUser.email}
                        </Text>
                      </Stack>
                      {alreadyShared ? (
                        <Badge size="sm" color="green">
                          Shared
                        </Badge>
                      ) : (
                        <Button
                          size="xs"
                          onClick={() => handleShareWithUser(searchUser.id)}
                        >
                          Share
                        </Button>
                      )}
                    </Group>
                  </Paper>
                )
              })}
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

  const [hoveredPlaneTabId, setHoveredPlaneTabId] = useState<string | null>(
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
  }

  const handleDeletePlane = (id: string) => {
    if (planes.length <= 1) {
      return
    }
    modals.openConfirmModal({
      title: "Delete plane",
      children: <Text size="sm">Delete this plane and all its content?</Text>,
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        deletePlane(id)
        if (activePlaneId === id) {
          const remainingPlanes = planes.filter((plane) => plane.id !== id)
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
                    canClose={planes.length > 1}
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
              <PlaneCanvas
                plane={p}
                onHoveredPlaneTabChange={setHoveredPlaneTabId}
              />
            </Tabs.Panel>
          ))}
        </Box>
      </Tabs>
    </Box>
  )
}
