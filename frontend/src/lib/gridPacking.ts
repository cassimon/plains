/**
 * Free-field packing for the Organization canvas grid.
 *
 * Extracted from `Organization.page.tsx` so the Trash restore/shift flows can
 * reuse the exact same placement logic when they drop restored items onto a
 * plane's free cells (see AppContext `restoreTrash`).
 */

import type { CanvasElement, Vec2 } from "../store/AppContext"

// Chessboard grid cell dimensions (px).
export const CELL_W = 200
export const CELL_H = 180

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
