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
function connect() {
  clearTimeout(reconnectTimer);
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?party=${S.code}`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: "hello", name: S.me.name }));
  ws.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch {}
  };
  ws.onclose = () => {
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
  } else { // label
    elx.className = "label-obj" + (S.selected === id ? " selected" : "");
    elx.innerHTML = `<div class="txt">${esc(o.text || "")}</div>`;
    const txt = elx.querySelector(".txt");
    txt.addEventListener("dblclick", (e) => { e.stopPropagation(); editText(id, txt); });
  }
  elx.addEventListener("pointerdown", (e) => onObjPointerDown(e, id));
  $("#obj-layer").appendChild(elx);
}

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
    div.className = "msg" + (isMe ? " me" : "") + (isAgent ? " agent" : "");
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

/* ================= agent panel ================= */
const AGENT_HELP =
`I program the board. Try:
• agent add sticky <text> [color pink] [at 100,200]
• agent add label <text> [at 100,200]
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
  if (e.key === "Escape") { toggleAgent(false); }
});

if (location.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
  $("#secure-hint").classList.remove("hidden");
}
$("#agent-help").textContent = AGENT_HELP;

applyTransform();
route();
