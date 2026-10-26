// Operator panel for the CS 1.6 donation server. Vanilla ES module, no build step.
//
// Everything the server sends is untrusted (donor nicknames end up in a database row), so all
// values are escaped before they reach innerHTML.

const state = { token: sessionStorage.getItem("cs16-admin-token") ?? "", data: null, timer: null };

const $ = (id) => document.getElementById(id);

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);

function lock(message) {
  state.token = "";
  sessionStorage.removeItem("cs16-admin-token");
  if (state.timer !== null) { clearInterval(state.timer); state.timer = null; }
  $("app").hidden = true;
  $("auth").hidden = false;
  if (message) {
    $("auth-result").hidden = false;
    $("auth-result").textContent = message;
  }
}

function unlock(token) {
  state.token = token;
  sessionStorage.setItem("cs16-admin-token", token);
  $("auth").hidden = true;
  $("auth-result").hidden = true;
  $("app").hidden = false;
  if (state.timer !== null) clearInterval(state.timer);
  void refresh();
  state.timer = setInterval(() => void refresh(), 2000);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      "x-admin-token": state.token,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let data = null;
  try { data = text === "" ? null : JSON.parse(text); } catch { data = { error: text }; }

  if (response.status === 401) {
    lock("Token rejected by the server (401). Check ADMIN_TOKEN in .env.");
    throw new Error("unauthorized");
  }
  if (!response.ok) throw new Error((data && data.error) || `HTTP ${response.status}`);
  return data;
}

function chip(text, kind = "") {
  return `<span class="chip ${kind}">${esc(text)}</span>`;
}

function renderChips(data) {
  const active = data.active;
  const chips = [
    chip(data.mode.mock ? "DonationAlerts: mock" : "DonationAlerts: live", data.mode.mock ? "warn" : "ok"),
    chip(data.mode.dryRun ? "RCON: dry run" : "RCON: connected", data.mode.dryRun ? "warn" : "ok"),
    chip(`min ${data.mode.minAmount} ${data.mode.currency}`),
  ];
  if (data.mode.simAllowed) chips.push(chip("simulator on", "warn"));
  if (data.statusError) chips.push(chip(`plugin: ${data.statusError}`, "bad"));
  else if (active !== null && active.active !== null) chips.push(chip(`active: ${active.active}`, "ok"));
  else chips.push(chip("nothing active"));

  const verdict = data.stream.verdict;
  if (verdict === "offline") {
    chips.push(chip("stream: no telemetry"));
  } else if (verdict === "stalled") {
    chips.push(chip(`stream stalled ${data.stream.ageSec}s`, "bad"));
  } else if (verdict === "frozen") {
    chips.push(chip("stream frozen", "bad"));
  } else if (verdict === "live") {
    chips.push(chip("stream live", "ok"));
  } else {
    chips.push(chip("stream configured", "warn"));
  }
  $("chips").innerHTML = chips.join("");
}

function renderActive(data) {
  if (data.statusError) {
    $("active").innerHTML = `<span class="tag rejected">plugin unavailable</span> <span class="muted">${esc(data.statusError)}</span>`;
    return;
  }
  const active = data.active;
  if (active === null) {
    $("active").innerHTML = `<span class="muted">no reply from the plugin</span>`;
    return;
  }
  const parts = [active.active === null ? `<span class="tag">idle</span>` : `<span class="tag applied">${esc(active.active)}</span>`];
  if (active.queued !== null) parts.push(`<span class="muted">queued: ${active.queued}</span>`);
  if (active.nick !== null) parts.push(`<span class="muted">nick: ${esc(active.nick)}</span>`);
  parts.push(`<span class="code muted">${esc(active.raw)}</span>`);
  $("active").innerHTML = parts.join(" ");
}

