#!/usr/bin/env node
/**
 * claude_cli_alert — local dashboard for Claude Code CLI hook events.
 *
 * Node stdlib only. No npm install. No external network calls.
 * Binds to 127.0.0.1:3737. Plays a Mac system sound on `waiting`.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { spawn, exec, execSync } = require("child_process");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = 3737;
const HOST = "127.0.0.1";
const ROOT = __dirname;
// Buddy dir lives next to server.js. Whether that's ~/.claude-alert/ (after
// install.command) or a cloned repo, it works the same way.
const BUDDY_DIR = path.join(ROOT, "buddy");

// Make sure the buddy dir exists at startup so imports always have
// somewhere to land, even on a barebones install.
try { fs.mkdirSync(BUDDY_DIR, { recursive: true }); } catch {}

// Alert sound is platform-aware. On Mac we use /System/Library/Sounds/*.aiff
// via afplay. On Windows we use C:\Windows\Media\*.wav via PowerShell's
// SoundPlayer. The user's choice is persisted to ~/.claude-alert-config.json.
const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

const MAC_SOUND_DIR = "/System/Library/Sounds";
const MAC_SOUND_NAMES = [
  "Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero",
  "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink",
];

const WIN_SOUND_DIR = "C:\\Windows\\Media";
// A curated shortlist — C:\Windows\Media has dozens, but these are the
// short, recognizable ones that work well as an alert.
const WIN_SOUND_NAMES = [
  "chimes", "chord", "ding", "notify", "tada", "recycle",
  "Alarm01", "Alarm02", "Alarm03",
  "Ring01", "Ring02", "Ring03",
];

function platformSoundDir() { return IS_MAC ? MAC_SOUND_DIR : WIN_SOUND_DIR; }
function platformSoundNames() { return IS_MAC ? MAC_SOUND_NAMES : IS_WIN ? WIN_SOUND_NAMES : []; }
function platformSoundExt() { return IS_MAC ? ".aiff" : ".wav"; }
function platformDefaultSound() { return IS_MAC ? "Glass" : "chimes"; }

const CONFIG_PATH = path.join(os.homedir(), ".claude-alert-config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    return true;
  } catch {
    return false;
  }
}

let config = loadConfig();
if (!config.alertSound) config.alertSound = platformDefaultSound();
if (!config.customNames) config.customNames = {};

function resolveAlertSoundPath() {
  if (config.alertSound === "mute") return null;
  const name = config.alertSound;
  const supported = platformSoundNames();
  // If the persisted choice isn't valid on this platform (e.g. user imported
  // a config from a different OS), fall back to platform default.
  if (!supported.includes(name)) return path.join(platformSoundDir(), platformDefaultSound() + platformSoundExt());
  return path.join(platformSoundDir(), name + platformSoundExt());
}

// Sessions go to "gone" after this many ms with no hook activity.
const GONE_AFTER_MS = 4 * 60 * 60 * 1000; // 4 hours
const GONE_PRUNE_MS = 10 * 60 * 1000; // remove gone sessions after 10 minutes

// Claude Code writes one JSON file per active CLI session here.
// We scan this directory to discover sessions that haven't fired a hook yet.
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_HOME, "sessions");
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");
const CLAUDE_HISTORY_FILE = path.join(CLAUDE_HOME, "history.jsonl");

// Codex writes JSONL session files here: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
const CODEX_HOME = path.join(os.homedir(), ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const CODEX_ACTIVE_WINDOW_MS = 2 * 60 * 1000; // only show recently active running Codex sessions

// Per-file tracking for the Codex watcher: filename → { tabId, bytesRead, state, cwd, title, ts }
const codexFileState = new Map();

// Context window sizes by model family
const CONTEXT_WINDOWS = {
  opus:   1000000,
  sonnet:  200000,
  haiku:   200000,
};
function getContextWindow(model) {
  if (!model) return 200000;
  const m = model.toLowerCase();
  if (m.includes("opus"))   return CONTEXT_WINDOWS.opus;
  if (m.includes("sonnet")) return CONTEXT_WINDOWS.sonnet;
  if (m.includes("haiku"))  return CONTEXT_WINDOWS.haiku;
  return 200000;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const sessions = new Map();
const dismissedIds = new Set();

// ---------------------------------------------------------------------------
// Process liveness (cross-platform)
// ---------------------------------------------------------------------------
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${Number(pid)}" /NH`, {
        encoding: "utf8",
        timeout: 3000,
      });
      return out.includes(String(pid));
    }
    // Unix/Mac: kill -0 throws ESRCH if the process is gone, returns 0 if alive.
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session scanner — reads ~/.claude/sessions/*.json
// ---------------------------------------------------------------------------
function projectNameFromCwd(cwd) {
  const parts = (cwd || "").split(/[/\\]/).filter(Boolean);
  const leaf = parts[parts.length - 1] || "";
  const commonSubs = new Set([
    "server", "src", "app", "lib", "scripts", "api",
    "client", "frontend", "backend", "dist", "build", "public",
  ]);
  if (commonSubs.has(leaf.toLowerCase()) && parts.length > 1) {
    return parts[parts.length - 2];
  }
  return leaf || "Claude Code";
}


// If the session file's conversation JSONL is stale (>2h old) and a newer
// conversation exists in the same project dir, the user started a fresh session.
// Retire the old tile so it doesn't ghost the active one.
function isSessionJsonlStale(sessionId, cwd) {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  // cwdToProjectDir is lossy (dots in dir names), so scan all project dirs
  // to find the one containing this sessionId's JSONL.
  let ownMtime = 0;
  let projPath = null;
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, sessionId + ".jsonl");
      if (fs.existsSync(candidate)) {
        ownMtime = fs.statSync(candidate).mtimeMs;
        projPath = path.join(CLAUDE_PROJECTS_DIR, dir);
        break;
      }
    }
  } catch { return false; }
  if (!ownMtime || !projPath) return true; // JSONL not found — treat as stale
  if (Date.now() - ownMtime < TWO_HOURS) return false; // still fresh
  // A newer JSONL in the same project dir means user started a new conversation
  try {
    const files = fs.readdirSync(projPath).filter(f => f.endsWith(".jsonl"));
    const newestMtime = Math.max(...files.map(f => {
      try { return fs.statSync(path.join(projPath, f)).mtimeMs; } catch { return 0; }
    }));
    return newestMtime > ownMtime;
  } catch { return false; }
}


// When a session file has a name but its JSONL is stale (conversation was cleared),
// find any hook-only session whose JSONL lives in the same project dir and propagate
// the name — so /rename always shows up on the active tile.
function propagateNameToProjectSessions(sessionId, name) {
  if (!name) return;
  // Find the project dir that contains this sessionId's JSONL
  let projPath = null;
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      if (fs.existsSync(path.join(CLAUDE_PROJECTS_DIR, dir, sessionId + ".jsonl"))) {
        projPath = path.join(CLAUDE_PROJECTS_DIR, dir);
        break;
      }
    }
  } catch {}
  if (!projPath) return;

  // Find hook-only sessions (no pid) whose JSONL is in the same project dir
  for (const [tabId, s] of sessions) {
    if (s.pid) continue; // skip scanner-sourced sessions
    const hookSessionId = tabId.startsWith("cli-") ? tabId.slice(4) : null;
    if (!hookSessionId) continue;
    // Check by looking for full UUID — expand prefix to full UUID
    let fullId = null;
    try {
      for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
        const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
        try {
          for (const f of fs.readdirSync(dirPath)) {
            if (f.endsWith(".jsonl") && f.startsWith(hookSessionId)) {
              if (path.join(CLAUDE_PROJECTS_DIR, dir) === projPath) {
                fullId = f.replace(".jsonl", "");
              }
            }
          }
        } catch {}
      }
    } catch {}
    if (fullId) {
      s.sessionName = name;
      // Clear customName so terminal /rename beats dashboard click-rename
      if (config.customNames && config.customNames[tabId]) {
        delete config.customNames[tabId];
        saveConfig(config);
      }
    }
  }
}

function scanCliSessions() {
  let files;
  try {
    files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return; // dir doesn't exist yet
  }

  const now = Date.now();

  // Build a set of tabIds that have a real session file so we can
  // identify and expire ghost sessions (created only from hook events).
  const fileTabIds = new Set();
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const { pid, sessionId, cwd, name, entrypoint } = data;
    if (!pid || !sessionId) continue;
    if (entrypoint && entrypoint !== "cli") continue;

    const tabId = "cli-" + sessionId.slice(0, 8);
    fileTabIds.add(tabId);
    if (dismissedIds.has(tabId)) continue;

    const alive = isPidAlive(pid);

    if (sessions.has(tabId)) {
      // Already tracked — just refresh liveness
      const s = sessions.get(tabId);
      if (!alive && s.state !== "gone") s.state = "gone";
      if (alive && isSessionJsonlStale(sessionId, cwd)) s.state = "gone";
      if (alive) s.lastSeen = now;
      // The scanner's session file can lag behind a terminal /rename hook.
      // Only backfill a name from disk when we don't already have one.
      if (name && !s.sessionName) s.sessionName = name;
    } else if (isSessionJsonlStale(sessionId, cwd)) {
      // Stale: don't create tile, but propagate /rename to active hook session
      propagateNameToProjectSessions(sessionId, name);
    } else {
      sessions.set(tabId, {
        title: projectNameFromCwd(cwd),
        sessionName: name || null,
        state: alive ? "idle" : "gone",
        url: cwd || null,
        source: "cli",
        detail: null,
        ts: data.startedAt || now,
        lastSeen: alive ? now : (data.startedAt || now),
        pid,
      });
    }
  }

  // Expire ghost sessions: hook-created sessions with no session file
  // that haven't received a hook event in 5 minutes.
  const GHOST_TTL = 5 * 60 * 1000;
  for (const [tabId, s] of sessions) {
    if (!fileTabIds.has(tabId) && !dismissedIds.has(tabId)) {
      if (now - s.lastSeen > GHOST_TTL && s.state !== "gone") {
        s.state = "gone";
      }
    }
  }

  // Prune dead CLI sessions after they've sat in "gone" long enough.
  for (const [tabId, s] of sessions) {
    if (!tabId.startsWith("cli-")) continue;
    if (dismissedIds.has(tabId)) continue;
    if (s.state === "gone" && now - (s.lastSeen || s.ts || now) > GONE_PRUNE_MS) {
      sessions.delete(tabId);
    }
  }
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------
function playAlert() {
  const sound = resolveAlertSoundPath();
  if (!sound) return;
  if (!fs.existsSync(sound)) {
    console.log("[alert] sound file missing:", sound);
    return;
  }
  if (IS_MAC) {
    exec(`afplay "${sound}"`, (err) => {
      if (err) console.log("[alert] afplay error:", err.message);
    });
  } else if (IS_WIN) {
    // PowerShell SoundPlayer via exec() — running through the shell keeps
    // the child properly attached to the user's audio session, which
    // stdio:"ignore" + windowsHide spawn can break on some setups.
    const safe = sound.replace(/'/g, "''");
    const cmd = `powershell -NoProfile -Command "(New-Object Media.SoundPlayer '${safe}').PlaySync()"`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) console.log("[alert] powershell error:", err.message, stderr);
    });
  }
  console.log("[alert] playing", sound);
}

// ---------------------------------------------------------------------------
// Buddy card
// ---------------------------------------------------------------------------
// Remove characters that don't render cleanly in a monospace grid:
// stars / sparkles (not 1-cell wide in most fonts), emoji, and tabs.
function sanitizeBuddyText(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[★☆✦✧✩✪✫✬✭✮✯✰⭐🌟⚡✨]/g, " ")
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, ""); // emoji planes
}

// ----- Face extraction from a buddy card -----
// Uses the positional convention every card follows:
//
//   ╭────────────────────────╮
//   │                        │
//   │  RARITY            SIZE│   ← block 0: rating/type
//   │                        │
//   │   /\    /\             │   ← block 1: FACE
//   │  ( ·    · )            │
//   │  (   ..   )            │
//   │   `------´             │
//   │                        │
//   │  Name                  │   ← block 2: name
//   │                        │
//   │  "Description..."      │   ← block 3: description
//   │  ...                   │
//   │                        │
//   │  STAT1  ████░░  38     │   ← block 4+: stats / quote / etc
//   ╰────────────────────────╯
//
// Blocks are just "contiguous non-empty lines separated by blank lines"
// after stripping the card's outer border. The face is block index 1
// (or block 0 if there's no rating line).

function stripCardBorders(lines) {
  // Drop rows that are pure border (top/bottom edge), then strip
  // leading/trailing vertical border chars from the remaining lines.
  return lines
    .filter((l) => !/^\s*[╭╮╰╯─━═┌┐└┘]+\s*$/.test(l))
    .map((l) =>
      l
        .replace(/^\s*[│|║]\s?/, "")
        .replace(/\s?[│|║]\s*$/, "")
        .replace(/\s+$/, "")
    );
}

function dedent(lines) {
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length === 0) return lines;
  const indents = nonEmpty.map((l) => (l.match(/^ */) || [""])[0].length);
  const minIndent = Math.min(...indents);
  return lines.map((l) => l.slice(minIndent));
}

