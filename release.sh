#!/usr/bin/env bash
set -euo pipefail

# release.sh v5
# Usage: ./release.sh v0.1.0 \
#   [--dry-run] [--otp 123456] \
#   [--push] [--remote origin] \
#   [--gh-release] [--gh-draft] [--gh-title "Title"] \
#   [--proxy http://proxy:8080] [--registry https://registry.npmjs.org/] [--no-strict-ssl]
# - Bumps versions in publishable packages
# - Rewrites workspace:* deps to ^<version>
# - Builds packages in dependency order
# - Commits changes and creates git tag v<version>
# - Publishes to npm (scoped, public)

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

# -------- Args --------
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version|vVersion> [--dry-run] [--otp <code>]" >&2
  exit 1
fi

RAW_VERSION="$1"; shift || true
VERSION="${RAW_VERSION#v}"
TAG="v${VERSION}"
DRY_RUN=false
OTP=""
PUSH=false
REMOTE="origin"
GH_RELEASE=false
GH_DRAFT=false
GH_TITLE=""
PROXY=""
NPM_REGISTRY=""
NPM_STRICT_SSL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry|--dry-run)
      DRY_RUN=true
      shift
      ;;
    --otp)
      OTP="${2:-}"
      if [[ -z "$OTP" ]]; then
        echo "--otp requires a code" >&2
        exit 1
      fi
      shift 2
      ;;
    --push)
      PUSH=true
      shift
      ;;
    --remote)
      REMOTE="${2:-origin}"
      shift 2
      ;;
    --gh-release)
      GH_RELEASE=true
      PUSH=true # ensure tags/commits are on remote for the release
      shift
      ;;
    --gh-draft)
      GH_DRAFT=true
      shift
      ;;
    --gh-title)
      GH_TITLE="${2:-}"
      shift 2
      ;;
    --proxy)
      PROXY="${2:-}"
      if [[ -z "$PROXY" ]]; then
        echo "--proxy requires a URL" >&2
        exit 1
      fi
      shift 2
      ;;
    --registry)
      NPM_REGISTRY="${2:-}"
      if [[ -z "$NPM_REGISTRY" ]]; then
        echo "--registry requires a URL" >&2
        exit 1
      fi
      shift 2
      ;;
    --no-strict-ssl)
      NPM_STRICT_SSL="false"
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# -------- Helpers --------
log() { printf "\033[1;34m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
err() { printf "\033[1;31m[error]\033[0m %s\n" "$*"; }

require_clean_git() {
  if ! git diff --quiet || ! git diff --cached --quiet; then
    err "Git working tree not clean. Commit or stash changes first."
    git status --short
    exit 1
  fi
}

ensure_tools() {
  command -v git >/dev/null || { err "git not found"; exit 1; }
  command -v bun >/dev/null || { err "bun not found"; exit 1; }
  command -v npm >/dev/null || { err "npm not found"; exit 1; }
  : # no extra tools required beyond bun/npm/git
}

validate_version() {
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    err "Invalid semver: $VERSION"
    exit 1
  fi
}

# Safely update package.json version and convert workspace:* deps using Bun (no Python)
bump_package_json() {
  local pkg_json="$1"
  local tmp_js
  tmp_js="$(mktemp -t bump.XXXXXX.mjs)"
  cat >"$tmp_js" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [, , p, v] = process.argv;
const data = JSON.parse(readFileSync(p, 'utf8'));
data.version = v;
const fix = (deps) => {
  if (!deps || typeof deps !== 'object') return;
  for (const [k, val] of Object.entries(deps)) {
    if (typeof val === 'string' && val.startsWith('workspace:')) {
      const spec = val.split(':', 2)[1];
      if (spec === '' || spec === '*' || spec === '^') deps[k] = '^' + v;
      else if (spec === '~') deps[k] = '~' + v;
      else deps[k] = spec; // honor pinned value after workspace:
    }
  }
};
['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies'].forEach((k) => fix(data[k]));
writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
JS
  bun "$tmp_js" "$pkg_json" "$VERSION"
  rm -f "$tmp_js"
}

# Check if a package.json has private: true using Bun
is_private_pkg() {
  local pkg_json="$1"
  local tmp_js
  tmp_js="$(mktemp -t ispriv.XXXXXX.mjs)"
  cat >"$tmp_js" <<'JS'
import { readFileSync } from 'node:fs';
const [, , p] = process.argv;
const data = JSON.parse(readFileSync(p, 'utf8'));
console.log(data.private ? '1' : '0');
JS
  bun "$tmp_js" "$pkg_json"
  rm -f "$tmp_js"
}

build_pkg() {
  local dir="$1"
  ( cd "$dir" && bun run build )
}

publish_pkg() {
  local dir="$1"
  local flags=("--access" "public")
  if [[ "$DRY_RUN" == true ]]; then
    flags+=("--dry-run")
  fi
  if [[ -n "$OTP" ]]; then
    flags+=("--otp" "$OTP")
  fi
  ( cd "$dir" && npm publish "${flags[@]}" )
}

# -------- Start --------
ensure_tools
validate_version
require_clean_git

log "Target version: $VERSION (${TAG})"

# Apply proxy/registry env for child processes
if [[ -n "$PROXY" ]]; then
  export HTTP_PROXY="$PROXY"
  export http_proxy="$PROXY"
  export HTTPS_PROXY="$PROXY"
  export https_proxy="$PROXY"
  export NPM_CONFIG_PROXY="$PROXY"
  export npm_config_proxy="$PROXY"
  export NPM_CONFIG_HTTPS_PROXY="$PROXY"
  export npm_config_https_proxy="$PROXY"
fi
if [[ -n "$NPM_REGISTRY" ]]; then
  export NPM_CONFIG_REGISTRY="$NPM_REGISTRY"
  export npm_config_registry="$NPM_REGISTRY"
fi
if [[ "$NPM_STRICT_SSL" == "false" ]]; then
  export NODE_TLS_REJECT_UNAUTHORIZED=0
  export NPM_CONFIG_STRICT_SSL=false
  export npm_config_strict_ssl=false
fi

# Determine packages (in dependency order)
PKGS=(
  "avplay/decoder"
  "avplay/core"
  "avplay/react"
)

for dir in "${PKGS[@]}"; do
  if [[ ! -f "$dir/package.json" ]]; then
    err "Missing $dir/package.json"
    exit 1
  fi
  # ensure package is not private
  if [[ "$(is_private_pkg "$dir/package.json")" == "1" ]]; then
    err "$dir is private; refusing to publish"
    exit 1
  fi
done

log "Bumping versions and workspace dependencies..."
for dir in "${PKGS[@]}"; do
  bump_package_json "$dir/package.json"
  echo " - updated $dir/package.json"
done

log "Installing deps to update lockfile..."
bun install

log "Building packages..."
for dir in "${PKGS[@]}"; do
  build_pkg "$dir"
  echo " - built $dir"
done

log "Committing and tagging release..."
git add avplay/**/package.json bun.lock || true
if git diff --cached --quiet; then
  warn "No changes to commit"
else
  git commit -m "release: ${TAG}"
fi
git tag -f "$TAG"

log "Checking npm auth..."
if ! npm whoami >/dev/null 2>&1; then
  warn "Not logged in to npm; 'npm publish' may prompt or fail."
fi

log "Publishing packages to npm..."
for dir in "${PKGS[@]}"; do
  if [[ -n "$PROXY" || -n "$NPM_REGISTRY" || "$NPM_STRICT_SSL" == "false" ]]; then
    # Ensure per-command isolation of env for npm publish
    ( export HTTP_PROXY="$HTTP_PROXY" HTTPS_PROXY="$HTTPS_PROXY" NPM_CONFIG_PROXY="$NPM_CONFIG_PROXY" NPM_CONFIG_HTTPS_PROXY="$NPM_CONFIG_HTTPS_PROXY" NPM_CONFIG_REGISTRY="$NPM_CONFIG_REGISTRY" NPM_CONFIG_STRICT_SSL="${NPM_CONFIG_STRICT_SSL:-}" NODE_TLS_REJECT_UNAUTHORIZED="${NODE_TLS_REJECT_UNAUTHORIZED:-}"; publish_pkg "$dir" )
  else
    publish_pkg "$dir"
  fi
  echo " - published $dir"
done

# Optionally push commits and tags
if [[ "$PUSH" == true ]]; then
  log "Pushing commits and tags to $REMOTE..."
  git push "$REMOTE" HEAD && git push "$REMOTE" --tags
else
  log "Skipped push (enable with --push)"
fi

# Optionally create a GitHub release via gh
if [[ "$GH_RELEASE" == true ]]; then
  if ! command -v gh >/dev/null; then
    warn "gh CLI not found; skipping GitHub release"
  else
    log "Creating GitHub release ${TAG}..."
    GH_FLAGS=("release" "create" "$TAG" "--verify-tag")
    if [[ "$GH_DRAFT" == true ]]; then
      GH_FLAGS+=("--draft")
    fi
    if [[ -n "$GH_TITLE" ]]; then
      GH_FLAGS+=("--title" "$GH_TITLE")
    else
      GH_FLAGS+=("--title" "${TAG}")
    fi
    GH_BODY=$(cat <<EOF
Release ${TAG}

Packages published:
- @avplay/decoder@${VERSION}
- @avplay/core@${VERSION}
- @avplay/react@${VERSION}
EOF
)
    # shellcheck disable=SC2086
    gh ${GH_FLAGS[@]} --notes "$GH_BODY" || warn "Failed to create GitHub release"
  fi
else
  log "Skipped GitHub release (enable with --gh-release)"
fi

log "Done."