function renderActivities(data) {
  const body = $("activities").querySelector("tbody");
  body.innerHTML = data.activities.map((activity) => `
      <tr data-code="${esc(activity.code)}">
        <td>
          <span class="code">${esc(activity.code)}</span>${activity.overridden ? ` <span class="tag sim">changed</span>` : ""}
          <div class="muted">${esc(activity.title)}</div>
          <div class="muted">${esc(activity.announce)}</div>
        </td>
        <td><input type="number" min="0" step="1" data-field="price" value="${activity.price}"></td>
        <td>${esc(activity.duration)}${activity.rounds === null ? "" : ` x${activity.rounds}`}</td>
        <td><input type="number" min="0" step="1" data-field="cooldownSec" value="${activity.cooldownSec}"></td>
        <td><input type="checkbox" data-field="enabled" ${activity.enabled ? "checked" : ""}></td>
        <td>
          <button type="button" data-action="run">Run</button>
          <button type="button" data-action="save">Save</button>
          ${activity.overridden ? `<button type="button" data-action="reset">Reset</button>` : ""}
          <details><summary>params</summary><textarea data-field="params">${esc(JSON.stringify(activity.params))}</textarea></details>
        </td>
      </tr>`).join("");
}

function renderDonations(data) {
  const rows = data.donations.map((donation) => {
    const status = esc(donation.status);
    return `<tr>
      <td class="code">${esc(donation.receivedAt.slice(11, 19))}</td>
      <td>${esc(donation.amount)} ${esc(donation.currency)}</td>
      <td>${esc(donation.username)}</td>
      <td class="code">${esc(donation.activityCode ?? "-")}</td>
      <td><span class="tag ${status}">${status}</span>${donation.reason ? ` <span class="muted">${esc(donation.reason)}</span>` : ""}</td>
      <td>${donation.source === "sim" ? `<span class="tag sim">sim</span>` : ""}</td>
    </tr>`;
  });
  $("donations").querySelector("tbody").innerHTML = rows.join("") || `<tr><td class="muted">no donations yet</td></tr>`;
}