function splitIntoBlocks(lines) {
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim()) {
      current.push(line);
    } else if (current.length) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length) blocks.push(current);
  return blocks;
}

function extractFace(content) {
  const clean = stripCardBorders(content.split("\n"));
  const blocks = splitIntoBlocks(clean);
  if (blocks.length === 0) return null;

  // Positional convention: block 0 = rating/type, block 1 = face.
  // If block 0 is a single line (the rating row), the face is block 1.
  // Otherwise block 0 IS the face (cards without a rating row).
  let faceBlock;
  if (blocks[0].length === 1 && blocks.length >= 2) {
    faceBlock = blocks[1];
  } else {
    faceBlock = blocks[0];
  }
  if (!faceBlock || faceBlock.length === 0) return null;
  return dedent(faceBlock).join("\n");
}

function readBuddyCard() {
  try {
    const files = fs.readdirSync(BUDDY_DIR).filter((f) => f.endsWith(".txt"));
    if (files.length === 0) return null;
    // Most recently modified wins, so a fresh import becomes active immediately
    files.sort((a, b) => {
      const ma = fs.statSync(path.join(BUDDY_DIR, a)).mtimeMs;
      const mb = fs.statSync(path.join(BUDDY_DIR, b)).mtimeMs;
      return mb - ma;
    });
    const raw = fs.readFileSync(path.join(BUDDY_DIR, files[0]), "utf8");
    const content = sanitizeBuddyText(raw);
    return {
      name: files[0].replace(/\.txt$/, ""),
      content,
      face: extractFace(content),
    };
  } catch {
    return null;
  }
}

