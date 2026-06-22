# Task 1: Refactor Code & File Structure

## Rule
Do NOT change any application functionality. Refactor only — structure, naming, dead code, stale docs.

## Objective
Clean up the repository by removing stale planning documents, reorganising files where structure has drifted from current reality, and applying minor code-quality improvements that carry no behaviour change.

## Scope

### 1. Delete stale `.md` planning files
The following files describe plans or states that no longer reflect the codebase and should be deleted:

| File | Reason |
|------|--------|
| `EXPORT_IMPROVEMENT_PLAN.md` | Implementation plan, presumably done |
| `IMPLEMENTATION_COMPLETE.md` | Status document, no ongoing value |
| `PATH_ROUTING_PLAN.md` | Routing was refactored; plan is stale |
| `PLANE_SHARING_IMPLEMENTATION.md` | Feature implemented; plan obsolete |
| `datastructure.md` | Superseded by `datastructure_simplified.md` and actual models |
| `datastructure_simplified.md` | Data model now lives in `backend/app/models.py`; doc is out of date |
| `playwright_testing.md` | Will be replaced by Task 3 instructions |
| `frontend/CHAT_WIDGET_README.md` | Verify whether a chat widget still exists; delete if not |
| `frontend/src/plan-plainsGuiIntegration.md` | Integration plan; check if superseded |
| `frontend/src/routes/auth/nomad/nomad_conf.md` | Check if still accurate; delete if stale |
| `backend/safe_test_upload.md` | Ad-hoc note; delete if not referenced anywhere |

Before deleting, verify each file is not imported/referenced in code or CI.

### 2. Audit `development.md`, `deployment.md`, `future_development.md`
- Compare contents against current `CLAUDE.md`, `README.md`, and actual scripts.
- Remove sections that duplicate `CLAUDE.md` exactly.
- If a file is 100 % covered by `CLAUDE.md`, delete it and add a one-line pointer in `CLAUDE.md` if needed.

### 3. Verify `release-notes.md`
- Keep if it tracks version history; otherwise convert it to a `CHANGELOG.md` stub.

### 4. Code-level refactors (no behaviour change)
- `backend/app/models.py`: ensure model variants (`Base`, `Create`, `Update`, `Public`) follow a consistent ordering pattern.
- `frontend/src/store/`: confirm `InMemoryBackend` is still used/tested; if it is dead code, remove it.
- Remove any `TODO` / `FIXME` comments that refer to completed tasks.
- Remove unused imports flagged by `ruff` in backend; remove unused imports flagged by Biome in frontend.

## Acceptance Criteria
- `git diff --stat` shows only deletions/renames (no logic changes).
- `bash backend/scripts/lint.sh` passes.
- `bun run lint` (from `frontend/`) passes.
- All existing backend tests still pass: `uv run pytest`.
