# Claude CLI Alert

A tiny local dashboard that lights up and plays a sound when any of your Claude
Code CLI sessions is waiting for input or has finished its work.

- macOS only
- Zero dependencies (Node stdlib — Claude Code already requires Node)
- No data leaves your Mac (everything binds to `127.0.0.1:3737`)
- Branded with the Upstart palette

## Install

1. Download or clone this folder somewhere (Downloads, Desktop, anywhere — it
   doesn't matter, the installer will copy itself to a permanent location).
2. **Double-click `install.command`** in Finder.
   - First time only: macOS may say "claude_cli_alert cannot be opened because
     Apple cannot check it for malicious software." Right-click → Open and
     confirm. This is a one-time Gatekeeper prompt for any unsigned script.
3. The installer:
   - Copies the app to `~/.claude-alert/`
   - Adds Claude Code hook entries to `~/.claude/settings.json`
     (your existing hooks are preserved; the previous file is backed up to
     `settings.json.bak`)
   - Captures all future Claude Code CLI sessions automatically

After install you can delete the folder you downloaded — the app lives at
`~/.claude-alert/`.

## Run the dashboard

**Double-click `start.command`** (either in this folder or in `~/.claude-alert/`).

A Terminal window opens, the server starts, and your default browser opens
`http://localhost:3737`. Drag the tab to whichever monitor you want, fullscreen
it, and leave it there. Closing the Terminal window stops the server.

## What you'll see

- **Idle / Working** sessions appear as light teal tiles.
- **Ready for review** sessions (Claude has finished) turn bright teal.
- **Needs input** sessions (Claude is asking you a question) turn bright yellow,
  the entire page background pulses yellow, and a sound plays from your Mac's
  built-in `Glass.aiff`.
- Click the `×` on any tile to dismiss it.
- Use the "Test alert sound" button at the bottom to verify the audio works.

## Customize your buddy

The right-hand panel shows your "buddy" — a piece of monospace ASCII art that
sits on the dashboard for company.

To swap it: drop **any `.txt` file** into `~/.claude-alert/buddy/`. The
dashboard picks the first `.txt` file alphabetically and renders it as
preformatted text.

The bundled default is **Cinder**, a contemplative chonk:

```
       /\    /\
      ( ·    · )
      (   ..   )
       `------´
```

You can write your own buddy card in any text editor. The dashboard's panel is
~340px wide and uses a 12px monospace font, so cards up to about 38 characters
wide render comfortably. See `buddy/cinder.txt` for a starting template.

## Customize the alert sound

Open `~/.claude-alert/server.js` and change the `ALERT_SOUND` constant near the
top of the file. The full list of built-in macOS sounds is in the comment right
above it: Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr,
Sosumi, Submarine, Tink. They all live at `/System/Library/Sounds/`.

To use your own sound file, point `ALERT_SOUND` at any path containing a
`.aiff`, `.mp3`, `.wav`, or `.m4a` file — `afplay` handles all of them.

## How it works

```
Claude Code CLI session
       │
       │ fires hook event (Stop, Notification, UserPromptSubmit, PreToolUse)
       ▼
~/.claude-alert/hook.js
       │
       │ POST /update with { tabId, state, project, detail }
       ▼
~/.claude-alert/server.js  (127.0.0.1:3737)
       │                  ─── runs `afplay Glass.aiff` on `waiting` transitions
       │
       │ GET /status
       ▼
dashboard.html  (your browser)
       │  renders tiles, applies colors, glows the page when waiting
       ▼
You glance at your 3rd monitor and see who needs attention.
```

There is no Chrome extension, no Claude Desktop integration, no web claude.ai
support — this is **CLI only**. The hook handler is wired up at install time
and called by Claude Code itself; you don't have to start anything before
opening a CLI session.

## Uninstall

**Double-click `uninstall.command`** (in this folder or in `~/.claude-alert/`).

It removes the hook entries from `~/.claude/settings.json` (backing up the
previous file to `settings.json.bak`) and deletes `~/.claude-alert/`. Your
buddy folder is backed up to `~/.claude-alert-buddy-backup/` so you don't lose
custom cards.

## Security notes

- The server binds to `127.0.0.1` only — never exposed on your LAN
- CORS is restricted to `http://localhost:3737`
- No outbound network calls of any kind
- No persistent storage (sessions live in memory only)
- The hook handler reads only what Claude Code hands it on stdin
- Total source: ~600 lines of plain JavaScript with no dependencies

If your IT team wants a code review, the entire surface is `server.js`,
`hook.js`, `dashboard.html`, and the three `.command` shell scripts. Nothing
is minified or obfuscated.
