#!/usr/bin/env python3
"""Security audit script for Plains project.

Prints all dependencies (backend + frontend) with versions,
and all external HTTP/URL references found in source code.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent

# ─────────────────────────────────────────────
# 1. BACKEND DEPENDENCIES
# ─────────────────────────────────────────────

def get_backend_deps() -> dict[str, str]:
    """Return {package: version} from uv pip freeze inside backend venv."""
    result = subprocess.run(
        ["uv", "pip", "freeze"],
        cwd=ROOT / "backend",
        capture_output=True, text=True,
    )
    deps: dict[str, str] = {}
    for line in result.stdout.splitlines():
        line = line.strip()
        if "==" in line:
            name, ver = line.split("==", 1)
            deps[name.lower()] = ver
    return deps


def parse_backend_direct() -> list[tuple[str, str]]:
    """Parse direct dependencies from backend/pyproject.toml."""
    import tomllib
    path = ROOT / "backend" / "pyproject.toml"
    with open(path, "rb") as f:
        data = tomllib.load(f)
    deps = data.get("project", {}).get("dependencies", [])
    result = []
    for dep in deps:
        # e.g. "fastapi>=0.111.0" or "httpx[cli]"
        m = re.match(r"([A-Za-z0-9_\-\.\[\]]+?)([>=<!].*)?$", dep.strip())
        if m:
            result.append((m.group(1).lower().split("[")[0], m.group(2) or "any"))
    return result


# ─────────────────────────────────────────────
# 2. FRONTEND DEPENDENCIES
# ─────────────────────────────────────────────

def get_frontend_deps() -> dict[str, str]:
    """Return {package: version} from frontend/package.json."""
    path = ROOT / "frontend" / "package.json"
    with open(path) as f:
        data = json.load(f)
    all_deps: dict[str, str] = {}
    for section in ("dependencies", "devDependencies", "peerDependencies"):
        all_deps.update(data.get(section, {}))
    return all_deps


def get_frontend_lockfile_versions() -> dict[str, str]:
    """Return resolved versions from bun.lock or package-lock.json."""
    lock = ROOT / "frontend" / "bun.lock"
    if lock.exists():
        # bun.lock is a text lockfile; parse "package@version" lines
        versions: dict[str, str] = {}
        text = lock.read_text()
        # Bun lockfile v1: lines like `    "package@version": [`
        for m in re.finditer(r'"(@?[^"@]+)@([^"]+)":', text):
            pkg, ver = m.group(1), m.group(2)
            if pkg not in versions:
                versions[pkg] = ver
        return versions
    return {}


# ─────────────────────────────────────────────
# 3. EXTERNAL URL / REQUEST SCANNING
# ─────────────────────────────────────────────

# File extensions to scan
SOURCE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".yaml", ".yml", ".toml", ".env",
}

# Directories to skip
SKIP_DIRS = {
    "node_modules", ".venv", "__pycache__", ".git", "dist", "build",
    ".mypy_cache", ".ruff_cache", ".pytest_cache", ".claude",
}

# Patterns for external HTTP calls / URLs
URL_PATTERNS = [
    # Literal https/http URLs
    re.compile(r'(https?://[^\s\'">\)]+)', re.IGNORECASE),
    # Python requests/httpx calls
    re.compile(r'\b(requests|httpx)\.(get|post|put|patch|delete|request)\s*\(', re.IGNORECASE),
    # JS fetch calls
    re.compile(r'\bfetch\s*\(', re.IGNORECASE),
    # axios calls
    re.compile(r'\baxios\.(get|post|put|patch|delete|request)\s*\(', re.IGNORECASE),
    # WebSocket connections
    re.compile(r'\bnew\s+WebSocket\s*\(', re.IGNORECASE),
    # Environment variable URL references
    re.compile(r'(NOMAD_URL|API_URL|BASE_URL|BACKEND_URL|WEBHOOK_URL|SENTRY_DSN)', re.IGNORECASE),
]

# URLs to always skip (internal/dev)
SKIP_URL_PATTERNS = [
    re.compile(r'localhost'),
    re.compile(r'127\.0\.0\.1'),
    re.compile(r'0\.0\.0\.0'),
    re.compile(r'example\.com'),
    re.compile(r'schemas\.openapis\.org'),
    re.compile(r'json-schema\.org'),
    re.compile(r'w3\.org'),
    re.compile(r'opentelemetry\.io'),
    re.compile(r'#'),  # fragment-only
]


def is_external_url(url: str) -> bool:
    if not url.startswith(("http://", "https://")):
        return False
    return not any(p.search(url) for p in SKIP_URL_PATTERNS)


def scan_source_files() -> list[dict]:
    findings: list[dict] = []
    for ext_dir in [ROOT / "backend", ROOT / "frontend" / "src", ROOT / "frontend" / "public"]:
        if not ext_dir.exists():
            continue
        for path in ext_dir.rglob("*"):
            if any(skip in path.parts for skip in SKIP_DIRS):
                continue
            if path.suffix not in SOURCE_EXTENSIONS or not path.is_file():
                continue
            try:
                text = path.read_text(errors="replace")
            except Exception:
                continue
            for lineno, line in enumerate(text.splitlines(), 1):
                for pat in URL_PATTERNS:
                    for m in pat.finditer(line):
                        snippet = line.strip()
                        # For URL patterns, filter to external only
                        if pat == URL_PATTERNS[0]:
                            url = m.group(1).rstrip(".,;)'\"")
                            if not is_external_url(url):
                                continue
                            findings.append({
                                "file": str(path.relative_to(ROOT)),
                                "line": lineno,
                                "type": "URL",
                                "value": url,
                                "snippet": snippet[:120],
                            })
                        else:
                            findings.append({
                                "file": str(path.relative_to(ROOT)),
                                "line": lineno,
                                "type": "HTTP_CALL",
                                "value": m.group(0),
                                "snippet": snippet[:120],
                            })
    # Deduplicate
    seen: set[tuple] = set()
    unique: list[dict] = []
    for f in findings:
        key = (f["file"], f["line"], f["value"])
        if key not in seen:
            seen.add(key)
            unique.append(f)
    return unique


# ─────────────────────────────────────────────
# 4. VULNERABILITY CHECK via pip-audit / osv-scanner
# ─────────────────────────────────────────────

def run_pip_audit() -> str:
    result = subprocess.run(
        ["uv", "run", "pip-audit", "--format", "columns", "-r", "requirements-check.txt"],
        cwd=ROOT / "backend",
        capture_output=True, text=True,
    )
    if result.returncode not in (0, 1):
        # Try without requirements file
        result = subprocess.run(
            ["uv", "run", "pip-audit", "--format", "columns"],
            cwd=ROOT / "backend",
            capture_output=True, text=True,
        )
    return result.stdout + result.stderr


def run_pip_audit_direct() -> str:
    """Run pip-audit against the installed environment."""
    result = subprocess.run(
        ["uv", "run", "pip-audit", "--format", "columns", "--fix", "--dry-run"],
        cwd=ROOT / "backend",
        capture_output=True, text=True,
    )
    return result.stdout + result.stderr


DEPLOY_TIME_PACKAGES = {
    # Packages that are bundled and shipped to end users
    "axios", "react", "react-dom", "keycloak-js",
    "zod", "@mantine/core", "@tanstack/react-router",
    "@tanstack/react-query", "echarts", "docx", "jspdf",
}

BUILD_TIME_ONLY = {
    # Never end up in the production bundle
    "@hey-api/openapi-ts", "vite", "rollup", "esbuild",
    "@tanstack/router-plugin", "@babel/core", "webpack",
    "postcss", "tailwindcss", "typescript", "biome",
    "@playwright/test", "concurrently", "express", "socket.io",
}


def check_npm_audit() -> str:
    result = subprocess.run(
        ["bun", "audit"],
        cwd=ROOT / "frontend",
        capture_output=True, text=True,
    )
    if result.returncode == 127 or "not found" in result.stderr:
        result = subprocess.run(
            ["npm", "audit"],
            cwd=ROOT / "frontend",
            capture_output=True, text=True,
        )
    raw = result.stdout + result.stderr

    # Annotate each advisory line with deploy vs build classification
    lines = raw.splitlines()
    annotated: list[str] = []
    for line in lines:
        annotated.append(line)
        # When we see a "workspace:frontend › <pkg>" line, classify it
        if "workspace:frontend" in line:
            pkg = line.split("› ")[-1].strip()
            root_pkg = pkg.split("/")[0].lstrip("@")
            root_pkg_full = pkg.split("/")[0]
            is_build = any(
                line.endswith(b) or f"› {b}" in line
                for b in BUILD_TIME_ONLY
            )
            if is_build:
                annotated.append("  ⚙️  BUILD-TIME ONLY — not in production bundle")
            else:
                annotated.append("  🚀 DEPLOY-TIME — present in production build")
    return "\n".join(annotated)


# ─────────────────────────────────────────────
# 5. MAIN OUTPUT
# ─────────────────────────────────────────────

def separator(title: str):
    print(f"\n{'='*70}")
    print(f"  {title}")
    print('='*70)


def main():
    # ── Backend: direct deps from pyproject.toml ──
    separator("BACKEND: Direct Dependencies (pyproject.toml)")
    try:
        direct = parse_backend_direct()
        for name, spec in sorted(direct):
            print(f"  {name:<40} {spec}")
    except Exception as e:
        print(f"  ERROR: {e}")

    # ── Backend: all installed packages (frozen) ──
    separator("BACKEND: All Installed Packages (uv pip freeze)")
    try:
        frozen = get_backend_deps()
        for name, ver in sorted(frozen.items()):
            print(f"  {name:<40} {ver}")
        print(f"\n  Total: {len(frozen)} packages")
    except Exception as e:
        print(f"  ERROR: {e}")

    # ── Frontend: direct deps from package.json ──
    separator("FRONTEND: Dependencies (package.json)")
    try:
        fe_deps = get_frontend_deps()
        print(f"\n  {'Package':<45} {'Declared Version'}")
        print(f"  {'-'*45} {'-'*20}")
        for name, ver in sorted(fe_deps.items()):
            print(f"  {name:<45} {ver}")
        print(f"\n  Total: {len(fe_deps)} packages")
    except Exception as e:
        print(f"  ERROR: {e}")

    # ── External URLs and HTTP calls in source ──
    separator("EXTERNAL URLs & HTTP CALLS IN SOURCE CODE")
    findings = scan_source_files()
    urls = [f for f in findings if f["type"] == "URL"]
    calls = [f for f in findings if f["type"] == "HTTP_CALL"]

    print(f"\n  External URLs found: {len(urls)}")
    for f in urls:
        print(f"\n  [{f['file']}:{f['line']}]")
        print(f"    URL:     {f['value']}")
        print(f"    Snippet: {f['snippet']}")

    print(f"\n  HTTP call sites found: {len(calls)}")
    for f in calls:
        print(f"\n  [{f['file']}:{f['line']}]")
        print(f"    Call:    {f['value']}")
        print(f"    Snippet: {f['snippet']}")

    # ── pip-audit vulnerability check ──
    separator("BACKEND: Vulnerability Scan (pip-audit)")
    print()
    audit_out = run_pip_audit_direct()
    print(audit_out if audit_out.strip() else "  pip-audit not installed — skipping")

    # ── npm/bun audit ──
    separator("FRONTEND: Vulnerability Scan (npm/bun audit)")
    print()
    npm_out = check_npm_audit()
    print(npm_out[:4000] if npm_out.strip() else "  No audit tool available")

    separator("AUDIT COMPLETE")
    print()


if __name__ == "__main__":
    main()
