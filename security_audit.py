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
# 5. DEPLOY-READINESS CHECKS
# ─────────────────────────────────────────────
#
# These verify the concrete steps in DEPLOY_SECURITY_CHECKLIST.md are met, so the
# repo is safe to expose to the public internet. Each check returns a Check with a
# severity; `run_deploy_checks` exits non-zero if any REQUIRED check fails.

# Severities. REQUIRED failures block deployment; RECOMMENDED failures only warn.
REQUIRED = "REQUIRED"
RECOMMENDED = "RECOMMENDED"

# Values that mean "not really set" for a secret/password.
PLACEHOLDER_SECRETS = {
    "", "changethis", "change_this", "changeme",
    "CHANGE_THIS", "CHANGE_THIS_TO_A_RANDOM_SECRET", "CHANGEME",
    "your-secret-here", "secret",
}


class Check:
    """Result of a single deploy-readiness check."""

    def __init__(self, name: str, severity: str, passed: bool, detail: str):
        self.name = name
        self.severity = severity
        self.passed = passed
        self.detail = detail


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse a KEY=VALUE .env file into a dict, stripping quotes and inline comments.

    Returns {} if the file does not exist. Never prints values (they are secrets).
    """
    env: dict[str, str] = {}
    if not path.exists():
        return env
    for raw in path.read_text(errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip surrounding quotes.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        env[key] = value
    return env


def _read(path: Path) -> str:
    try:
        return path.read_text(errors="replace")
    except Exception:
        return ""


def _bool_env(value: str) -> bool | None:
    """Interpret a .env truthy/falsy string. Returns None if unrecognised."""
    v = value.strip().lower()
    if v in ("1", "true", "yes", "on"):
        return True
    if v in ("0", "false", "no", "off"):
        return False
    return None


def _git_tracks_env() -> bool:
    """True if .env is tracked by git (a critical leak)."""
    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", ".env"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return result.returncode == 0


def deploy_checks() -> list[Check]:
    """Run every deploy-readiness check and return the results."""
    checks: list[Check] = []
    env = parse_env_file(ROOT / ".env")
    have_env = bool(env)

    # ── Secret / git hygiene ──
    checks.append(Check(
        ".env not tracked by git", REQUIRED,
        not _git_tracks_env(),
        "'.env' must never be committed; rotate secrets if it ever was.",
    ))

    gitignore = _read(ROOT / ".gitignore")
    checks.append(Check(
        ".gitignore covers .env", REQUIRED,
        ".env" in gitignore,
        "Add '.env' and '.env.*' to .gitignore.",
    ))

    # ── .env configuration (only meaningful if a .env is present) ──
    if not have_env:
        checks.append(Check(
            ".env present at repo root", RECOMMENDED, False,
            "No .env found — skipping value checks (fine if secrets are injected "
            "as environment variables at runtime; verify those instead).",
        ))
    else:
        environment = env.get("ENVIRONMENT", "")
        is_prod = environment in ("staging", "production")
        checks.append(Check(
            "ENVIRONMENT is staging/production", REQUIRED, is_prod,
            f"ENVIRONMENT={environment or '(unset)'}; set to 'production' to enable "
            "strict config validators and HSTS.",
        ))

        for key in ("SECRET_KEY", "POSTGRES_PASSWORD", "FIRST_SUPERUSER_PASSWORD"):
            value = env.get(key, "")
            ok = value not in PLACEHOLDER_SECRETS
            detail = f"{key} is unset or a placeholder — set a strong unique value."
            if key == "SECRET_KEY" and ok and len(value) < 32:
                ok = False
                detail = "SECRET_KEY is too short (<32 chars); regenerate with token_urlsafe(32)."
            checks.append(Check(f"{key} is set", REQUIRED, ok, detail))

        open_reg = _bool_env(env.get("USERS_OPEN_REGISTRATION", "true"))
        checks.append(Check(
            "USERS_OPEN_REGISTRATION disabled", REQUIRED, open_reg is False,
            "Set USERS_OPEN_REGISTRATION=False so strangers cannot self-register.",
        ))

        allowed = env.get("ALLOWED_EMAILS", "").strip()
        checks.append(Check(
            "ALLOWED_EMAILS whitelist set", REQUIRED, bool(allowed),
            "ALLOWED_EMAILS is empty — any authenticated NOMAD account can log in. "
            "List the authorised emails for a private deployment.",
        ))

        oauth = _bool_env(env.get("NOMAD_OAUTH_ENABLED", "false"))
        checks.append(Check(
            "NOMAD_OAUTH_ENABLED in prod", REQUIRED,
            (oauth is True) if is_prod else True,
            "NOMAD_OAUTH_ENABLED must be true in staging/production (local login "
            "is unsafe on a shared host).",
        ))

        cors = env.get("BACKEND_CORS_ORIGINS", "")
        cors_ok = "*" not in cors and "localhost" not in cors and "127.0.0.1" not in cors
        checks.append(Check(
            "BACKEND_CORS_ORIGINS is a real origin", RECOMMENDED,
            cors_ok if is_prod else True,
            f"BACKEND_CORS_ORIGINS={cors or '(unset)'}; set it to your HTTPS origin, "
            "not '*' or localhost.",
        ))

    # ── Code-level hardening still in place (regression guards) ──
    main_py = _read(ROOT / "backend" / "app" / "main.py")
    checks.append(Check(
        "CORS not wide-open", REQUIRED,
        'allow_methods=["*"]' not in main_py and 'allow_headers=["*"]' not in main_py,
        "CORS was widened back to '*' — restrict methods/headers in main.py.",
    ))
    checks.append(Check(
        "Security headers middleware present", REQUIRED,
        "SecurityHeadersMiddleware" in main_py,
        "SecurityHeadersMiddleware missing from backend/app/main.py.",
    ))

    nginx = _read(ROOT / "frontend" / "nginx.conf")
    checks.append(Check(
        "nginx security headers present", REQUIRED,
        "Content-Security-Policy" in nginx and "X-Frame-Options" in nginx,
        "frontend/nginx.conf is missing CSP / X-Frame-Options headers.",
    ))

    nomad = _read(ROOT / "backend" / "app" / "api" / "routes" / "nomad.py")
    checks.append(Check(
        "NOMAD path-traversal fix present", REQUIRED,
        "is_relative_to" in nomad,
        "archive_path validation must use Path.is_relative_to (not startswith).",
    ))

    limiter_used = any(
        "limiter.limit" in _read(ROOT / "backend" / "app" / "api" / "routes" / f)
        for f in ("login.py", "users.py")
    )
    checks.append(Check(
        "Auth rate limiting present", RECOMMENDED, limiter_used,
        "No @limiter.limit found on auth routes — add slowapi limits.",
    ))

    # ── Container / build hygiene (recommended) ──
    dockerignore = _read(ROOT / ".dockerignore")
    checks.append(Check(
        ".dockerignore excludes secrets", RECOMMENDED,
        bool(dockerignore) and ".env" in dockerignore,
        "Add a .dockerignore excluding .env, *.pem, *.key, .git/ so build contexts "
        "never ship secrets.",
    ))

    backend_df = _read(ROOT / "backend" / "Dockerfile")
    prod_compose = _read(ROOT / "compose.prod.yml")
    backend_nonroot = (
        ("USER ${RUN_AS_USER}" in backend_df or "USER appuser" in backend_df)
        and "RUN_AS_USER: appuser" in prod_compose
    )
    checks.append(Check(
        "Backend prod image runs as non-root", RECOMMENDED, backend_nonroot,
        "Production backend runs as root — set `USER ${RUN_AS_USER}` in "
        "backend/Dockerfile and `RUN_AS_USER: appuser` build arg in compose.prod.yml. "
        "Rebuild with the prod compose files for it to take effect.",
    ))

    frontend_df = _read(ROOT / "frontend" / "Dockerfile")
    frontend_nonroot = (
        "nginx-unprivileged" in frontend_df
        and "target: runtime-unprivileged" in prod_compose
    )
    checks.append(Check(
        "Frontend prod image runs as non-root", RECOMMENDED, frontend_nonroot,
        "Production frontend runs nginx as root — add an nginxinc/nginx-unprivileged "
        "stage and select it via `target: runtime-unprivileged` in compose.prod.yml.",
    ))

    return checks


def run_deploy_checks() -> int:
    """Print the deploy-readiness report. Returns a process exit code."""
    separator("DEPLOY-READINESS CHECKS")
    print("\n  Verifies DEPLOY_SECURITY_CHECKLIST.md is satisfied.\n")

    checks = deploy_checks()
    required = [c for c in checks if c.severity == REQUIRED]
    recommended = [c for c in checks if c.severity == RECOMMENDED]
    req_failed = [c for c in required if not c.passed]
    rec_failed = [c for c in recommended if not c.passed]

    def emit(group: list[Check]) -> None:
        for c in group:
            mark = "PASS" if c.passed else "FAIL"
            print(f"  [{mark}] {c.name}")
            if not c.passed:
                print(f"         → {c.detail}")

    print(f"  REQUIRED ({len(required) - len(req_failed)}/{len(required)} passed):")
    emit(required)
    print(f"\n  RECOMMENDED ({len(recommended) - len(rec_failed)}/{len(recommended)} passed):")
    emit(recommended)

    print()
    if req_failed:
        print(f"  ❌ NOT SAFE TO DEPLOY — {len(req_failed)} required check(s) failed.")
        if rec_failed:
            print(f"     ({len(rec_failed)} recommended item(s) also open.)")
        return 1
    if rec_failed:
        print(f"  ✅ Required checks pass. {len(rec_failed)} recommended item(s) still open.")
        return 0
    print("  ✅ All checks pass — repo meets the deploy-readiness bar.")
    return 0


# ─────────────────────────────────────────────
# 6. MAIN OUTPUT
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

    # ── Deploy-readiness checks ──
    exit_code = run_deploy_checks()

    separator("AUDIT COMPLETE")
    print()
    return exit_code


if __name__ == "__main__":
    if "--check" in sys.argv or "check" in sys.argv[1:]:
        # Deploy-readiness checks only (fast, no dependency scans).
        sys.exit(run_deploy_checks())
    sys.exit(main() or 0)