async function handleBuddyImport(req, res) {
  console.log("[import] received request");
  let raw, body;
  try {
    raw = await readBody(req, 64 * 1024);
  } catch (err) {
    console.log("[import] body read failed:", err.message);
    return sendJSON(res, 400, { error: "read body failed: " + err.message });
  }
  try {
    body = JSON.parse(raw);
  } catch (err) {
    console.log("[import] JSON parse failed:", err.message);
    return sendJSON(res, 400, { error: "JSON parse failed: " + err.message });
  }
  const content = body && body.content;
  if (!content || typeof content !== "string" || !content.trim()) {
    console.log("[import] empty content");
    return sendJSON(res, 400, { error: "missing or empty content" });
  }
  const clean = sanitizeBuddyText(content);

  // Try candidate dirs in order. Record every attempt so we can show
  // the user exactly what happened if they all fail.
  const candidates = [
    BUDDY_DIR,
    path.join(os.homedir(), ".claude-alert", "buddy"),
    path.join(os.homedir(), ".claude-alert-buddy"),
  ];
  const attempts = [];
  let writtenTo = null;
  const filename = "imported.txt";

  for (const dir of candidates) {
    const attempt = { dir, step: null, error: null };
    try {
      attempt.step = "mkdir";
      fs.mkdirSync(dir, { recursive: true });
      attempt.step = "write";
      const filepath = path.join(dir, filename);
      fs.writeFileSync(filepath, clean, "utf8");
      attempt.step = "ok";
      attempts.push(attempt);
      writtenTo = filepath;
      console.log("[import] wrote", filepath, `(${clean.length} chars)`);
      break;
    } catch (err) {
      attempt.error = (err.code || "?") + ": " + err.message;
      attempts.push(attempt);
      console.log("[import] candidate failed at", attempt.step, "->", dir, ":", attempt.error);
    }
  }

  if (!writtenTo) {
    const summary = attempts
      .map((a) => `${a.dir} [${a.step}] ${a.error}`)
      .join(" | ");
    return sendJSON(res, 500, {
      error: "all candidate dirs failed: " + summary,
      attempts,
    });
  }

  // Mirror into BUDDY_DIR if we landed elsewhere so readBuddyCard
  // (which only looks in BUDDY_DIR) can see the new file.
  if (writtenTo !== path.join(BUDDY_DIR, filename)) {
    try {
      fs.mkdirSync(BUDDY_DIR, { recursive: true });
      fs.writeFileSync(path.join(BUDDY_DIR, filename), clean, "utf8");
      console.log("[import] mirrored to", path.join(BUDDY_DIR, filename));
    } catch (err) {
      console.log("[import] mirror failed:", err.code, err.message);
    }
  }

  return sendJSON(res, 200, { ok: true, path: writtenTo });
}

