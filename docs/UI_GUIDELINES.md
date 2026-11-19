# Plains — UI Guidelines

This document describes the **actual** frontend UI architecture of Plains and the conventions
for adding or changing UI without breaking the existing visual identity. It is a reference for
agents and developers; it does not describe hypothetical APIs or components that do not exist.

> Source of truth for the non-regression and data-safety policy remains `AGENTS.md`. This guide
> only covers presentation and interaction conventions.

## 1. UI architecture

Plains intentionally runs **two coexisting UI systems**, split by application area:

| Area | Routes | Primary technology |
|---|---|---|
| Scientific GUI | `_gui` → `/organization`, `/processes`, `/experiments`, `/results`, `/analysis`, `/export`, `/trash` | **Mantine** (`@mantine/core`, `modals`, `notifications`, `dropzone`) |
| Authentication | `/login`, `/signup`, `/recover-password`, `/reset-password`, `/auth/nomad/callback` | **shadcn/ui + Tailwind CSS** |
| Administration & settings | `_layout` → `/settings`, `/admin` (and `/` which redirects to `/organization`) | **shadcn/ui + Tailwind CSS** |

Supporting libraries:

- **Scientific charts**: ECharts (`echarts-for-react`), themed by Mantine color scheme
  (`Analysis.page.tsx`).
- **Administrative tables**: TanStack Table via `components/Common/DataTable.tsx`.
- **Forms (admin/settings)**: `react-hook-form` + `zod` (shadcn convention).
- **Toasts (admin/settings)**: `sonner` via `components/ui/sonner.tsx` (global `<Toaster>` in
  `main.tsx`).
- **Toasts (scientific)**: Mantine `notifications.show(...)` via `<Notifications>` in `_gui.tsx`.
- **Modals/confirmations (scientific)**: Mantine `modals.openConfirmModal`.
- **Modals/confirmations (admin/settings)**: shadcn `Dialog` (`components/ui/dialog.tsx`).
- **Icons**: Tabler (`@tabler/icons-react`) in the scientific GUI; Lucide (`lucide-react`) in the
  shadcn area.

## 2. Why Mantine and shadcn coexist

- The scientific GUI (canvas, upload flow, modals, ECharts) was built on Mantine; migrating it
  would be high-risk with no functional benefit.
- The authentication/administration area was inherited from the FastAPI full-stack template and
  is built on shadcn/ui + Tailwind.

Both are coherent internally. The goal is to keep both, resolve only the **cross-cutting**
inconsistencies (theme, toasts), and never migrate one area to the other's library.

## 3. Which technology to use where

- New scientific screens or controls → **Mantine**, matching the existing `_gui` pages.
- New auth, settings or admin screens or controls → **shadcn/ui + Tailwind**, matching `_layout`.
- Do not mix Mantine and shadcn components within a single screen without a concrete, documented
  reason.
- Keep icons consistent with the area: Tabler in `_gui`, Lucide in `_layout`/auth.

## 4. Design tokens and themes

- **shadcn/Tailwind tokens** are defined in `frontend/src/index.css` (Tailwind v4, `@theme inline`,
  oklch variables). Primary is teal (`--primary: oklch(0.5982 0.10687 182.47)`); dark mode is
  driven by the `.dark` class on `<html>`.
- **Mantine theme** is `frontend/src/gui/theme.ts` (currently `createTheme({})`, Mantine default
  blue). Mantine uses its own `--mantine-color-*` variables, independent of the shadcn tokens.
- **Theme preference (shadcn area)**: `components/theme-provider.tsx` stores `vite-ui-theme`
  (`"light" | "dark" | "system"`) and toggles the `.dark`/`.light` class on `<html>`. `main.tsx`
  mounts it with `defaultTheme="dark"`. `components/Common/Appearance.tsx` exposes the toggle.
- **Theme preference (scientific area)**: Mantine's own color scheme
  (`useMantineColorScheme` / `toggleColorScheme` in `AppLayout.tsx`), persisted by Mantine's
  default `localStorageColorSchemeManager` under `mantine-color-scheme-value` (default `light`).

> **Known, intentionally deferred decision**: the two theme systems are not yet synchronized
> (they have different storage keys and different defaults). See the deferred item in
> `workbench/TODO.md`. Do **not** add a third theme library; do **not** use `forceColorScheme`
> to paper over this without resolving the default-theme product decision.

- Sonner toasts follow the shadcn theme via `components/ui/sonner.tsx` (`useTheme` from
  `components/theme-provider`).
- ECharts needs explicit dark/light chrome because it renders to canvas and cannot read CSS
  `light-dark()`. `Analysis.page.tsx` derives `isDark` from Mantine `useComputedColorScheme`.

## 5. Reusable components and their locations

- `src/components/ui/` — shadcn primitives (`button`, `dialog`, `dropdown-menu`, `tabs`, `table`,
  `sidebar`, `select`, `avatar`, `card`, `input`, `label`, `form`, `badge`, `tooltip`, `sonner`,
  `skeleton`, `pagination`, `loading-button`, …). Use these directly; do not re-wrap them.