function renderStream(data) {
  const stream = data.stream;
  if (!stream.configured) {
    $("stream").innerHTML = `<p class="hint">No telemetry yet. The capture container writes <code>status.json</code> and <code>progress.txt</code> into the shared volume; point <code>STREAM_STATUS_DIR</code> at that directory.</p>`;
    return;
  }
  const layout = stream.layout ?? {};
  const progress = stream.progress ?? {};
  const runtime = stream.runtime ?? null;
  const stats = [
    ["target", `${layout.kind ?? "?"} ${layout.label ?? ""}`.trim()],
    ["canvas", `${layout.width ?? "?"}x${layout.height ?? "?"}`],
    ["capture", `${layout.captureWidth ?? "?"}x${layout.captureHeight ?? "?"}`],
    ["bitrate", `${layout.bitrateKbps ?? "?"} kbps`],
    ["audio", layout.audio ? "on" : "off"],
    ["heartbeat age", stream.ageSec === null ? "none" : `${stream.ageSec}s`],
  ];
  if (runtime !== null) {
    stats.push(
      ["client", runtime.xashAlive ? "running" : "gone"],
      ["log silence", runtime.logAgeSec === null ? "-" : `${runtime.logAgeSec}s`],
      ["picture", runtime.frozen === null ? "not sampled" : runtime.frozen ? "static" : "moving"],
      ["client restarts", String(runtime.restarts)],
    );
  }
  if (progress.frame !== undefined || progress.fps !== undefined) {
    stats.push(["frames", progress.frame ?? "-"], ["fps", typeof progress.fps === "number" ? progress.fps.toFixed(1) : "-"]);
  }
  const cells = stats.map(([label, value]) => `<div class="stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("");
  const warnings = [];
  if (stream.verdict === "stalled") {
    warnings.push(`<p class="hint" style="color:var(--bad)">The capture container stopped reporting ${esc(stream.ageSec)}s ago: the encoder or the client is gone.</p>`);
  }
  if (stream.verdict === "frozen") {
    warnings.push(`<p class="hint" style="color:var(--bad)">The client is on the server but the picture does not change: a menu is drawn over the game, or the camera sits on a dead target. The watchdog restarts the client after a few such samples.</p>`);
  }
  if (stream.error) warnings.push(`<p class="hint" style="color:var(--warn)">${esc(stream.error)}</p>`);
  $("stream").innerHTML = `<div class="grid">${cells}</div>${warnings.join("")}`;
}

const editingActivities = () => document.activeElement !== null && $("activities").contains(document.activeElement);

async function refresh() {
  if (state.token === "") return;
  try {
    const data = await api("/api/state");
    state.data = data;
    initPlayer(data.playback);
    renderChips(data);
    renderActive(data);
    renderDonations(data);
    renderHistory(data);
    renderStream(data);
    // A poll must not wipe what the operator is typing: the row inputs and the settings form keep
    // their in-progress values until focus leaves them.
    if (!editingActivities()) renderActivities(data);
    if (!editingActivities()) renderPresets(data);
    $("set-min").placeholder = String(data.mode.minAmount);
    $("set-cooldown").placeholder = String(data.activities[0]?.cooldownSec ?? 60);
  } catch (error) {
    if (String(error.message) !== "unauthorized") {
      $("chips").innerHTML = chip(String(error.message), "bad");
    }
  }
}

function showResult(element, payload) {
  element.hidden = false;
  element.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function flashChip(text, kind = "bad") {
  $("chips").innerHTML = chip(text, kind);
}

function renderPresets(data) {
  const prices = [...new Set(data.activities.map((activity) => activity.price))].sort((left, right) => left - right);
  $("sim-presets").innerHTML = prices
    .map((price) => `<button type="button" data-amount="${price}">${price}</button>`)
    .join("");
}

function renderHistory(data) {
  const rows = data.adminActions.map((action) => {
    const reply = (action.reply ?? "").split("\n").filter((line) => line.trim() !== "").pop() ?? "";
    return `<tr>
      <td class="code">${esc(action.at.slice(11, 19))}</td>
      <td>${esc(action.kind)}</td>
      <td class="code">${esc(action.code ?? "-")}</td>
      <td class="code">${esc(action.command ?? "")}</td>
      <td class="muted">${esc(reply)}</td>
    </tr>`;
  });
  $("history").querySelector("tbody").innerHTML = rows.join("") || `<tr><td class="muted">nothing yet</td></tr>`;
}

// --- player -----------------------------------------------------------------------------------

const playerState = { hls: null };

function playerBadge(text, kind = "") {
  const badge = $("player-badge");
  badge.textContent = text;
  badge.className = `chip ${kind}`;
}

/**
 * HLS through hls.js, because MediaMTX cannot send AAC over WebRTC (it drops the audio track).
 * The URL is built from the page's own host, so the same page works on 127.0.0.1 and from a phone
 * in the LAN. Muted autoplay is allowed by browsers; sound needs the button below (a user gesture).
 */
function initPlayer(playback) {
  const video = $("player");
  const url = `http://${location.hostname}:${playback.port}/${playback.path}/index.m3u8`;
  $("player-hint").textContent = `HLS: ${url}`;

  const Hls = window.Hls;
  if (Hls === undefined) {
    if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
      video.src = url;
      playerBadge("native HLS", "ok");
    } else {
      playerBadge("player not loaded", "bad");
    }
    return;
  }
  if (playerState.hls !== null) return;

  const hls = new Hls({ lowLatencyMode: true, backBufferLength: 10, liveSyncDurationCount: 3 });
  playerState.hls = hls;

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    playerBadge("buffering", "warn");
    void video.play().catch(() => playerBadge("press play", "warn"));
  });
  video.addEventListener("playing", () => playerBadge("live", "ok"));
  video.addEventListener("waiting", () => playerBadge("buffering", "warn"));

  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // The hub is not running or restarted: retry quietly, the state poll shows the encoders health.
      playerBadge("offline", "bad");
      window.setTimeout(() => { try { hls.startLoad(); } catch { /* the next poll tries again */ } }, 3000);
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      playerBadge("recovering", "warn");
      try { hls.recoverMediaError(); } catch { /* ignore */ }
      return;
    }
    playerBadge("player error", "bad");
  });

  hls.loadSource(url);
  hls.attachMedia(video);
}

