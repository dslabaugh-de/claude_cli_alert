#!/bin/bash
# claude_cli_alert installer for macOS.
# Double-click in Finder to run.
#
# What this does:
#   1. Copies this folder to ~/.claude-alert/
#   2. Patches ~/.claude/settings.json to add hook entries pointing at hook.js
#   3. Captures all future Claude Code CLI sessions
set -e

# Resolve the directory this script lives in (works regardless of cwd)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.claude-alert"
SETTINGS="$HOME/.claude/settings.json"

echo ""
echo "  Claude CLI Alert — installer"
echo "  ═════════════════════════════"
echo ""

# Sanity check: Node must be installed (Claude Code requires it, so this should pass)
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js is not installed."
  echo "    Claude Code requires Node, so this is unusual."
  echo "    Install from https://nodejs.org and try again."
  exit 1
fi
echo "  ✓ Node.js found: $(node --version)"

# Make sure ~/.claude exists
mkdir -p "$HOME/.claude"

# Copy the app to ~/.claude-alert/
echo "  → Copying app to $TARGET"
mkdir -p "$TARGET"
mkdir -p "$TARGET/buddy"
mkdir -p "$TARGET/fonts"
cp "$SCRIPT_DIR/server.js"      "$TARGET/server.js"
cp "$SCRIPT_DIR/hook.js"        "$TARGET/hook.js"
cp "$SCRIPT_DIR/dashboard.html" "$TARGET/dashboard.html"
cp "$SCRIPT_DIR/start.command"  "$TARGET/start.command"
cp "$SCRIPT_DIR/uninstall.command" "$TARGET/uninstall.command"
# Bundle the local font so the buddy card renders correctly
if [ -d "$SCRIPT_DIR/fonts" ]; then
  cp "$SCRIPT_DIR/fonts"/*.woff2 "$TARGET/fonts/" 2>/dev/null || true
fi
# Copy buddy folder contents (only if user hasn't already customized them)
if [ -d "$SCRIPT_DIR/buddy" ]; then
  for f in "$SCRIPT_DIR/buddy"/*.txt; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    if [ ! -e "$TARGET/buddy/$base" ]; then
      cp "$f" "$TARGET/buddy/$base"
    fi
  done
fi
chmod +x "$TARGET/start.command" "$TARGET/uninstall.command"
echo "  ✓ Files copied"

# Patch ~/.claude/settings.json — use Node so JSON merging is safe
HOOK_CMD="node $TARGET/hook.js"
echo "  → Wiring hooks into $SETTINGS"

node - <<NODE_SCRIPT
const fs = require("fs");
const path = require("path");
const SETTINGS = "$SETTINGS";
const HOOK_CMD = "$HOOK_CMD";

let settings = {};
if (fs.existsSync(SETTINGS)) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  } catch (e) {
    console.error("  ✗ Could not parse existing settings.json:", e.message);
    console.error("    Please fix or delete it, then re-run install.");
    process.exit(1);
  }
}

settings.hooks = settings.hooks || {};
const events = ["Stop", "Notification", "UserPromptSubmit", "PreToolUse"];

for (const event of events) {
  settings.hooks[event] = settings.hooks[event] || [];

  // Look for an existing matcher-less entry we can append to
  let group = settings.hooks[event].find(
    (g) => !g.matcher || g.matcher === "*" || g.matcher === ""
  );
  if (!group) {
    group = { hooks: [] };
    settings.hooks[event].push(group);
  }
  group.hooks = group.hooks || [];

  // Skip if our hook is already wired up
  const already = group.hooks.some(
    (h) => h && h.command && h.command.includes("claude-alert/hook.js")
  );
  if (!already) {
    group.hooks.push({ type: "command", command: HOOK_CMD });
  }
}

// Backup existing settings before overwriting
if (fs.existsSync(SETTINGS)) {
  fs.copyFileSync(SETTINGS, SETTINGS + ".bak");
}
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log("  ✓ Hooks installed for: " + events.join(", "));
console.log("  ✓ Backed up previous settings to settings.json.bak");
NODE_SCRIPT

echo ""
echo "  ───────────────────────────────"
echo "  Installed."
echo ""
echo "  Next: double-click start.command (in $TARGET or in this folder)"
echo "  to launch the dashboard."
echo ""
echo "  To customize your buddy: drop a .txt file into"
echo "    $TARGET/buddy/"
echo ""
read -n 1 -s -r -p "  Press any key to close..."
echo ""
