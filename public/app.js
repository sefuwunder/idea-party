"use strict";
/* Idea Party — shared canvas + mesh WebRTC voice/video + party agent. */

const $ = (s) => document.querySelector(s);

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** localStorage throws on opaque origins (data: URLs) — never let it break boot. */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const S = {
  code: null,
  me: { id: null, name: "", color: "#f5b544" },
  ws: null,
  peers: new Map(), // id -> {name,color,audio,video}
  objects: {},
  lastSeq: 0,
  transform: { x: 0, y: 0, k: 1 },
  tool: "pan",
  color: "yellow",
  selected: null,
  voteMode: false,
  voted: new Set(),
  timerEndsAt: 0,
  pcs: new Map(),
  localStream: null,
  micOn: true,
  camOn: true,
  unread: 0,
  cursors: new Map(), // peerId -> el
  widgetTypes: {}, // name -> WidgetTypeSpec (custom mini apps)
};

const PALETTE = ["yellow", "pink", "blue", "green", "purple", "orange"];

/* ================= routing ================= */
function route() {
  const m = location.hash.match(/^#\/p\/([a-z0-9]{8})$/i);
  if (m) showParty(m[1].toLowerCase());
  else showLanding();
}
window.addEventListener("hashchange", route);

/* ================= landing ================= */
function showLanding() {
  $("#landing").classList.remove("hidden");
  $("#party").classList.add("hidden");
  document.title = "Idea Party";
  if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; }
  const saved = store.get("ideaparty:name");
  if (saved && !$("#nick").value) $("#nick").value = saved;
}

function myName() {
  let n = ($("#nick")?.value || "").trim() || store.get("ideaparty:name") || "";
  if (!n) {
    n = (prompt("Your name for the party?") || "").trim() || "Guest";
  }
  store.set("ideaparty:name", n);
  return n;
}

async function createParty() {
  const name = ($("#party-name").value || "").trim() || "Idea party";
  $("#landing-err").textContent = "";
  try {
    const r = await fetch("/api/parties", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await r.json();
    myName();
    location.hash = "#/p/" + j.code;
  } catch {
    $("#landing-err").textContent = "Couldn't reach the server.";
  }
}

async function joinParty() {
  const code = ($("#join-code").value || "").trim().toLowerCase();
  $("#landing-err").textContent = "";
  if (!/^[a-z0-9]{8}$/.test(code)) {
    $("#landing-err").textContent = "Codes are 8 characters.";
    return;
  }
  try {
    const r = await fetch("/api/parties/" + code);
    if (!r.ok) { $("#landing-err").textContent = "No party with that code."; return; }
    myName();
    location.hash = "#/p/" + code;
  } catch {
    $("#landing-err").textContent = "Couldn't reach the server.";
  }
}

/* ================= party shell ================= */
async function showParty(code) {
  S.code = code;
  S.objects = {}; S.lastSeq = 0; S.peers.clear(); S.pcs.clear();
  S.voteMode = false; S.voted.clear(); S.unread = 0;
  $("#landing").classList.add("hidden");
  $("#party").classList.remove("hidden");
  $("#obj-layer").innerHTML = "";
  $("#stroke-g").innerHTML = "";
  $("#cursor-layer").innerHTML = "";
  $("#chat-msgs").innerHTML = "";
  $("#tiles").innerHTML = "";
  $("#filmstrip").classList.add("hidden");
  $("#chat-panel").classList.add("hidden");
  S.me.name = myName();

  try {
    const j = await (await fetch("/api/parties/" + code)).json();
    $("#party-name-top").textContent = j.name;
    document.title = j.name + " — Idea Party";
  } catch {
    $("#party-name-top").textContent = "Party";
  }
  $("#party-code-top").textContent = code;
  buildPalette();
  connect();
}

function buildPalette() {
  const p = $("#palette");
  p.innerHTML = "";
  for (const c of PALETTE) {
    const b = document.createElement("button");
    b.className = "swatch " + c + (c === S.color ? " active" : "");
    b.title = c;
    b.onclick = () => {
      S.color = c;
      p.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("active", x === b));
      if (S.selected && S.objects[S.selected]?.type === "sticky") {
        send({ t: "op", op: { kind: "edit", id: S.selected, patch: { color: c } } });
      }
    };
    p.appendChild(b);
  }
}

/* ================= websocket ================= */
function send(msg) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(msg));
}