// ---------------------------------------------------------------------------
// Sound chooser endpoints
// ---------------------------------------------------------------------------
function handleSoundsList(res) {
  const available = [];
  const names = platformSoundNames();
  const dir = platformSoundDir();
  const ext = platformSoundExt();
  for (const name of names) {
    const p = path.join(dir, name + ext);
    if (fs.existsSync(p)) available.push(name);
  }
  sendJSON(res, 200, {
    platform: process.platform,
    sounds: available,
    current: config.alertSound,
    default: platformDefaultSound(),
  });
}

async function handleSoundSet(req, res) {
  try {
    const raw = await readBody(req, 4 * 1024);
    const body = JSON.parse(raw);
    const { sound } = body;
    if (!sound || typeof sound !== "string") {
      return sendJSON(res, 400, { error: "missing sound" });
    }
    // Allow "mute" or any sound known to this platform.
    if (sound !== "mute" && !platformSoundNames().includes(sound)) {
      return sendJSON(res, 400, { error: "unknown sound for this platform" });
    }
    config.alertSound = sound;
    saveConfig(config);
    return sendJSON(res, 200, { ok: true, current: sound });
  } catch (err) {
    return sendJSON(res, 400, { error: "set failed: " + err.message });
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "http://localhost:" + PORT,
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleUpdate(req, res) {
  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw);
  } catch (err) {
    console.warn(`[bad-json] POST /update: ${err.message}`);
    return sendJSON(res, 400, { error: "bad json" });
  }

  const { tabId, title, state, url, ts, detail, source, sessionName } = body;
  if (!tabId || !state) return sendJSON(res, 400, { error: "missing tabId or state" });

  // Hook update revives a dismissed session
  dismissedIds.delete(tabId);

  // /rename from terminal: clear any dashboard customName so sessionName takes effect
  if (sessionName !== undefined && config.customNames && config.customNames[tabId]) {
    delete config.customNames[tabId];
    saveConfig(config);
  }

  const prev = sessions.get(tabId);
  const transitioning = !prev || prev.state !== state;

  // NOTE: previously we removed any other entries sharing this URL on the
  // assumption they were stale. That collapsed legitimate concurrent
  // sessions in the same folder into one tile. Each tabId is unique per
  // Claude session, so we trust it.

  // Preserve the first-seen timestamp so the "started at" display stays
  // stable. Only new sessions get a fresh ts; subsequent hook events just
  // update the live fields.
  sessions.set(tabId, {
    ...(prev || {}),
    title: title || (prev && prev.title) || "Claude session",
    sessionName: sessionName !== undefined ? sessionName : ((prev && prev.sessionName) || null),
    state,
    url: url || (prev && prev.url) || null,
    source: source || (prev && prev.source) || "cli",
    detail: detail || null,
    ts: (prev && prev.ts) || ts || Date.now(),
    lastSeen: Date.now(),
  });

  // Play the alert when a session transitions into "waiting"
  if (transitioning && state === "waiting") {
    playAlert();
  }

  // Poof: auto-dismiss the old session after the animation has played
  if (transitioning && state === "poof") {
    setTimeout(() => {
      sessions.delete(tabId);
      dismissedIds.add(tabId);
    }, 2500);
  }

  sendJSON(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// First-prompt cache — reads ~/.claude/history.jsonl and maps each
// sessionId to the first `display` entry (the first user prompt typed in
// that session). Also tracks /clear events so the scanner can poof tiles.
// Re-read when the file's mtime changes.
// ---------------------------------------------------------------------------
let historyCache = { mtime: 0, byId: new Map(), clears: [] };
let lastClearCheckTs = Date.now();

function refreshHistoryCache() {
  let stat;
  try {
    stat = fs.statSync(CLAUDE_HISTORY_FILE);
  } catch {
    return;
  }
  if (stat.mtimeMs === historyCache.mtime) return;
  const byId = new Map();
  const clears = [];
  try {
    const raw = fs.readFileSync(CLAUDE_HISTORY_FILE, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (!d.sessionId || !d.display) continue;
      const text = String(d.display).trim();
      if (!text) continue;
      // Track /clear events (history stores them with a trailing space sometimes)
      if (/^\/clear\s*$/i.test(text)) {
        clears.push({ sessionId: d.sessionId, timestamp: d.timestamp || 0 });
        continue;
      }
      // Skip other slash commands and obvious system-injected prompts
      if (text.startsWith("<") || text.startsWith("/")) continue;
      // First-wins: only set if we haven't seen this sessionId yet
      if (!byId.has(d.sessionId)) byId.set(d.sessionId, text);
    }
  } catch {
    return;
  }
  historyCache = { mtime: stat.mtimeMs, byId, clears };
}

// Check history.jsonl for new /clear entries and poof the matching tile.
// Called from the scanCliSessions loop so it runs every 2s.
function checkForClears() {
  refreshHistoryCache();
  const newClears = historyCache.clears.filter(c => c.timestamp > lastClearCheckTs);
  lastClearCheckTs = Date.now();
  for (const { sessionId } of newClears) {
    const tabId = "cli-" + sessionId.slice(0, 8);
    const s = sessions.get(tabId);
    if (!s || dismissedIds.has(tabId) || s.state === "poof") continue;
    sessions.set(tabId, { ...s, state: "poof", detail: "Context cleared", lastSeen: Date.now() });
    setTimeout(() => {
      sessions.delete(tabId);
      dismissedIds.add(tabId);
    }, 2500);
  }
}

function firstPromptForSession(sessionId) {
  refreshHistoryCache();
  return historyCache.byId.get(sessionId) || null;
}

// Get the full sessionId (UUID) for a tabId from the scanned data
function sessionIdForTabId(tabId) {
  if (!tabId || !tabId.startsWith("cli-")) return null;
  const prefix = tabId.slice(4);
  try {
    for (const file of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), "utf8"));
        if (data.sessionId && data.sessionId.startsWith(prefix)) return data.sessionId;
      } catch {}
    }
  } catch {}
  return null;
}

