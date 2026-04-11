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
const BUDDY_DIR = path.join(ROOT, "buddy");

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

// Claude Code writes one JSON file per active CLI session here.
// We scan this directory to discover sessions that haven't fired a hook yet.
const CLAUDE_HOME = path.join(os.homedir(), ".claude");
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_HOME, "sessions");
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, "projects");

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

function scanCliSessions() {
  let files;
  try {
    files = fs.readdirSync(CLAUDE_SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return; // dir doesn't exist yet
  }

  const now = Date.now();
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const { pid, sessionId, cwd } = data;
    if (!pid || !sessionId) continue;

    const tabId = "cli-" + sessionId.slice(0, 8);
    if (dismissedIds.has(tabId)) continue;

    const alive = isPidAlive(pid);

    // NOTE: we intentionally do NOT dedup by cwd — each unique sessionId
    // represents a distinct Claude Code session, even if multiple are
    // running in the same folder. Uniqueness comes from tabId only.

    if (sessions.has(tabId)) {
      // Already tracked — just refresh liveness
      const s = sessions.get(tabId);
      if (!alive && s.state !== "gone") s.state = "gone";
    } else {
      sessions.set(tabId, {
        title: projectNameFromCwd(cwd),
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

// Heuristically extract just the face/portrait lines from a buddy card.
// Looks for a contiguous block starting with an "ears" line (containing /\ /\)
// and ending with a "chin" line (containing ` or ´).
function extractFace(content) {
  const rawLines = content.split("\n");
  // Strip card border characters and trailing whitespace
  const clean = rawLines.map((l) =>
    l
      .replace(/^[│|]\s?/, "")
      .replace(/\s?[│|]\s*$/, "")
      .replace(/\s+$/, "")
  );
  let start = -1;
  let end = -1;
  for (let i = 0; i < clean.length; i++) {
    if (/\/\\.*\/\\/.test(clean[i])) {
      start = i;
      for (let j = i + 1; j < Math.min(i + 8, clean.length); j++) {
        if (/[`´']-+[`´']/.test(clean[j]) || /[`´'][^A-Za-z0-9]+[`´']/.test(clean[j])) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (start < 0 || end < 0) return null;
  // Trim leading common indent so the face sits flush-left
  const slice = clean.slice(start, end + 1);
  const indents = slice.map((l) => (l.match(/^ */) || [""])[0].length);
  const minIndent = Math.min(...indents);
  return slice.map((l) => l.slice(minIndent)).join("\n");
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
  try {
    const raw = await readBody(req, 64 * 1024);
    const body = JSON.parse(raw);
    let { name, content } = body;
    if (!content || typeof content !== "string") {
      return sendJSON(res, 400, { error: "missing content" });
    }
    name = (name || "custom").toString();
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "custom";
    const clean = sanitizeBuddyText(content);

    // Make sure the buddy dir exists (belt + suspenders — install.command
    // should already have created it, but if someone runs from a fresh
    // clone without install, fall back gracefully).
    try {
      fs.mkdirSync(BUDDY_DIR, { recursive: true });
    } catch {}

    const filepath = path.join(BUDDY_DIR, safeName + ".txt");
    try {
      fs.writeFileSync(filepath, clean, "utf8");
    } catch (err) {
      console.log("[import] write failed:", err.code, err.message, "path:", filepath);
      return sendJSON(res, 500, {
        error: `write failed (${err.code || "unknown"}): ${err.message}`,
        path: filepath,
      });
    }
    console.log("[import] wrote", filepath, `(${clean.length} chars)`);
    return sendJSON(res, 200, { ok: true, name: safeName, path: filepath });
  } catch (err) {
    console.log("[import] exception:", err.message);
    return sendJSON(res, 400, { error: "import failed: " + err.message });
  }
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

  const { tabId, title, state, url, ts, detail, source } = body;
  if (!tabId || !state) return sendJSON(res, 400, { error: "missing tabId or state" });

  // Hook update revives a dismissed session
  dismissedIds.delete(tabId);

  const prev = sessions.get(tabId);
  const transitioning = !prev || prev.state !== state;

  // NOTE: previously we removed any other entries sharing this URL on the
  // assumption they were stale. That collapsed legitimate concurrent
  // sessions in the same folder into one tile. Each tabId is unique per
  // Claude session, so we trust it.

  sessions.set(tabId, {
    title: title || "Claude session",
    state,
    url: url || null,
    source: source || "cli",
    detail: detail || null,
    ts: ts || Date.now(),
    lastSeen: Date.now(),
  });

  // Play the alert when a session transitions into "waiting"
  if (transitioning && state === "waiting") {
    playAlert();
  }

  sendJSON(res, 200, { ok: true });
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
    return {
      tabId: id,
      ...s,
      // Preserve the cwd-derived project name as `project` so the UI can
      // show it as a fallback/subtitle, and put the custom name (if any)
      // into `title`.
      project: s.title,
      title: customName || s.title,
      customName: customName || null,
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

// Parse the session JSONL to extract numeric usage stats only.
// Intentionally does NOT capture message text (privacy + CORS exfil hardening).
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
        } else if (d.type === "assistant") {
          stats.assistantMessages++;
          const m = d.message || {};
          if (m.model) stats.model = m.model;
          if (m.usage) {
            const u = m.usage;
            // cache_read_input_tokens is the best proxy for how full the context is
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
    if (!tabId.startsWith("cli-")) continue;
    const sessionId = resolveSessionId(tabId);
    if (!sessionId) continue;
    const jsonlPath = findSessionJsonl(sessionId, session.url);
    if (!jsonlPath) continue;
    promises.push(
      getSessionStats(jsonlPath).then((stats) => {
        results[tabId] = stats;
      })
    );
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
  // Test endpoint: trigger the alert sound on demand
  if (req.method === "POST" && url === "/test-alert") {
    playAlert();
    return sendJSON(res, 200, { ok: true });
  }

  sendText(res, 404, "not found");
});

// Start the session scanner so existing CLI sessions show up immediately.
scanCliSessions();
setInterval(scanCliSessions, 15000);

server.listen(PORT, HOST, () => {
  console.log(`claude_cli_alert running at http://${HOST}:${PORT}`);
  console.log(`Scanning ${CLAUDE_SESSIONS_DIR} every 15s for CLI sessions.`);
});
