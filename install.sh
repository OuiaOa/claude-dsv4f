#!/usr/bin/env bash
# dsv4shim installer — Linux / macOS / WSL
#
# Detects Node. If Node itself is missing, attempts to install it via the OS's own package
# manager before falling back to a manual-install message. Claude Code is installed privately
# into this shim's data directory during setup, so no global Claude installation is required.
#
# Flags:
#   --no-auto-install    do NOT auto-install Node.js during this install step
#   --bundle             copy Claude Code's binary into the dsv4shim install, so the
#                        resulting setup is self-contained and the resolver prefers
#                        the bundled copy. Has no effect if Claude Code isn't on PATH.
#   --update             re-copy files even if the destination already exists
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${DSV4SHIM_HOME:-$HOME/.local/share/dsv4shim}"
BIN="$HOME/.local/bin"

AUTO_INSTALL=1
BUNDLE=0
UPDATE=0
for a in "$@"; do
  case "$a" in
    --no-auto-install) AUTO_INSTALL=0 ;;
    --bundle)          BUNDLE=1 ;;
    --update)          UPDATE=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown flag: $a"; exit 2 ;;
  esac
done

# -------------------------------------------------------------- Node (auto-install, then hard check)
# Distro package repos often ship a Node too old for the v22 floor below, so this goes
# straight to NodeSource/upstream sources rather than the generic `apt install nodejs` a
# user might already have tried and found insufficient.
if ! command -v node >/dev/null && [[ "$AUTO_INSTALL" -eq 1 ]]; then
  echo "Node.js not found — attempting install..."
  if command -v apt-get >/dev/null; then
    echo "  using NodeSource + apt (will prompt for sudo)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    echo "  using NodeSource + dnf (will prompt for sudo)..."
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash - && sudo dnf install -y nodejs
  elif command -v pacman >/dev/null; then
    echo "  using pacman (will prompt for sudo)..."
    sudo pacman -Sy --noconfirm nodejs npm
  elif command -v brew >/dev/null; then
    echo "  using Homebrew..."
    brew install node
  else
    echo "  no known package manager found (apt/dnf/pacman/brew) — install manually."
  fi
  hash -r 2>/dev/null || true
fi
command -v node >/dev/null || { echo "Node.js v22+ is required. Install from:"; echo "  https://nodejs.org/  (or use your package manager)"; exit 1; }
node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if (( node_major < 22 )); then
  echo "Node $node_major detected — dsv4shim needs v22 or newer for the private Claude Code runner. Please upgrade: https://nodejs.org/"; exit 1
fi

# ------------------------------------------------------ Optional existing Claude detection
claude_bin="$(command -v claude || true)"
if [[ -z "$claude_bin" ]]; then
  echo "Claude Code is not installed globally; dsv4shim setup will install a private runner."
fi

# ------------------------------------------------------------- copy files
mkdir -p "$DEST" "$BIN"
if [[ "$SRC" != "$DEST" || "$UPDATE" -eq 1 ]]; then
  cp -r "$SRC"/shim.mjs "$SRC"/probe.mjs "$SRC"/test-shim.mjs \
        "$SRC"/config.default.json "$SRC"/bin "$DEST"/
  [[ -d "$SRC/e2e" ]] && cp -r "$SRC/e2e" "$DEST"/ || true
  # Skills (Claude Code Skills) ship with the dsv4shim profile and live next to it. Each
  # skill is a folder with SKILL.md; Claude Code auto-discovers them under
  # $CLAUDE_CONFIG_DIR/skills. Copy the whole tree so user-level skills install
  # alongside the binary.
  [[ -d "$SRC/skills" ]] && cp -r "$SRC/skills" "$DEST/" || true
  # Agents (Claude Code subagents) ship the same way: one .md per agent, discovered under
  # $CLAUDE_CONFIG_DIR/agents. See agents/README.md for what each one is and where the
  # definitions were adapted from.
  [[ -d "$SRC/agents" ]] && cp -r "$SRC/agents" "$DEST/" || true
fi
chmod +x "$DEST"/bin/* 2>/dev/null || true

# --------------------------------------------- optional: bundle Claude Code
# Copies the claude binary into the dsv4shim install so the resolver can prefer it.
# This makes the dsv4shim install self-contained — PATH becomes optional.
if [[ "$BUNDLE" -eq 1 ]]; then
  bundled="$DEST/bin/claude"
  if [[ -n "$claude_bin" ]] && cp "$claude_bin" "$bundled" 2>/dev/null; then
    chmod +x "$bundled"
    echo "Bundled Claude Code → $bundled (resolver will prefer this copy)."
  else
    echo "  WARNING: no existing Claude binary to bundle; setup will install a private runner."
  fi
fi

# ------------------------------------------------------------- PATH shims
# `dsv4f` and `claude-dsv4f` were two names for one script; under the DSv4Shim rename they
# collapse to a single `dsv4shim`, so there is one symlink where there were two. The old names
# are deliberately removed rather than aliased — this rename is a clean break.
for n in dsv4shim dsv4shim-usage dsv4shim-import dsv4f claude-dsv4f dsv4f-usage dsv4f-import; do rm -f "$BIN/$n"; done
ln -s "$DEST/bin/dsv4shim.mjs"      "$BIN/dsv4shim"
ln -s "$DEST/bin/dsv4shim-usage"    "$BIN/dsv4shim-usage"
ln -s "$DEST/bin/dsv4shim-import"   "$BIN/dsv4shim-import"

echo ""
echo "Installed to $DEST"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "NOTE: add $BIN to your PATH (or open a new terminal)";; esac
echo "Next:  dsv4shim setup"