// Read the session's "slug" — Claude Code's three-word auto-generated
// session name (e.g. "elegant-whistling-thunder"). This is what Claude
// Code uses as the internal session name and what /rename should update.
// Cached per JSONL path with mtime invalidation.
const slugCache = new Map(); // path -> { mtime, slug }
function getSessionSlug(sessionId, cwd) {
  const jsonlPath = findSessionJsonl(sessionId, cwd);
  if (!jsonlPath) return null;
  let stat;
  try { stat = fs.statSync(jsonlPath); } catch { return null; }

  const cached = slugCache.get(jsonlPath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.slug;

  // Scan the JSONL looking for the LAST slug entry (so if /rename
  // writes a new slug line, it wins over the auto-generated one).
  let latestSlug = null;
  try {
    const content = fs.readFileSync(jsonlPath, "utf8");
    for (const line of content.split("\n")) {
      if (!line.includes('"slug"')) continue;
      try {
        const d = JSON.parse(line);
        if (d.slug && typeof d.slug === "string") latestSlug = d.slug;
      } catch {}
    }
  } catch {}
  slugCache.set(jsonlPath, { mtime: stat.mtimeMs, slug: latestSlug });
  return latestSlug;
}

function handleStatus(res) {
  const now = Date.now();
  for (const [, s] of sessions) {
    if (now - s.lastSeen > GONE_AFTER_MS && s.state !== "gone") {
      s.state = "gone";
    }
  }
  const list = Array.from(sessions.entries()).map(([id, s]) => {
    const customName = config.customNames && config.customNames[id];
    const fullSessionId = sessionIdForTabId(id);
    const slug = fullSessionId ? getSessionSlug(fullSessionId, s.url) : null;
    const firstPrompt = fullSessionId ? firstPromptForSession(fullSessionId) : null;
    return {
      tabId: id,
      ...s,
      project: s.title,
      title: customName || s.sessionName || s.title,
      customName: customName || null,
      slug,
      firstPrompt,
      waitingSince: s.state === "waiting" ? Math.round((now - s.ts) / 1000) : null,
    };
  });
  const anyWaiting = list.some((s) => s.state === "waiting");
  sendJSON(res, 200, { sessions: list, anyWaiting, checked: now });
}

async function handleRename(req, res, tabId) {
  try {
    const raw = await readBody(req, 4 * 1024);
    const body = JSON.parse(raw);
    const name = (body.name || "").toString().trim().slice(0, 60);
    if (!config.customNames) config.customNames = {};
    if (!name) {
      delete config.customNames[tabId];
    } else {
      config.customNames[tabId] = name;
    }
    saveConfig(config);
    return sendJSON(res, 200, { ok: true, tabId, name: name || null });
  } catch (err) {
    return sendJSON(res, 400, { error: "rename failed: " + err.message });
  }
}

function handleDismiss(res, tabId) {
  sessions.delete(tabId);
  dismissedIds.add(tabId);
  sendJSON(res, 200, { ok: true });
}

function handleBuddy(res) {
  const card = readBuddyCard();
  if (!card) return sendJSON(res, 200, { name: null, content: null });
  sendJSON(res, 200, card);
}

// ---------------------------------------------------------------------------
// Session stats — read Claude's JSONL session logs to extract token usage
// ---------------------------------------------------------------------------
function cwdToProjectDir(cwd) {
  if (!cwd) return null;
  // Claude encodes e.g. "D:\matts\vs_projects\foo" as "D--matts-vs-projects-foo"
  return cwd.replace(/[:\\/]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function findSessionJsonl(sessionId, cwd) {
  if (!sessionId) return null;
  const fname = sessionId + ".jsonl";
  if (cwd) {
    const projDir = cwdToProjectDir(cwd);
    const projPath = path.join(CLAUDE_PROJECTS_DIR, projDir, fname);
    if (fs.existsSync(projPath)) return projPath;
  }
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, fname);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

function resolveSessionId(tabId) {
  if (!tabId || !tabId.startsWith("cli-")) return null;
  const prefix = tabId.slice(4);
  try {
    const files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), "utf8"));
      if (data.sessionId && data.sessionId.startsWith(prefix)) return data.sessionId;
    }
  } catch {}
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const dirPath = path.join(CLAUDE_PROJECTS_DIR, dir);
      if (!fs.statSync(dirPath).isDirectory()) continue;
      for (const f of fs.readdirSync(dirPath)) {
        if (f.endsWith(".jsonl") && f.startsWith(prefix)) return f.replace(".jsonl", "");
      }
    }
  } catch {}
  return null;
}