let reconnectTimer = null;
let pingIv = null;
function connect() {
  clearTimeout(reconnectTimer);
  clearInterval(pingIv);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?party=${S.code}`);
  S.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ t: "hello", name: S.me.name }));
    // heartbeat: proxies (Cloudflare et al.) drop sockets idle ~100s
    pingIv = setInterval(() => send({ t: "ping" }), 30000);
  };
  ws.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => {
    clearInterval(pingIv);
    if (!$("#party").classList.contains("hidden")) {
      reconnectTimer = setTimeout(connect, 2000);
    }
  };
}

function handleMsg(m) {
  switch (m.t) {
    case "welcome":
      S.me.id = m.id; S.me.color = m.color;
      for (const p of m.peers) addPeer(p.id, p.name, p.color);
      setWidgetTypes(m.widgetTypes || []);
      for (const { seq, op } of m.canvas) applyOp(seq, op, "history");
      for (const c of m.chat) addChat(c);
      if (m.timer) showTimer(m.timer.endsAt);
      break;
    case "peer-join":
      addPeer(m.id, m.name, m.color);
      addChat({ from: "sys", name: "", text: `${m.name} joined 🎉`, ts: Date.now(), sys: true });
      if (S.localStream) rtcOffer(m.id); // newcomer: I initiate
      break;
    case "peer-leave":
      removePeer(m.id);
      break;
    case "signal":
      rtcSignal(m.from, m.data);
      break;
    case "op":
      applyOp(m.seq, m.op, m.from);
      break;
    case "cursor":
      moveCursor(m);
      break;
    case "chat":
      addChat(m);
      break;
    case "media":
      setPeerMedia(m.from, m.audio, m.video);
      break;
    case "timer":
      showTimer(m.endsAt);
      break;
    case "widget-types":
      setWidgetTypes(m.types || []);
      break;
    case "pong":
      break; // heartbeat reply; the ping itself is what keeps the socket alive
    case "error":
      console.warn("server:", m.message);
      break;
  }
}

function addPeer(id, name, color) {
  S.peers.set(id, { name, color, audio: true, video: true });
  updatePeerCount();
}
function removePeer(id) {
  const p = S.peers.get(id);
  S.peers.delete(id);
  const pc = S.pcs.get(id);
  if (pc) { try { pc.close(); } catch {} S.pcs.delete(id); }
  const tile = document.getElementById("tile-" + id);
  if (tile) tile.remove();
  const cur = S.cursors.get(id);
  if (cur) { cur.remove(); S.cursors.delete(id); }
  if (p) addChat({ from: "sys", name: "", text: `${p.name} left`, ts: Date.now(), sys: true });
  updatePeerCount();
}
function updatePeerCount() {
  document.title = `${$("#party-name-top").textContent} (${S.peers.size + 1}) — Idea Party`;
}

/* ================= board: transform ================= */
const vp = () => $("#viewport");
const boardEl = () => $("#board");

function applyTransform() {
  const { x, y, k } = S.transform;
  boardEl().style.transform = `translate(${x}px,${y}px) scale(${k})`;
}
function screenToBoard(sx, sy) {
  const r = vp().getBoundingClientRect();
  const { x, y, k } = S.transform;
  return { x: (sx - r.left - x) / k, y: (sy - r.top - y) / k };
}
function zoomAt(sx, sy, factor) {
  const t = S.transform;
  const b = screenToBoard(sx, sy);
  t.k = Math.max(0.25, Math.min(3, t.k * factor));
  const r = vp().getBoundingClientRect();
  t.x = sx - r.left - b.x * t.k;
  t.y = sy - r.top - b.y * t.k;
  applyTransform();
}

/* ================= board: ops ================= */
function applyOp(seq, op, from) {
  if (seq <= S.lastSeq) return;
  S.lastSeq = seq;
  switch (op.kind) {
    case "add":
      S.objects[op.obj.id] = { votes: 0, ...op.obj };
      renderObj(op.obj.id);
      break;
    case "move": {
      const o = S.objects[op.id];
      if (o) { o.x = op.x; o.y = op.y; positionEl(op.id); }
      break;
    }
    case "edit": {
      const o = S.objects[op.id];
      if (o) {
        if (op.patch.text !== undefined) o.text = op.patch.text;
        if (op.patch.color !== undefined) o.color = op.patch.color;
        if (op.patch.data !== undefined && o.type === "widget" &&
            o.widget !== "poll" && o.widget !== "checklist") {
          o.data = op.patch.data;
          // Push state into the live iframe instead of rebuilding it.
          const frames = document.querySelectorAll("iframe.wcustom");
          for (const f of frames) {
            if (f.dataset.wid === op.id && f.contentWindow) {
              f.contentWindow.postMessage({ t: "ip-widget-state", id: op.id, data: o.data }, "*");
              return;
            }
          }
        }
        renderObj(op.id);
      }
      break;
    }
    case "del":
      delete S.objects[op.id];
      document.getElementById("obj-" + op.id)?.remove();
      if (S.selected === op.id) S.selected = null;
      break;
    case "vote": {
      const o = S.objects[op.id];
      if (o) { o.votes = (o.votes || 0) + 1; renderObj(op.id); }
      break;
    }
    case "clear":
      S.objects = {};
      $("#obj-layer").innerHTML = "";
      $("#stroke-g").innerHTML = "";
      S.selected = null;
      break;
    case "mode":
      if (op.key === "vote") setVoteMode(op.value);
      break;
  }
}

function setVoteMode(on) {
  S.voteMode = on;
  $("#vote-banner").classList.toggle("hidden", !on);
  for (const id of Object.keys(S.objects)) renderObj(id);
}

function positionEl(id) {
  const o = S.objects[id];
  const elx = document.getElementById("obj-" + id);
  if (o && elx) { elx.style.left = o.x + "px"; elx.style.top = o.y + "px"; }
}

/** Re-render one object. Skips while you're editing it. */
function renderObj(id) {
  const o = S.objects[id];
  if (!o) return;
  let elx = document.getElementById("obj-" + id);
  if (elx && elx.contains(document.activeElement)) { positionEl(id); return; }
  if (elx) elx.remove();
  if (o.type === "stroke") { renderStroke(o); return; }

  elx = document.createElement("div");
  elx.id = "obj-" + id;
  elx.style.left = o.x + "px";
  elx.style.top = o.y + "px";

  if (o.type === "sticky") {
    elx.className = "sticky " + (o.color || "yellow") + (S.selected === id ? " selected" : "");
    elx.innerHTML = `<div class="txt">${esc(o.text || "")}</div>` +
      ((o.votes || 0) > 0 ? `<div class="votes">👍 ${o.votes}</div>` : "") +
      (S.voteMode ? `<button class="vote-btn" ${S.voted.has(id) ? "disabled" : ""}>+1</button>` : "");
    const vb = elx.querySelector(".vote-btn");
    if (vb) vb.addEventListener("pointerdown", (e) => e.stopPropagation());
    if (vb) vb.addEventListener("click", (e) => {
      e.stopPropagation();
      if (S.voted.has(id)) return;
      S.voted.add(id);
      send({ t: "op", op: { kind: "vote", id } });
    });
    const txt = elx.querySelector(".txt");
    txt.addEventListener("dblclick", (e) => { e.stopPropagation(); editText(id, txt); });
  } else if (o.type === "widget") {
    renderWidget(elx, id, o);
  } else { // label
    elx.className = "label-obj" + (S.selected === id ? " selected" : "");
    elx.innerHTML = `<div class="txt">${esc(o.text || "")}</div>`;
    const txt = elx.querySelector(".txt");
    txt.addEventListener("dblclick", (e) => { e.stopPropagation(); editText(id, txt); });
  }
  elx.addEventListener("pointerdown", (e) => onObjPointerDown(e, id));
  $("#obj-layer").appendChild(elx);
}

function renderWidget(elx, id, o) {
  if (o.widget && o.widget !== "poll" && o.widget !== "checklist") {
    renderCustomWidget(elx, id, o);
    return;
  }
  elx.className = "widget " + (o.widget || "poll") + (S.selected === id ? " selected" : "");
  const title = `<div class="w-title">${esc(o.text || "")}</div>`;
  if (o.widget === "checklist") {
    const items = (o.data && o.data.items) || [];
    const done = items.filter((x) => x.done).length;
    elx.innerHTML = title + `<div class="w-kind">✅ checklist · ${done}/${items.length} done</div>` +
      items.map((it, i) =>
        `<button class="w-item${it.done ? " done" : ""}" data-i="${i}">` +
        `<span class="w-box">${it.done ? "✓" : ""}</span>` +
        `<span class="w-item-label">${esc(it.text)}</span></button>`
      ).join("");
    elx.querySelectorAll(".w-item").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ t: "op", op: { kind: "toggle", id, index: +btn.dataset.i } });
      });
    });
  } else { // poll (default)
    const opts = (o.data && o.data.options) || [];
    const total = opts.reduce((a, x) => a + (x.votes || 0), 0);
    elx.innerHTML = title + `<div class="w-kind">📊 poll · ${total} vote${total === 1 ? "" : "s"} — tap to vote</div>` +
      opts.map((op, i) => {
        const pct = total ? Math.round((100 * (op.votes || 0)) / total) : 0;
        return `<button class="w-opt" data-i="${i}">` +
          `<span class="w-bar" style="width:${pct}%"></span>` +
          `<span class="w-opt-label">${esc(op.label)}</span>` +
          `<span class="w-opt-n">${op.votes || 0}</span></button>`;
      }).join("");
    elx.querySelectorAll(".w-opt").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => e.stopPropagation());
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ t: "op", op: { kind: "vote", id, option: +btn.dataset.i } });
      });
    });
  }
  const ttl = elx.querySelector(".w-title");
  ttl.addEventListener("dblclick", (e) => { e.stopPropagation(); editText(id, ttl); });
}

/* ================= custom widget types (mini apps) ================= */

function setWidgetTypes(types) {
  S.widgetTypes = {};
  for (const t of types) S.widgetTypes[t.name] = t;
  // Re-render custom widgets — their code may have changed.
  for (const id of Object.keys(S.objects)) {
    const o = S.objects[id];
    if (o.type === "widget" && o.widget !== "poll" && o.widget !== "checklist") renderObj(id);
  }
  if (!$("#lab-modal").classList.contains("hidden")) refreshLab();
}

/** Render a custom mini-app widget inside a sandboxed iframe. */
function renderCustomWidget(elx, id, o) {
  const type = S.widgetTypes[o.widget];
  elx.className = "widget wcustom-wrap" + (S.selected === id ? " selected" : "");
  elx.innerHTML = `<div class="w-title">${esc(o.text || "")}</div>` +
    `<div class="w-kind">🧩 ${esc(type ? type.title : o.widget)}${type ? "" : " · unknown type"}</div>`;
  const ttl = elx.querySelector(".w-title");
  ttl.addEventListener("dblclick", (e) => { e.stopPropagation(); editText(id, ttl); });
  if (!type || typeof WidgetLib === "undefined") return;
  const f = document.createElement("iframe");
  f.className = "wcustom";
  f.dataset.wid = id;
  f.setAttribute("sandbox", "allow-scripts");
  f.setAttribute("title", type.title);
  f.style.height = (type.height || 240) + "px";
  f.srcdoc = WidgetLib.buildWidgetSrcdoc(type, id, o.data || {});
  // Clicks inside the iframe shouldn't start a board drag.
  f.addEventListener("pointerdown", (e) => e.stopPropagation());
  elx.appendChild(f);
}

/** Bridge: sandboxed widget iframes talk to the board via postMessage. */
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || typeof d !== "object") return;
  const frames = document.querySelectorAll("iframe.wcustom");
  let src = null;
  for (const f of frames) if (f.contentWindow === e.source) { src = f; break; }
  if (!src) return;
  const wid = src.dataset.wid;
  if (d.t === "ip-widget-set" && wid && S.objects[wid]) {
    const data = d.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      try {
        if (JSON.stringify(data).length <= 16384)
          send({ t: "op", op: { kind: "edit", id: wid, patch: { data } } });
      } catch {}
    }
  } else if (d.t === "ip-widget-resize" && Number.isFinite(d.height)) {
    src.style.height = Math.max(120, Math.min(800, d.height)) + "px";
  }
});

function renderStroke(o) {
  const NS = "http://www.w3.org/2000/svg";
  const p = document.createElementNS(NS, "path");
  p.id = "obj-" + o.id;
  const pts = o.points || [];
  let d = "";
  for (let i = 0; i < pts.length; i += 2) d += (i === 0 ? "M" : "L") + pts[i] + " " + pts[i + 1] + " ";
  p.setAttribute("d", d);
  p.setAttribute("stroke", o.color || "#f2ecff");
  p.setAttribute("stroke-width", o.w || 4);
  p.setAttribute("fill", "none");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  p.style.pointerEvents = "stroke";
  p.addEventListener("pointerdown", (e) => onObjPointerDown(e, o.id));
  $("#stroke-g").appendChild(p);
}

function editText(id, txtEl) {
  txtEl.contentEditable = "true";
  txtEl.focus();
  document.execCommand?.("selectAll", false, null);
  const done = () => {
    txtEl.contentEditable = "false";
    txtEl.removeEventListener("blur", done);
    const v = txtEl.innerText.trim().slice(0, 500);
    if (!v) send({ t: "op", op: { kind: "del", id } });
    else if (v !== (S.objects[id]?.text || "")) send({ t: "op", op: { kind: "edit", id, patch: { text: v } } });
    else renderObj(id);
  };
  txtEl.addEventListener("blur", done);
  txtEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); txtEl.blur(); } });
}

/* ================= board: pointer tools ================= */
const pointers = new Map(); // pointerId -> {sx, sy}
let gesture = null; // {mode:'pan'|'draw'|'drag', ...}

function onObjPointerDown(e, id) {
  if (S.tool === "eraser") {
    e.stopPropagation();
    send({ t: "op", op: { kind: "del", id } });
    return;
  }
  if (S.tool !== "pan") return;
  e.stopPropagation();
  S.selected = id;
  document.querySelectorAll(".sticky.selected,.label-obj.selected").forEach((x) => x.classList.remove("selected"));
  document.getElementById("obj-" + id)?.classList.add("selected");
  const o = S.objects[id];
  if (!o || o.type === "stroke") return;
  const b = screenToBoard(e.clientX, e.clientY);
  gesture = { mode: "drag", id, dx: b.x - o.x, dy: b.y - o.y, moved: false, pid: e.pointerId };
  vp().setPointerCapture(e.pointerId);
}

function viewportPointerDown(e) {
  pointers.set(e.pointerId, { sx: e.clientX, sy: e.clientY });
  if (pointers.size === 2) { // pinch
    const [a, b] = [...pointers.values()];
    gesture = { mode: "pinch", d0: Math.hypot(a.sx - b.sx, a.sy - b.sy), cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2 };
    return;
  }
  if (e.target.closest(".sticky, .label-obj, #toolbar, #chat-panel, #filmstrip, #topbar, .tool, button")) return;
  const b = screenToBoard(e.clientX, e.clientY);
  if (S.tool === "pan") {
    gesture = { mode: "pan", sx: e.clientX, sy: e.clientY, tx: S.transform.x, ty: S.transform.y, pid: e.pointerId };
    S.selected = null;
    document.querySelectorAll(".sticky.selected,.label-obj.selected").forEach((x) => x.classList.remove("selected"));
  } else if (S.tool === "sticky" || S.tool === "label") {
    placeTextObject(S.tool, b.x, b.y);
  } else if (S.tool === "pen") {
    gesture = { mode: "draw", pts: [b.x, b.y], el: startTempStroke(b.x, b.y), pid: e.pointerId };
  } else if (S.tool === "eraser") {
    // clicks on empty space: nothing
  }
  vp().setPointerCapture(e.pointerId);
}

function viewportPointerMove(e) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { sx: e.clientX, sy: e.clientY });
  broadcastCursor(e);
  if (gesture?.mode === "pinch") {
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.sx - b.sx, a.sy - b.sy);
      if (gesture.d0 > 0) zoomAt(gesture.cx, gesture.cy, d / gesture.d0);
      gesture.d0 = d;
    }
    return;
  }
  if (!gesture || gesture.pid !== e.pointerId) return;
  const b = screenToBoard(e.clientX, e.clientY);
  if (gesture.mode === "pan") {
    S.transform.x = gesture.tx + (e.clientX - gesture.sx);
    S.transform.y = gesture.ty + (e.clientY - gesture.sy);
    applyTransform();
  } else if (gesture.mode === "drag") {
    const o = S.objects[gesture.id];
    if (!o) return;
    o.x = b.x - gesture.dx; o.y = b.y - gesture.dy;
    gesture.moved = true;
    positionEl(gesture.id);
  } else if (gesture.mode === "draw") {
    const pts = gesture.pts;
    const last = pts.length;
    if (Math.hypot(b.x - pts[last - 2], b.y - pts[last - 1]) > 3) {
      pts.push(b.x, b.y);
      extendTempStroke(gesture.el, pts);
    }
  }
}

function viewportPointerUp(e) {
  pointers.delete(e.pointerId);
  if (gesture?.mode === "pinch" && pointers.size < 2) gesture = null;
  if (!gesture || (gesture.pid !== undefined && gesture.pid !== e.pointerId)) return;
  if (gesture.mode === "drag" && gesture.moved) {
    const o = S.objects[gesture.id];
    if (o) send({ t: "op", op: { kind: "move", id: gesture.id, x: Math.round(o.x), y: Math.round(o.y) } });
  } else if (gesture.mode === "draw") {
    finishTempStroke(gesture);
  }
  gesture = null;
}

function placeTextObject(kind, x, y) {
  const id = uid(kind === "sticky" ? "s" : "l");
  // Render locally first so the editor can open instantly; the server echo
  // carries the same id and is idempotent via lastSeq.
  const obj = kind === "sticky"
    ? { id, type: "sticky", x: x - 100, y: y - 40, text: "", color: S.color, votes: 0 }
    : { id, type: "label", x, y: y - 20, text: "" };
  S.objects[id] = obj;
  renderObj(id);
  const txt = document.querySelector("#obj-" + CSS.escape(id) + " .txt");
  if (txt) {
    // send the add immediately; editText's blur handler sends text/del after
    send({ t: "op", op: { kind: "add", obj: { ...obj } } });
    editText(id, txt);
  } else {
    send({ t: "op", op: { kind: "add", obj: { ...obj } } });
  }
  setTool("pan");
}

let tempStrokeEl = null;
function startTempStroke(x, y) {
  const NS = "http://www.w3.org/2000/svg";
  tempStrokeEl = document.createElementNS(NS, "path");
  tempStrokeEl.setAttribute("stroke", strokeColor());
  tempStrokeEl.setAttribute("stroke-width", 4);
  tempStrokeEl.setAttribute("fill", "none");
  tempStrokeEl.setAttribute("stroke-linecap", "round");
  tempStrokeEl.setAttribute("d", `M${x} ${y}`);
  $("#stroke-g").appendChild(tempStrokeEl);
  return tempStrokeEl;
}
function extendTempStroke(elm, pts) {
  let d = "";
  for (let i = 0; i < pts.length; i += 2) d += (i === 0 ? "M" : "L") + pts[i] + " " + pts[i + 1] + " ";
  elm.setAttribute("d", d);
}
function strokeColor() {
  return { yellow: "#ffd34d", pink: "#ff8fb8", blue: "#8ab4ff", green: "#8fdcab", purple: "#b9a7ff", orange: "#ffb37d" }[S.color] || "#f2ecff";
}
function finishTempStroke(g) {
  const pts = g.pts.map((n) => Math.round(n * 2) / 2);
  g.el?.remove();
  if (pts.length >= 4) {
    const id = uid("w");
    send({ t: "op", op: { kind: "add", obj: { id, type: "stroke", x: 0, y: 0, points: pts, w: 4, color: strokeColor() } } });
  }
}

function setTool(t) {
  S.tool = t;
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  vp().style.cursor = t === "pan" ? "grab" : "crosshair";
}

/* ================= presence cursors ================= */
let lastCursorSent = 0;
function broadcastCursor(e) {
  const now = Date.now();
  if (now - lastCursorSent < 90) return;
  lastCursorSent = now;
  if (e.target.closest("#toolbar,#chat-panel,#filmstrip,#topbar")) return;
  const b = screenToBoard(e.clientX, e.clientY);
  send({ t: "cursor", x: Math.round(b.x), y: Math.round(b.y) });
}
function moveCursor(m) {
  let elx = S.cursors.get(m.from);
  if (!elx) {
    elx = document.createElement("div");
    elx.className = "remote-cursor";
    elx.innerHTML = `<div class="arrow" style="color:${m.color}">➤</div><div class="who" style="background:${m.color}">${esc(m.name)}</div>`;
    $("#cursor-layer").appendChild(elx);
    S.cursors.set(m.from, elx);
  }
  elx.style.transform = `translate(${m.x}px,${m.y}px)`;
}

/* ================= chat ================= */
function addChat(m) {
  const box = $("#chat-msgs");
  const div = document.createElement("div");
  if (m.sys) {
    div.className = "msg sys";
    div.innerHTML = `<div class="bubble" style="background:none;color:var(--dim);font-size:13px;text-align:center">${esc(m.text)}</div>`;
  } else {
    const isMe = m.from === S.me.id;
    const isAgent = m.from === "agent";
    const isSpark = m.from === "spark";
    const isGemini = m.from === "gemini";
    div.className = "msg" + (isMe ? " me" : "") + (isAgent ? " agent" : "") + (isSpark ? " spark" : "") + (isGemini ? " gemini" : "");
    const when = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    div.innerHTML = `<div class="who">${esc(m.name)} · ${when}</div><div class="bubble">${esc(m.text)}</div>`;
    if (!isMe && $("#chat-panel").classList.contains("hidden")) {
      S.unread++;
      const badge = $("#chat-badge");
      badge.textContent = S.unread;
      badge.classList.remove("hidden");
    }
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function toggleChat(open) {
  const p = $("#chat-panel");
  const willOpen = open === undefined ? p.classList.contains("hidden") : open;
  p.classList.toggle("hidden", !willOpen);
  if (willOpen) {
    S.unread = 0;
    $("#chat-badge").classList.add("hidden");
    $("#chat-msgs").scrollTop = $("#chat-msgs").scrollHeight;
    setTimeout(() => $("#chat-input").focus(), 50);
  }
}

/* ================= settings ================= */

function toggleSettings(open) {
  const m = $("#settings-modal");
  const willOpen = open === undefined ? m.classList.contains("hidden") : open;
  m.classList.toggle("hidden", !willOpen);
  if (willOpen) loadKeys();
}

async function loadKeys() {
  const box = $("#keys-list");
  box.innerHTML = `<p class="fine">Loading…</p>`;
  let keys = [];
  try {
    keys = (await (await fetch("/api/keys")).json()).keys || [];
  } catch { box.innerHTML = `<p class="fine">Couldn't reach the server.</p>`; return; }
  box.innerHTML = "";
  for (const k of keys) {
    const row = document.createElement("div");
    row.className = "key-row";
    row.innerHTML = `
      <div class="key-name">${esc(k.name)} ${k.configured ? `<span class="key-ok">● set</span>` : `<span class="key-missing">○ not set</span>`}</div>
      <div class="key-benefit">${esc(k.benefit)}</div>
      ${k.configured ? `<div class="key-masked">${esc(k.masked)}</div>` : ""}
      <form class="key-form">
        <input type="password" placeholder="${k.configured ? "paste a new key to replace…" : "paste key…"}" autocomplete="off" spellcheck="false">
        <button class="primary">Save</button>
        ${k.configured ? `<button type="button" class="key-clear">Clear</button>` : ""}
      </form>
      <a class="key-signup" href="${esc(k.signup)}" target="_blank" rel="noopener">${esc(k.signupLabel)} ↗</a>`;
    const form = row.querySelector(".key-form");
    const input = row.querySelector("input");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      input.value = "";
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: k.id, value: v }),
      });
      if (r.ok) loadKeys(); else input.placeholder = "save failed — try again";
    });
    const clearBtn = row.querySelector(".key-clear");
    if (clearBtn) clearBtn.addEventListener("click", async () => {
      await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: k.id, value: "" }),
      });
      loadKeys();
    });
    box.appendChild(row);
  }
}

