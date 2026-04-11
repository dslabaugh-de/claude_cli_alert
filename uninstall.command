#!/bin/bash
# claude_cli_alert uninstaller for macOS.
# Double-click in Finder to run.
#
# Removes hook entries from ~/.claude/settings.json and deletes ~/.claude-alert/
set -e

TARGET="$HOME/.claude-alert"
SETTINGS="$HOME/.claude/settings.json"

echo ""
echo "  Claude CLI Alert — uninstaller"
echo "  ═══════════════════════════════"
echo ""

# Strip our hook entries from settings.json
if [ -f "$SETTINGS" ]; then
  echo "  → Removing hook entries from $SETTINGS"
  node - <<NODE_SCRIPT
const fs = require("fs");
const SETTINGS = "$SETTINGS";
let settings;
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
} catch {
  console.log("  (no parseable settings.json — nothing to remove)");
  process.exit(0);
}
if (!settings.hooks) {
  console.log("  (no hooks section)");
  process.exit(0);
}
let removed = 0;
for (const event of Object.keys(settings.hooks)) {
  const groups = settings.hooks[event];
  if (!Array.isArray(groups)) continue;
  for (const group of groups) {
    if (!group || !Array.isArray(group.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(
      (h) => !(h && h.command && h.command.includes("claude-alert/hook.js"))
    );
    removed += before - group.hooks.length;
  }
  // Drop empty groups
  settings.hooks[event] = groups.filter(
    (g) => g && Array.isArray(g.hooks) && g.hooks.length > 0
  );
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}
if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

fs.copyFileSync(SETTINGS, SETTINGS + ".bak");
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n");
console.log("  ✓ Removed " + removed + " hook entr" + (removed === 1 ? "y" : "ies"));
NODE_SCRIPT
fi

# Delete the installed app folder
if [ -d "$TARGET" ]; then
  echo "  → Deleting $TARGET"
  # Preserve the buddy folder so user doesn't lose their custom card on reinstall
  if [ -d "$TARGET/buddy" ]; then
    BACKUP="$HOME/.claude-alert-buddy-backup"
    rm -rf "$BACKUP"
    cp -R "$TARGET/buddy" "$BACKUP"
    echo "  ✓ Backed up buddy folder to $BACKUP"
  fi
  rm -rf "$TARGET"
  echo "  ✓ Removed $TARGET"
fi

echo ""
echo "  Uninstalled."
echo ""
read -n 1 -s -r -p "  Press any key to close..."
echo ""
