/**
 * Free-field packing for the Organization canvas grid.
 *
 * Extracted from `Organization.page.tsx` so the Trash restore/shift flows can
 * reuse the exact same placement logic when they drop restored items onto a
 * plane's free cells (see AppContext `restoreTrash`).
 */

import type { CanvasElement, Vec2 } from "../store/AppContext"

// Chessboard grid cell dimensions (px).
//
// These two constants are the ONLY place the abstract chessboard is mapped to
// pixels: an element's identity on the board is its (col,row) cell and its
// (spanCols,spanRows) footprint, and every stored position/size must be an
// exact multiple of the cell dimensions (`cellToPx` of some cell). Rendering
// may add visual niceties (gaps, pan), but positions themselves never leave
// the lattice — that is what lets a later change of CELL_W/CELL_H (e.g. for
// other screen sizes) rescale the whole board by converting through
// `pxToCell`/`cellToPx` without breaking the layout.
export const CELL_W = 200
export const CELL_H = 180

/** Abstract board coordinate of the cell containing (or nearest to) `p`. */
export function pxToCell(p: Vec2): { col: number; row: number } {
  return { col: Math.round(p.x / CELL_W), row: Math.round(p.y / CELL_H) }
}

/** Pixel origin (top-left corner) of an abstract board cell. */
export function cellToPx(col: number, row: number): Vec2 {
  return { x: col * CELL_W, y: row * CELL_H }
}

/** Snap a free position onto the nearest cell corner (never inside a cell). */
export function snapPosToCell(p: Vec2): Vec2 {
  const { col, row } = pxToCell(p)
  return cellToPx(Math.max(0, col), Math.max(0, row))
}

/** Quantize a size to whole cells (at least 1×1) — widths/heights are always
 *  a whole number of chess fields. */
export function snapSizeToCells(size: Vec2): Vec2 {
  return {
    x: Math.max(1, Math.round(size.x / CELL_W)) * CELL_W,
    y: Math.max(1, Math.round(size.y / CELL_H)) * CELL_H,
  }
}

/**
 * Force a canvas element onto the board lattice: origin on a cell corner,
 * size a whole number of cells. Lines are free-form and pass through
 * untouched. Returns the same object when nothing had to change, so callers
 * can use identity to skip redundant state updates.
 */
export function normalizeGridElement(el: CanvasElement): CanvasElement {
  if (el.type === "line") return el
  const sized = el as CanvasElement & { position: Vec2; size?: Vec2 }
  const position = snapPosToCell(sized.position)
  const size = sized.size ? snapSizeToCells(sized.size) : undefined
  const positionChanged =
    position.x !== sized.position.x || position.y !== sized.position.y
  const sizeChanged =
    size !== undefined &&
    sized.size !== undefined &&
    (size.x !== sized.size.x || size.y !== sized.size.y)
  if (!positionChanged && !sizeChanged) return el
  return {
    ...sized,
    position: positionChanged ? position : sized.position,
    ...(sizeChanged ? { size } : {}),
  } as CanvasElement
}

/** Normalize every element of a plane; returns the same array when unchanged. */
export function normalizePlaneElements(
  elements: CanvasElement[],
): CanvasElement[] {
  let changed = false
  const next = elements.map((el) => {
    const normalized = normalizeGridElement(el)
    if (normalized !== el) changed = true
    return normalized
  })
  return changed ? next : elements
}

/** Grid-cell key ("col,row") for a snapped element position. */
export function cellKeyForPos(p: Vec2): string {
  return `${Math.round(p.x / CELL_W)},${Math.round(p.y / CELL_H)}`
}

/**
 * Every grid cell covered by positioned elements (collections / text / notes),
 * excluding the given ids. Multi-cell elements reserve their full span.
 */
export function occupiedCellKeys(
  elements: CanvasElement[],
  excludeIds: string[],
): Set<string> {
  const occ = new Set<string>()
  for (const el of elements) {
    if (el.type === "line" || excludeIds.includes(el.id)) continue
    const sized = el as { position: Vec2; size?: Vec2 }
    const col0 = Math.round(sized.position.x / CELL_W)
    const row0 = Math.round(sized.position.y / CELL_H)
    const colSpan = Math.max(1, Math.round((sized.size?.x ?? CELL_W) / CELL_W))
    const rowSpan = Math.max(1, Math.round((sized.size?.y ?? CELL_H) / CELL_H))
    for (let r = 0; r < rowSpan; r++) {
      for (let c = 0; c < colSpan; c++) occ.add(`${col0 + c},${row0 + r}`)
    }
  }
  return occ
}

/**
 * True when a `spanCols × spanRows` footprint anchored at (col,row) is fully
 * on-grid and clear of every occupied cell in `occ`.
 */
export function spanFits(
  occ: Set<string>,
  col: number,
  row: number,
  spanCols: number,
  spanRows: number,
): boolean {
  if (col < 0 || row < 0) return false
  for (let r = 0; r < spanRows; r++) {
    for (let c = 0; c < spanCols; c++) {
      if (occ.has(`${col + c},${row + r}`)) return false
    }
  }
  return true
}

/**
 * First cell (reading order, wrapping at `maxCols`) where a `spanCols × spanRows`
 * footprint fits among `elements`. Used to land an element on a plane without
 * overlapping existing content.
 */
export function firstFreeSpanCell(
  elements: CanvasElement[],
  spanCols: number,
  spanRows: number,
  maxCols: number,
): Vec2 {
  const occ = occupiedCellKeys(elements, [])
  const cols = Math.max(maxCols, spanCols)
  for (let row = 0; row < 5000; row++) {
    for (let col = 0; col + spanCols <= cols; col++) {
      if (spanFits(occ, col, row, spanCols, spanRows)) {
        return { x: col * CELL_W, y: row * CELL_H }
      }
    }
  }
  return { x: 0, y: 0 }
}

/**
 * Return `preferred` if its cell is free, otherwise the next free cell in
 * reading order (left→right, top→bottom). Reserves the chosen cell in
 * `occupied` so consecutive calls never collide.
 */
export function nextFreeCell(
  occupied: Set<string>,
  preferred: Vec2,
  maxCols: number,
): Vec2 {
  const pref = { x: Math.max(0, preferred.x), y: Math.max(0, preferred.y) }
  const prefKey = cellKeyForPos(pref)
  if (!occupied.has(prefKey)) {
    occupied.add(prefKey)
    return pref
  }
  for (let row = 0; row < 5000; row++) {
    for (let col = 0; col < maxCols; col++) {
      const key = `${col},${row}`
      if (!occupied.has(key)) {
        occupied.add(key)
        return { x: col * CELL_W, y: row * CELL_H }
      }
    }
  }
  occupied.add(prefKey)
  return pref
}