/* ================= widget lab ================= */

const labApi = (p, opts) => fetch(`/api/parties/${S.code}/widget-types${p || ""}`, opts);

function toggleLab(open) {
  const m = $("#lab-modal");
  const willOpen = open === undefined ? m.classList.contains("hidden") : open;
  m.classList.toggle("hidden", !willOpen);
  if (willOpen) refreshLab();
}

/** Rebuild the Lab lists from the registry. */
function refreshLab() {
  const body = $("#lab-body");
  const types = Object.values(S.widgetTypes).sort((a, b) => (a.name < b.name ? -1 : 1));
  const active = types.filter((t) => t.status === "active");
  const drafts = types.filter((t) => t.status !== "active");
  const card = (t, isDraft) => `
    <div class="lab-type">
      <div class="lab-type-head">
        <b>${esc(t.title)}</b>
        <code>${esc(t.name)}</code>
        <span class="lab-status ${t.status}">${t.status}</span>
      </div>
      <div class="lab-desc">${esc(t.description || "")}</div>
      <div class="lab-meta">v${t.version}${t.created_by ? ` · by ${esc(t.created_by)}` : ""}${t.fields?.length ? ` · fields: ${t.fields.map((f) => esc(f.key)).join(", ")}` : ""}</div>
      <div class="lab-actions">
        ${isDraft ? `<button data-act="edit">Edit</button><button data-act="publish" class="primary">Publish</button>`
                   : `<input data-role="title" placeholder="Widget title…" maxlength="120"><button data-act="add" class="primary">Add to board</button>
                      <button data-act="unpublish">Unpublish</button>`}
        <button data-act="del" class="danger">Delete</button>
      </div>
    </div>`;
  body.innerHTML = `
    <div class="lab-intro">Design mini apps with the party: the <b>agent</b> scaffolds
      (<code>agent build widget &lt;name&gt; "&lt;desc&gt;"</code>), <b>@spark</b> writes the code,
      you preview and publish here.</div>
    <div class="lab-row"><h3>Live (${active.length})</h3><button id="lab-new" class="primary">＋ New type</button></div>
    <div id="lab-active">${active.map((t) => card(t, false)).join("") || `<p class="fine">Nothing live yet.</p>`}</div>
    <h3>Drafts (${drafts.length})</h3>
    <div id="lab-drafts">${drafts.map((t) => card(t, true)).join("") || `<p class="fine">No drafts. Scaffold one with the agent or ＋ New.</p>`}</div>
    <p class="fine">Widget code runs sandboxed in every browser here — publish types from people you trust.</p>`;
  $("#lab-new").addEventListener("click", () => openLabEditor(null));
  body.querySelectorAll(".lab-type").forEach((el) => {
    const name = el.querySelector("code").textContent;
    el.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => labAction(name, b.dataset.act, el));
    });
  });
}