// Parse the session JSONL to extract usage stats and the most recent
// user/assistant message snippets. Message text is capped at 500 chars.
// This is safe to expose because the server binds to 127.0.0.1 only and
// CORS is restricted to http://localhost:3737.
function getSessionStats(jsonlPath) {
  const stats = {
    model: null,
    contextUsed: 0,
    contextWindow: 200000,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    firstUserMessage: null,
    lastUserMessage: null,
    lastAssistantMessage: null,
  };
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(jsonlPath, { encoding: "utf8" }),
    });
    rl.on("line", (line) => {
      try {
        const d = JSON.parse(line);
        if (d.type === "user") {
          stats.userMessages++;
          const content = (d.message || {}).content;
          let text = null;
          if (typeof content === "string" && content.trim()) {
            text = content;
          } else if (Array.isArray(content)) {
            for (const c of content) {
              if (c && c.type === "text" && c.text && c.text.trim()) {
                text = c.text;
                break;
              }
            }
          }
          // Skip tool-result / system-injected user turns — they start with
          // "<bash-input>", "<system>", JSON, or are just whitespace junk.
          // A real user prompt is a plain sentence.
          const isRealPrompt =
            text &&
            !text.startsWith("<") &&
            !text.startsWith("{") &&
            !text.startsWith("[") &&
            !/^Tool result:/i.test(text) &&
            !/^Caveat:/i.test(text);
          if (isRealPrompt) {
            if (!stats.firstUserMessage) stats.firstUserMessage = text.slice(0, 500);
            stats.lastUserMessage = text.slice(0, 500);
          }
        } else if (d.type === "assistant") {
          stats.assistantMessages++;
          const m = d.message || {};
          if (m.model) stats.model = m.model;
          if (m.usage) {
            const u = m.usage;
            const contextTokens =
              (u.cache_read_input_tokens || 0) +
              (u.cache_creation_input_tokens || 0) +
              (u.input_tokens || 0);
            if (contextTokens > stats.contextUsed) stats.contextUsed = contextTokens;
            stats.totalOutputTokens += u.output_tokens || 0;
            stats.totalInputTokens +=
              (u.input_tokens || 0) +
              (u.cache_read_input_tokens || 0) +
              (u.cache_creation_input_tokens || 0);
          }
          for (const c of m.content || []) {
            if (c && c.type === "tool_use") stats.toolCalls++;
            if (c && c.type === "text" && c.text && c.text.trim()) {
              stats.lastAssistantMessage = c.text.slice(0, 500);
            }
          }
        }
      } catch {}
    });
    rl.on("close", () => {
      stats.contextWindow = getContextWindow(stats.model);
      resolve(stats);
    });
    rl.on("error", () => resolve(stats));
  });
}