- `src/components/Common/` — application-level shared pieces:
  - `PageHeader.tsx` — page title + description for the shadcn area.
  - `DataTable.tsx` — TanStack Table wrapper (pagination) for admin tables.
  - `Footer.tsx`, `Logo.tsx`, `AuthLayout.tsx`, `Appearance.tsx`, `ErrorComponent.tsx`,
    `NotFound.tsx`.
- `src/components/Admin/`, `src/components/UserSettings/`, `src/components/Pending/` — area-specific
  components (user management, settings, pending lists).
- `src/components/Sidebar/` — the shadcn `_layout` sidebar (`AppSidebar`, `Main`, `User`).

Before creating a new shared component, confirm it is a **real repeated pattern** (≥2 existing
consumers) and that no existing component already covers it.

## 6. Recommended patterns for new pages and controls

- **Page header (shadcn area)**: use `PageHeader` with `title` and optional `description`
  (see `routes/_layout/admin.tsx` and `routes/_layout/settings.tsx`).
- **Forms (shadcn area)**: `react-hook-form` + `zod`, `components/ui/form.tsx` (Form/Field),
  `Input`, `Label`, `LoadingButton` for submitting state. See `components/Admin/AddUser.tsx`,
  `components/UserSettings/ChangePassword.tsx`.
- **Forms (scientific area)**: Mantine `TextInput`, `NumberInput`, `Select`, `Modal`, local state
  (no `@mantine/form` is used today). Follow the existing page code.
- **Tables (shadcn area)**: `DataTable` with TanStack column defs (`components/Admin/columns.tsx`,
  `components/Admin/nomadUploadColumns.tsx`).
- **Tables (scientific area)**: Mantine `Table` (see `routes/Results.page.tsx`, `routes/Trash.page.tsx`).
- **Empty/loading (admin)**: `PendingUsers`/`PendingItems` as Suspense fallbacks; `Skeleton`
  (`components/ui/skeleton.tsx`) where appropriate.

## 7. Confirmation, notification and loading conventions

- **Destructive confirmations (scientific)**: Mantine `modals.openConfirmModal` with
  `confirmProps={{ color: "red" }}` and an explicit "This cannot be undone" message. See
  `routes/Trash.page.tsx` (`handlePurge`, `handleEmpty`).
- **Destructive confirmations (admin/settings)**: shadcn `Dialog` with a destructive
  `DropdownMenuItem`/button; see `components/Admin/DeleteUser.tsx`,
  `components/UserSettings/DeleteConfirmation.tsx`.
- **Success/error feedback (scientific)**: Mantine `notifications.show({ color, title, message })`.
- **Success/error feedback (admin/settings)**: sonner via `useCustomToast`
  (`showSuccessToast`/`showErrorToast` in `hooks/useCustomToast.ts`).
- **Saving/loading**: reuse `LoadingButton` (shadcn) or Mantine `Loader`/button `loading` state.
- Keep the same kind of operation consistent **within an area**. Cross-area differences between
  Mantine and shadcn are intentional; do not try to force a single global dialog/toast component.

## 8. How to avoid duplicated components or CSS

- Reuse `components/ui/*` and `components/Common/*` instead of inlining the same markup.
- Use Tailwind token classes (`text-muted-foreground`, `bg-card`, `border`, `rounded-*`) rather
  than hardcoded hex/oklch values in the shadcn area.
- In the Mantine area, use Mantine props (`c="dimmed"`, `color="red"`, `fw=`, `size=`) instead of
  inline `style` where the design already relies on Mantine tokens.
- If you find the same visual block repeated three or more times in one area, prefer extracting a
  small `components/Common/*` component over copy-paste — but only when behavior is identical.

## 9. Accessibility expectations

- Keep labels on form controls (`components/ui/form.tsx` already wires `FormLabel`/`aria`).
- Keep icon-only buttons labelled (`aria-label`), as done in `AppLayout.tsx` (sidebar `ActionIcon`s)
  and the `_layout` sidebar.
- Preserve keyboard/focus behavior of the underlying Radix (shadcn) and Mantine components.
- Maintain color contrast via the existing semantic tokens rather than inventing new colors.
- Respect the React + Mantine Strict Mode patterns documented in `AGENTS.md` (stable ref callbacks,
  one-directional state sync, no inline ref arrows).

## 10. Examples (actual source)

- Page header: `frontend/src/routes/_layout/admin.tsx`, `frontend/src/routes/_layout/settings.tsx`
  using `frontend/src/components/Common/PageHeader.tsx`.
- Theme provider + toggle: `frontend/src/components/theme-provider.tsx`,
  `frontend/src/components/Common/Appearance.tsx`.
- Sonner theme wiring: `frontend/src/components/ui/sonner.tsx`.
- Scientific layout/navigation: `frontend/src/components/AppLayout.tsx`,
  `frontend/src/components/AppLayout.icons.tsx`.
- Scientific charts + dark chrome: `frontend/src/routes/Analysis.page.tsx`.
- Admin table: `frontend/src/components/Common/DataTable.tsx` + `components/Admin/columns.tsx`.
