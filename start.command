#!/bin/bash
# Start the Claude CLI Alert dashboard.
# Double-click in Finder to run.
#
# Closes the terminal window = stops the server.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HOME/.claude-alert"

# Prefer the installed copy at ~/.claude-alert/ (canonical location).
# Fall back to running from this folder if user hasn't run install yet.
if [ -f "$TARGET/server.js" ]; then
  APP_DIR="$TARGET"
else
  APP_DIR="$SCRIPT_DIR"
  echo ""
  echo "  ⚠ Running from $SCRIPT_DIR (not yet installed to ~/.claude-alert)."
  echo "    Run install.command first to capture CLI sessions automatically."
  echo ""
fi

if [ ! -f "$APP_DIR/server.js" ]; then
  echo "  ✗ server.js not found in $APP_DIR"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js is not installed."
  exit 1
fi

echo ""
echo "  Claude CLI Alert"
echo "  ════════════════"
echo ""
echo "  Starting server from $APP_DIR"
echo "  Dashboard will open in your default browser."
echo "  Close this Terminal window to stop the server."
echo ""

# Open the dashboard once the server is up
( sleep 1 && open "http://localhost:3737" ) &

cd "$APP_DIR"
exec node server.js