async function handleAllSessionStats(res) {
  const results = {};
  const promises = [];
  for (const [tabId, session] of sessions) {
    if (tabId.startsWith("cli-")) {
      const sessionId = resolveSessionId(tabId);
      if (!sessionId) continue;
      const jsonlPath = findSessionJsonl(sessionId, session.url);
      if (!jsonlPath) continue;
      promises.push(
        getSessionStats(jsonlPath).then((stats) => {
          results[tabId] = stats;
        })
      );
    } else if (tabId.startsWith("codex-")) {
      // Find the codexFileState entry for this tabId
      for (const [, fst] of codexFileState) {
        if (fst.tabId !== tabId) continue;
        results[tabId] = {
          model: fst.model || null,
          contextUsed: 0,
          contextWindow: 200000,
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          totalInputTokens: fst.tokenUsage ? (fst.tokenUsage.input_tokens || 0) : 0,
          totalOutputTokens: fst.tokenUsage ? (fst.tokenUsage.output_tokens || 0) : 0,
          firstUserMessage: fst.lastUserMsg || null,
          lastUserMessage: fst.lastUserMsg || null,
          lastAssistantMessage: fst.lastAgentMsg || null,
        };
        break;
      }
    }
  }
  await Promise.all(promises);
  sendJSON(res, 200, results);
}

