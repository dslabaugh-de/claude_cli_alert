#!/usr/bin/env node
/**
 * claude_cli_alert hook handler.
 *
 * Reads a Claude Code hook payload from stdin and POSTs the resulting
 * session state to the local dashboard server.
 *
 * Wired up by install.command in ~/.claude/settings.json:
 *   "command": "node ~/.claude-alert/hook.js"
 *
 * Stdlib only. Silently exits on any error so it never breaks Claude.
 */
const http = require("http");

const PORT = 3737;
const HOST = "127.0.0.1";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const event = payload.hook_event_name || payload.event || "";
  const sessionId = payload.session_id || "unknown";
  const cwd = payload.cwd || "";
  const prompt = (payload.prompt || "").trim();
  const tabId = "cli-" + sessionId.slice(0, 8);

  // Project name = last meaningful folder of cwd. If the leaf is a common
  // subfolder (server, src, app, etc.) walk up one level for a better name.
  const parts = cwd.split(/[/\\]/).filter(Boolean);
  const leaf = parts[parts.length - 1] || "";
  const commonSubs = new Set([
    "server", "src", "app", "lib", "scripts", "api",
    "client", "frontend", "backend", "dist", "build", "public",
  ]);
  const project = (commonSubs.has(leaf.toLowerCase()) && parts.length > 1)
    ? parts[parts.length - 2]
    : leaf || "Claude Code";

  let state;
  let detail = null;

  // Intercept slash commands that change session lifecycle immediately
  // rather than waiting for a Stop or Notification hook.
  if (event === "UserPromptSubmit" && prompt) {
    const lower = prompt.toLowerCase();

    // /exit and /quit end the session — remove the tile entirely
    if (lower === "/exit" || lower === "/quit") {
      const req = http.request({
        hostname: HOST,
        port: PORT,
        path: "/session/" + encodeURIComponent(tabId),
        method: "DELETE",
        headers: { "Content-Type": "application/json", "Content-Length": 0 },
        timeout: 2000,
      }, () => process.exit(0));
      req.on("error", () => process.exit(0));
      req.on("timeout", () => { req.destroy(); process.exit(0); });
      req.end();
      return;
    }

    // /clear resets context — poof the old tile off the dashboard
    if (lower === "/clear") {
      state = "poof";
      detail = "Context cleared";
    }

    // /rename <name> — push the new name immediately instead of waiting for scanner
    if (lower.startsWith("/rename ")) {
      const newName = prompt.slice("/rename ".length).trim();
      if (newName) {
        const body = JSON.stringify({
          tabId,
          title: project,
          state: "idle",
          source: "cli",
          detail: null,
          url: cwd,
          sessionName: newName,
          ts: Date.now(),
        });
        const req = http.request({
          hostname: HOST,
          port: PORT,
          path: "/update",
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
          timeout: 2000,
        }, () => process.exit(0));
        req.on("error", () => process.exit(0));
        req.on("timeout", () => { req.destroy(); process.exit(0); });
        req.write(body);
        req.end();
        return;
      }
    }
  }

  if (state === undefined) {
    if (event === "Stop") {
      state = "review";
      detail = "Work complete";
    } else if (event === "Notification") {
      state = "waiting";
      const labels = {
        permission_prompt: "Permission needed",
        idle_prompt: "Idle — waiting for input",
        auth_success: "Auth complete",
        elicitation_dialog: "Question for you",
      };
      const nt = payload.notification_type || "";
      detail = labels[nt] || nt || "Notification";
    } else if (event === "UserPromptSubmit") {
      state = "running";
    } else if (event === "PreToolUse") {
      state = "running";
      const tool = payload.tool_name || "";
      detail = tool ? `Using ${tool}` : null;
    } else {
      state = "running";
    }
  }

  const body = JSON.stringify({
    tabId,
    title: project,
    state,
    source: "cli",
    detail,
    url: cwd,
    ts: Date.now(),
  });

  const req = http.request({
    hostname: HOST,
    port: PORT,
    path: "/update",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 2000,
  }, () => process.exit(0));

  req.on("error", () => process.exit(0));
  req.on("timeout", () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
});

// Hard timeout in case stdin never closes (shouldn't happen, but be safe)
setTimeout(() => process.exit(0), 5000).unref();