// --- events -----------------------------------------------------------------------------------

$("auth-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const token = $("auth-token").value.trim();
  if (token !== "") unlock(token);
});

$("sim-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    amount: Number($("sim-amount").value),
    username: $("sim-user").value,
    message: $("sim-message").value,
    bypassCooldown: $("sim-bypass").checked,
  };
  try {
    const result = await api("/api/simulate", { method: "POST", body });
    showResult($("sim-result"), { ...result.outcome, activity: result.activity });
    await refresh();
  } catch (error) {
    showResult($("sim-result"), String(error.message));
  }
});

$("sim-presets").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-amount]");
  if (button !== null) $("sim-amount").value = button.dataset.amount;
});

$("activities").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (button === null) return;
  const row = button.closest("tr[data-code]");
  const code = row.dataset.code;
  const field = (name) => row.querySelector(`[data-field="${name}"]`);

  try {
    switch (button.dataset.action) {
      case "run": {
        // The parameters in the row are what actually goes to the server: the panel is the only
        // place where they can be changed, so a run must not quietly use the catalogue defaults.
        const paramsText = field("params").value.trim();
        const body = { code };
        if (paramsText !== "") {
          try { body.params = JSON.parse(paramsText); } catch { throw new Error("params: not valid JSON"); }
        }
        const response = await api("/api/trigger", { method: "POST", body });
        showResult($("action-result"), { command: response.command, reply: response.reply });
        button.textContent = "queued";
        setTimeout(() => { button.textContent = "Run"; }, 1200);
        break;
      }
      case "save": {
        const paramsText = field("params").value.trim();
        let params;
        if (paramsText !== "") {
          try { params = JSON.parse(paramsText); } catch { throw new Error("params: not valid JSON"); }
        }
        await api(`/api/activity/${code}`, {
          method: "POST",
          body: {
            price: Number(field("price").value),
            cooldownSec: Number(field("cooldownSec").value),
            enabled: field("enabled").checked,
            ...(params === undefined ? {} : { params }),
          },
        });
        break;
      }
      case "reset":
        await api(`/api/activity/${code}/reset`, { method: "POST", body: {} });
        break;
      default:
        break;
    }
    await refresh();
  } catch (error) {
    flashChip(`${code}: ${String(error.message)}`);
  }
});

$("clear-all").addEventListener("click", async () => {
  try {
    const response = await api("/api/clear", { method: "POST", body: {} });
    flashChip(response.reply || "cleared", "warn");
    await refresh();
  } catch (error) {
    flashChip(String(error.message));
  }
});

$("sim-reset").addEventListener("click", async () => {
  try {
    const response = await api("/api/sim-reset", { method: "POST", body: {} });
    flashChip(`deleted ${response.deleted} simulated rows`, "warn");
    await refresh();
  } catch (error) {
    flashChip(String(error.message));
  }
});

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {};
  const min = $("set-min").value.trim();
  const cooldown = $("set-cooldown").value.trim();
  if (min !== "") body.minAmount = Number(min);
  if (cooldown !== "") body.defaultCooldownSec = Number(cooldown);
  try {
    const response = await api("/api/settings", { method: "POST", body });
    $("settings-result").textContent = `saved: min ${response.minAmount}, default cooldown ${response.defaultCooldownSec}s`;
    await refresh();
  } catch (error) {
    $("settings-result").textContent = String(error.message);
  }
});

// --- boot -------------------------------------------------------------------------------------

$("player-sound").addEventListener("click", () => {
  const video = $("player");
  video.muted = !video.muted;
  $("player-sound").textContent = video.muted ? "Sound on" : "Mute";
  // Unmuting is a user gesture, so playback is allowed to start even if autoplay was blocked.
  if (!video.muted) void video.play().catch(() => playerBadge("press play", "warn"));
});

$("player-full").addEventListener("click", () => {
  const video = $("player");
  if (document.fullscreenElement !== null) void document.exitFullscreen();
  else void video.requestFullscreen?.();
});

if (state.token === "") lock();
else unlock(state.token);