function handleDashboard(res) {
  try {
    const html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");
    sendText(res, 200, html, "text/html; charset=utf-8");
  } catch {
    sendText(res, 500, "dashboard.html missing");
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  // Strict CORS: only same-origin
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "http://localhost:" + PORT,
      "Access-Control-Allow-Methods": "GET, POST, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    return handleDashboard(res);
  }
  if (req.method === "GET" && url === "/status") {
    return handleStatus(res);
  }
  if (req.method === "POST" && url === "/update") {
    return handleUpdate(req, res);
  }
  if (req.method === "DELETE" && url.startsWith("/session/")) {
    const tabId = decodeURIComponent(url.slice("/session/".length));
    return handleDismiss(res, tabId);
  }
  if (req.method === "POST" && url.startsWith("/session/") && url.endsWith("/rename")) {
    const tabId = decodeURIComponent(url.slice("/session/".length, -"/rename".length));
    return handleRename(req, res, tabId);
  }
  if (req.method === "GET" && url === "/buddy/card") {
    return handleBuddy(res);
  }
  if (req.method === "POST" && url === "/buddy/import") {
    return handleBuddyImport(req, res);
  }
  if (req.method === "GET" && url === "/buddy/dir") {
    return sendJSON(res, 200, {
      buddyDir: BUDDY_DIR,
      home: os.homedir(),
      platform: process.platform,
    });
  }
  if (req.method === "GET" && url === "/sounds") {
    return handleSoundsList(res);
  }
  if (req.method === "POST" && url === "/sound") {
    return handleSoundSet(req, res);
  }
  if (req.method === "GET" && url === "/all-session-stats") {
    return handleAllSessionStats(res);
  }
  if (req.method === "GET" && url === "/fonts/JetBrainsMono-Regular.woff2") {
    try {
      const buf = fs.readFileSync(path.join(ROOT, "fonts", "JetBrainsMono-Regular.woff2"));
      res.writeHead(200, {
        "Content-Type": "font/woff2",
        "Content-Length": buf.length,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      return res.end(buf);
    } catch {
      return sendText(res, 404, "font missing");
    }
  }
  if (req.method === "GET" && (url === "/icon/claude" || url === "/icon/openai")) {
    const file = url === "/icon/claude" ? "claude-icon.svg" : "openai-icon.svg";
    try {
      const buf = fs.readFileSync(path.join(ROOT, file));
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" });
      return res.end(buf);
    } catch {
      return sendText(res, 404, "icon missing");
    }
  }
  // Test endpoint: trigger the alert sound on demand
  if (req.method === "POST" && url === "/test-alert") {
    playAlert();
    return sendJSON(res, 200, { ok: true });
  }

  sendText(res, 404, "not found");
});

// ---------------------------------------------------------------------------
// Codex session watcher — tails ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// ---------------------------------------------------------------------------
function findRecentCodexFiles() {
  const cutoff = Date.now() - CODEX_ACTIVE_WINDOW_MS;
  const results = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return results;
  // Walk YYYY/MM/DD directory structure
  for (const year of fs.readdirSync(CODEX_SESSIONS_DIR)) {
    const yearDir = path.join(CODEX_SESSIONS_DIR, year);
    if (!/^\d{4}$/.test(year) || !fs.statSync(yearDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      for (const day of fs.readdirSync(monthDir)) {
        const dayDir = path.join(monthDir, day);
        if (!fs.statSync(dayDir).isDirectory()) continue;
        for (const file of fs.readdirSync(dayDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = path.join(dayDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs >= cutoff) results.push({ filePath, mtime: stat.mtimeMs });
          } catch { /* skip */ }
        }
      }
    }
  }
  // Only keep the most recent N files — Codex creates one per rollout and
  // they pile up fast. Show the latest 3 so the dashboard stays readable.
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, 3);
}

function scanCodexSessions() {
  const now = Date.now();
  const activeFiles = findRecentCodexFiles();
  const activeFilePaths = new Set(activeFiles.map(f => f.filePath));

  // Drop Codex sessions whose file has gone stale or is no longer active.
  for (const [filePath, fst] of codexFileState) {
    if (!activeFilePaths.has(filePath)) {
      if (fst.tabId) sessions.delete(fst.tabId);
    }
  }

  for (const { filePath, mtime } of activeFiles) {
    if (dismissedIds.has(`codex-${path.basename(filePath)}`)) continue;

    let fst = codexFileState.get(filePath);
    if (!fst) {
      fst = { tabId: null, bytesRead: 0, state: "idle", cwd: null, title: "Codex", ts: now, model: null, tokenUsage: null };
      codexFileState.set(filePath, fst);
    }

    // Read only new bytes since last scan
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
      const stat = fs.fstatSync(fd);
      if (stat.size <= fst.bytesRead) { fs.closeSync(fd); continue; }
      const buf = Buffer.alloc(stat.size - fst.bytesRead);
      fs.readSync(fd, buf, 0, buf.length, fst.bytesRead);
      fs.closeSync(fd);
      fst.bytesRead = stat.size;

      const newLines = buf.toString("utf8").split("\n").filter(l => l.trim());
      for (const line of newLines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.type === "session_meta") {
          const p = obj.payload || {};
          fst.cwd = p.cwd || fst.cwd;
          fst.model = p.model || fst.model;
          const sessionId = p.id || path.basename(filePath, ".jsonl");
          fst.tabId = "codex-" + sessionId.slice(0, 8);
          // Derive title from cwd
          const parts = (fst.cwd || "").split(/[/\\]/).filter(Boolean);
          fst.title = parts[parts.length - 1] || "Codex";
        }

        if (obj.type === "event_msg") {
          const pt = (obj.payload || {}).type;
          if (pt === "task_started" || pt === "user_message") {
            fst.state = "running";
            if (pt === "user_message") fst.lastUserMsg = (obj.payload.message || "").slice(0, 200);
          } else if (pt === "task_complete") {
            fst.state = "idle";
            fst.lastAgentMsg = ((obj.payload || {}).last_agent_message || "").slice(0, 200);
          } else if (pt === "token_count") {
            const info = (obj.payload || {}).info;
            if (info && info.total_token_usage) fst.tokenUsage = info.total_token_usage;
          }
        }
      }
    } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch {} continue; }

    if (!fst.tabId) continue; // no session_meta seen yet
    if (dismissedIds.has(fst.tabId)) continue;

    const recentlyActive = mtime >= now - CODEX_ACTIVE_WINDOW_MS;
    const state = recentlyActive ? fst.state : "gone";

    // Only surface Codex sessions that are actively running now.
    if (state !== "running") {
      sessions.delete(fst.tabId);
      continue;
    }

    const prev = sessions.get(fst.tabId);
    sessions.set(fst.tabId, {
      ...(prev || {}),
      title: fst.title,
      state: "running",
      url: fst.cwd || "",
      source: "codex",
      detail: "Working…",
      tokenUsage: fst.tokenUsage || null,
      ts: (prev && prev.ts) || fst.ts,
      lastSeen: now,
    });

    if (!prev && state === "review") playAlert();
  }
}

// Start the session scanner so existing CLI sessions show up immediately.
scanCliSessions();
checkForClears();
setInterval(() => { scanCliSessions(); checkForClears(); }, 2000);

// Start the Codex watcher in parallel.
scanCodexSessions();
setInterval(scanCodexSessions, 3000);

server.listen(PORT, HOST, () => {
  console.log(`claude_cli_alert running at http://${HOST}:${PORT}`);
  console.log(`Scanning ${CLAUDE_SESSIONS_DIR} every 15s for CLI sessions.`);
  console.log(`Buddy dir: ${BUDDY_DIR}`);
  console.log(`Config:    ${CONFIG_PATH}`);
});