async function labAction(name, act, el) {
  if (act === "edit") { openLabEditor(name); return; }
  if (act === "add") {
    const title = (el.querySelector('[data-role="title"]').value || "").trim() || name;
    const r = await fetch(`/api/parties/${S.code}/agent`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instruction: `add widget ${name} ${title}` }),
    });
    if (r.ok) toggleLab(false);
    return;
  }
  if (act === "publish" || act === "unpublish") {
    const r = await labApi(`/${name}/${act}`, { method: "POST" });
    if (!r.ok) alert("Couldn't " + act + ": " + (await r.text()).slice(0, 120));
    return;
  }
  if (act === "del") {
    if (!confirm(`Delete widget type "${name}"?`)) return;
    const r = await labApi(`/${name}`, { method: "DELETE" });
    if (!r.ok) alert("Couldn't delete: " + (await r.text()).slice(0, 160));
    return;
  }
}

/** Open the draft editor (new or existing). */
function openLabEditor(name) {
  const t = name ? S.widgetTypes[name] : null;
  const body = $("#lab-body");
  body.innerHTML = `
    <button id="lab-back">← All types</button>
    <h3>${t ? `Edit <code>${esc(t.name)}</code>` : "New widget type"}</h3>
    <div id="lab-err" class="lab-err hidden"></div>
    ${t ? "" : `<label>Name (slug)<input id="lab-name" placeholder="scoreboard" maxlength="24"></label>`}
    <label>Title<input id="lab-title" value="${esc(t?.title || "")}" maxlength="60"></label>
    <label>Description<input id="lab-desc" value="${esc(t?.description || "")}" maxlength="500"></label>
    <div class="lab-grid2">
      <label>Height (px)<input id="lab-height" type="number" value="${t?.height || 220}" min="120" max="800"></label>
      <label>Fields (JSON)<input id="lab-fields" value='${esc(JSON.stringify(t?.fields || []))}' spellcheck="false"></label>
    </div>
    <label>Example data (JSON)<textarea id="lab-example" rows="3" spellcheck="false">${esc(JSON.stringify(t?.example ?? { count: 0 }, null, 1))}</textarea></label>
    <label>Style (CSS)<textarea id="lab-style" rows="5" spellcheck="false">${esc(t?.style || "")}</textarea></label>
    <label>Script (JS — define render(state), optional bind(root, api))<textarea id="lab-script" rows="14" spellcheck="false">${esc(t?.script || "")}</textarea></label>
    <div class="lab-row">
      <button id="lab-preview-btn">Refresh preview</button>
      ${t ? `<button id="lab-save" class="primary">Save draft</button>
             <button id="lab-pub" class="primary">Save & publish</button>
             <button id="lab-del" class="danger">Delete</button>` : `<button id="lab-create" class="primary">Create draft</button>`}
    </div>
    <h4>Preview</h4>
    <div class="lab-preview"><iframe id="lab-frame" sandbox="allow-scripts" title="widget preview"></iframe></div>`;
  $("#lab-back").addEventListener("click", refreshLab);
  const showErr = (msg) => { const e = $("#lab-err"); e.textContent = msg; e.classList.remove("hidden"); };
  const readForm = () => {
    let fields, example;
    try { fields = JSON.parse($("#lab-fields").value || "[]"); }
    catch { throw new Error("Fields isn't valid JSON."); }
    try { example = JSON.parse($("#lab-example").value || "{}"); }
    catch { throw new Error("Example data isn't valid JSON."); }
    return {
      title: $("#lab-title").value,
      description: $("#lab-desc").value,
      fields, example,
      style: $("#lab-style").value,
      script: $("#lab-script").value,
      height: +$("#lab-height").value || 220,
    };
  };
  const doPreview = () => {
    try {
      const f = readForm();
      const fr = $("#lab-frame");
      fr.style.height = Math.max(120, Math.min(800, f.height)) + "px";
      fr.srcdoc = WidgetLib.buildWidgetSrcdoc(f, "preview", f.example);
    } catch (err) { showErr(err.message); }
  };
  $("#lab-preview-btn").addEventListener("click", doPreview);
  setTimeout(doPreview, 50);
  const saveDraft = async (publish) => {
    let f;
    try { f = readForm(); } catch (err) { showErr(err.message); return; }
    const payload = { ...f, by: S.me.name };
    let r;
    if (!t) {
      payload.name = $("#lab-name").value.trim().toLowerCase();
      r = await labApi("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } else {
      r = await labApi(`/${t.name}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    }
    if (!r.ok) { showErr("Save failed: " + (await r.text()).slice(0, 200)); return; }
    const saved = (await r.json()).type;
    if (publish) {
      const rp = await labApi(`/${saved.name}/publish`, { method: "POST" });
      if (!rp.ok) { showErr("Publish failed: " + (await rp.text()).slice(0, 200)); return; }
    }
    refreshLab();
  };
  if (t) {
    $("#lab-save").addEventListener("click", () => saveDraft(false));
    $("#lab-pub").addEventListener("click", () => saveDraft(true));
    $("#lab-del").addEventListener("click", async () => {
      if (!confirm(`Delete widget type "${t.name}"?`)) return;
      const r = await labApi(`/${t.name}`, { method: "DELETE" });
      if (!r.ok) showErr("Delete failed: " + (await r.text()).slice(0, 200));
      else refreshLab();
    });
  } else {
    $("#lab-create").addEventListener("click", () => saveDraft(false));
  }
}

/* ================= agent panel ================= */
const AGENT_HELP =
`I program the board. Try:
• agent add sticky <text> [color pink] [at 100,200]
• agent add label <text> [at 100,200]
• agent add widget poll <question> | <opt1> | <opt2>
• agent add widget checklist <title> | <item1> | <item2>
• agent add widget <type> <title> [| values…]
• agent build widget <name> "<description>"  (scaffold a mini app)
• agent widgets · agent publish widget <name>
• agent move <id or words> to <x>,<y>
• agent delete <id or words> · agent color <id or words> <color>
• agent arrange · agent cluster · agent count
• agent vote start · agent vote stop · agent tally
• agent timer <minutes> · agent clear yes`;

function toggleAgent(open) {
  const m = $("#agent-modal");
  const willOpen = open === undefined ? m.classList.contains("hidden") : open;
  m.classList.toggle("hidden", !willOpen);
  if (willOpen) setTimeout(() => $("#agent-input").focus(), 50);
}

/* ================= timer ================= */
let timerIv = null;
function showTimer(endsAt) {
  S.timerEndsAt = endsAt;
  $("#timer-pill").classList.remove("hidden");
  clearInterval(timerIv);
  const tick = () => {
    const left = Math.max(0, endsAt - Date.now());
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    $("#timer-text").textContent = `${m}:${String(s).padStart(2, "0")}`;
    if (left <= 0) {
      clearInterval(timerIv);
      $("#timer-text").textContent = "Time's up! 🎉";
      addChat({ from: "sys", name: "", text: "⏱ Time's up!", ts: Date.now(), sys: true });
      setTimeout(() => $("#timer-pill").classList.add("hidden"), 8000);
    }
  };
  tick();
  timerIv = setInterval(tick, 1000);
}

/* ================= webrtc mesh ================= */
// Point-to-point: the server only routes SDP/ICE signaling. Media flows
// directly between peers and never touches the server.
const RTC_CFG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function rtcPeer(id) {
  let pc = S.pcs.get(id);
  if (pc) return pc;
  pc = new RTCPeerConnection(RTC_CFG);
  pc.onicecandidate = (e) => {
    if (e.candidate) send({ t: "signal", to: id, data: { ice: e.candidate } });
  };
  pc.ontrack = (e) => attachTile(id, e.streams[0]);
  S.pcs.set(id, pc);
  return pc;
}

function ensureTracks(pc) {
  if (!S.localStream) return;
  const have = new Set(pc.getSenders().map((s) => s.track));
  for (const tr of S.localStream.getTracks()) {
    if (!have.has(tr)) pc.addTrack(tr, S.localStream);
  }
}

async function rtcOffer(id) {
  try {
    const pc = rtcPeer(id);
    ensureTracks(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ t: "signal", to: id, data: { sdp: pc.localDescription } });
  } catch (err) { console.warn("rtc offer:", err); }
}

async function rtcSignal(from, data) {
  try {
    const pc = rtcPeer(from);
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      if (data.sdp.type === "offer") {
        ensureTracks(pc);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        send({ t: "signal", to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice) {
      await pc.addIceCandidate(new RTCIceCandidate(data.ice));
    }
  } catch (err) { console.warn("rtc signal:", err); }
}

function addLocalTile() {
  if (document.getElementById("tile-me")) return;
  const d = document.createElement("div");
  d.className = "tile novideo";
  d.id = "tile-me";
  d.innerHTML = `<video autoplay playsinline muted></video><div class="tag">You</div><div class="flags"></div><div class="avatar" style="background:${S.me.color};display:none">${esc(S.me.name[0] || "?")}</div>`;
  d.querySelector("video").srcObject = S.localStream;
  $("#tiles").prepend(d);
  refreshLocalTile();
}
function refreshLocalTile() {
  const d = document.getElementById("tile-me");
  if (!d) return;
  d.classList.toggle("novideo", !S.camOn);
  d.querySelector(".avatar").style.display = S.camOn ? "none" : "flex";
  d.querySelector(".flags").textContent = (S.micOn ? "" : "🔇") + (S.camOn ? "" : "🚫📷");
}

function attachTile(id, stream) {
  const p = S.peers.get(id);
  if (!p) return;
  p.stream = stream;
  let d = document.getElementById("tile-" + id);
  if (!d) {
    d = document.createElement("div");
    d.className = "tile novideo";
    d.id = "tile-" + id;
    d.innerHTML = `<video autoplay playsinline></video><div class="tag">${esc(p.name)}</div><div class="flags"></div><div class="avatar" style="background:${p.color}">${esc((p.name[0] || "?").toUpperCase())}</div>`;
    d.querySelector("video").srcObject = stream;
    $("#tiles").appendChild(d);
    watchSpeaking(id, stream, d);
  } else {
    d.querySelector("video").srcObject = stream;
  }
  refreshTile(id);
}

function refreshTile(id) {
  const p = S.peers.get(id);
  const d = document.getElementById("tile-" + id);
  if (!p || !d) return;
  d.classList.toggle("novideo", !p.video);
  d.querySelector(".avatar").style.display = p.video ? "none" : "flex";
  d.querySelector(".flags").textContent = (p.audio ? "" : "🔇") + (p.video ? "" : "🚫📷");
}

function setPeerMedia(from, audio, video) {
  const p = S.peers.get(from);
  if (!p) return;
  p.audio = audio; p.video = video;
  refreshTile(from);
}

function broadcastMedia() {
  send({ t: "media", audio: S.micOn, video: S.camOn });
}

let audioCtx = null;
function watchSpeaking(id, stream, tile) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const iv = setInterval(() => {
      if (!document.getElementById("tile-" + id)) { clearInterval(iv); try { src.disconnect(); } catch {} return; }
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      tile.classList.toggle("speaking", Math.sqrt(sum / buf.length) > 0.06);
    }, 250);
  } catch { /* speaking indicator is best-effort */ }
}

async function enableMedia() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
    });
    S.localStream = stream;
    S.micOn = true; S.camOn = true;
    addLocalTile();
    $("#join-media").classList.add("hidden");
    $("#mic-btn").classList.remove("hidden");
    $("#cam-btn").classList.remove("hidden");
    for (const id of S.peers.keys()) rtcOffer(id); // renegotiate: now I have tracks
    broadcastMedia();
  } catch (err) {
    alert("Couldn't access camera/mic: " + (err.message || err));
  }
}

/* ================= boot ================= */
function inviteURL() {
  return location.origin + location.pathname + "#/p/" + S.code;
}

$("#create-btn").addEventListener("click", createParty);
$("#join-btn").addEventListener("click", joinParty);
$("#join-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinParty(); });
$("#party-name").addEventListener("keydown", (e) => { if (e.key === "Enter") createParty(); });
$("#nick").addEventListener("keydown", (e) => { if (e.key === "Enter") createParty(); });

document.querySelectorAll(".tool").forEach((b) =>
  b.addEventListener("click", () => setTool(b.dataset.tool))
);

const viewport = $("#viewport");
viewport.addEventListener("pointerdown", viewportPointerDown);
viewport.addEventListener("pointermove", viewportPointerMove);
viewport.addEventListener("pointerup", viewportPointerUp);
viewport.addEventListener("pointercancel", viewportPointerUp);
viewport.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

$("#chat-toggle").addEventListener("click", () => toggleChat());
$("#chat-close").addEventListener("click", () => toggleChat(false));
$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#chat-input").value.trim();
  if (!v) return;
  $("#chat-input").value = "";
  send({ t: "chat", text: v });
});

$("#agent-btn").addEventListener("click", () => toggleAgent());
$("#agent-close").addEventListener("click", () => toggleAgent(false));
$("#agent-modal").addEventListener("click", (e) => { if (e.target.id === "agent-modal") toggleAgent(false); });
$("#agent-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#agent-input").value.trim();
  if (!v) return;
  $("#agent-input").value = "";
  send({ t: "chat", text: "agent: " + v });
  toggleAgent(false);
  toggleChat(true);
});

$("#settings-btn").addEventListener("click", () => toggleSettings());
$("#lab-btn").addEventListener("click", () => toggleLab());
$("#lab-close").addEventListener("click", () => toggleLab(false));
$("#lab-modal").addEventListener("click", (e) => { if (e.target.id === "lab-modal") toggleLab(false); });
$("#settings-close").addEventListener("click", () => toggleSettings(false));
$("#settings-modal").addEventListener("click", (e) => { if (e.target.id === "settings-modal") toggleSettings(false); });

$("#media-toggle").addEventListener("click", () => {
  $("#filmstrip").classList.toggle("hidden");
});
$("#join-media").addEventListener("click", enableMedia);
$("#mic-btn").addEventListener("click", () => {
  S.micOn = !S.micOn;
  S.localStream?.getAudioTracks().forEach((t) => (t.enabled = S.micOn));
  $("#mic-btn").classList.toggle("off", !S.micOn);
  $("#mic-btn").textContent = S.micOn ? "🎤" : "🔇";
  refreshLocalTile();
  broadcastMedia();
});
$("#cam-btn").addEventListener("click", () => {
  S.camOn = !S.camOn;
  S.localStream?.getVideoTracks().forEach((t) => (t.enabled = S.camOn));
  $("#cam-btn").classList.toggle("off", !S.camOn);
  $("#cam-btn").textContent = S.camOn ? "📷" : "🚫📷";
  refreshLocalTile();
  broadcastMedia();
});

document.querySelector(".party-id").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteURL());
    const c = $("#party-code-top");
    const orig = c.textContent;
    c.textContent = "copied!";
    setTimeout(() => (c.textContent = orig), 1200);
  } catch {}
});
$("#leave-btn").addEventListener("click", () => { location.hash = "#/"; });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { toggleAgent(false); toggleSettings(false); toggleLab(false); }
});

if (location.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  $("#secure-hint").classList.remove("hidden");
}
$("#agent-help").textContent = AGENT_HELP;

applyTransform();
route();
