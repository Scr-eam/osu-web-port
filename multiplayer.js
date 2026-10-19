// Multiplayer: rooms of players who play the same map at the same time and see each other's scores live.
//
// The site is static (GitHub Pages), so there is no game server. Players connect to each other directly over
// WebRTC data channels; the free PeerJS cloud server (0.peerjs.com) only introduces them (it relays the WebRTC
// offer / answer / ICE messages, using PeerJS's server protocol). The host's browser runs the room: everyone
// connects to the host, and the host passes the room's state, chat and scores on to everyone.
//
// A room is a 5-letter code; its host registers as "osuwebport-<code>" on the PeerJS server. Joining means
// connecting to that id. The host picks the map; a player without it gets it sent by the host over the data
// channel and saved like an imported map. When everyone is ready, the host starts the round: each player plays it
// on their own clock and reports score, combo, accuracy and misses a few times a second.
//
// createMultiplayer(api) wires it into the page; api is described where index.html calls it.

const SERVER = "wss://0.peerjs.com:443/peerjs";
const ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" },
];
const PREFIX = "osuwebport-";
const CHUNK = 16 * 1024;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const rand = (n, chars = "abcdefghijklmnopqrstuvwxyz0123456789") => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");

// ---- the PeerJS server: a WebSocket that passes OFFER / ANSWER / CANDIDATE messages between peer ids ----
class Signal {
  constructor(id, url) {
    this.id = id;
    this.url = url;
    this.onmessage = null;
    this.onclose = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = new WebSocket(`${this.url}?key=peerjs&id=${encodeURIComponent(this.id)}&token=${rand(12)}&version=1.5.4`);
      this.ws = ws;
      const fail = (msg) => { if (!opened) { opened = true; reject(new Error(msg)); try { ws.close(); } catch (_) {} } };
      const timer = setTimeout(() => fail("The multiplayer server didn't answer. Check your connection and try again."), 12000);
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.type === "OPEN") {
          opened = true;
          clearTimeout(timer);
          this.hb = setInterval(() => this.raw({ type: "HEARTBEAT" }), 5000);
          resolve();
        } else if (m.type === "ID-TAKEN") {
          clearTimeout(timer);
          if (!opened) { opened = true; reject(Object.assign(new Error("id-taken"), { taken: true })); }
        } else if (m.type === "ERROR") {
          clearTimeout(timer);
          fail(m.payload?.msg || "The multiplayer server refused the connection.");
        } else {
          this.onmessage?.(m);
        }
      };
      ws.onerror = () => { clearTimeout(timer); fail("Couldn't reach the multiplayer server."); };
      ws.onclose = () => { clearInterval(this.hb); if (opened) this.onclose?.(); else { clearTimeout(timer); fail("Couldn't reach the multiplayer server."); } };
    });
  }
  raw(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  send(type, dst, payload) { this.raw({ type, dst, payload }); }
  close() { clearInterval(this.hb); this.onclose = null; try { this.ws?.close(); } catch (_) {} }
}

// ---- one WebRTC connection to another player, with one ordered, reliable data channel ----
class Link {
  constructor(signal, remote, initiator, handlers) {
    this.signal = signal;
    this.remote = remote;
    this.h = handlers;              // { open, message, close }
    this.cid = initiator ? "dc_" + rand(10) : null;
    this.pending = [];              // ICE candidates that came before the remote description
    this.closed = false;
    this.opened = false;
    // what happened, for the error message if it doesn't connect: did the other side answer, how far ICE got,
    // and which kinds of route each side found (host = same network, srflx = through the router, relay = TURN)
    this.diag = { answered: false, ice: "new", mine: { host: 0, srflx: 0, relay: 0 }, theirs: { host: 0, srflx: 0, relay: 0 } };
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc = pc;
    const kind = (c) => (/ typ (host|srflx|relay|prflx)/.exec(c?.candidate || "") || [])[1];
    this.kind = kind;
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const k = kind(e.candidate);
      if (k in this.diag.mine) this.diag.mine[k]++;
      signal.send("CANDIDATE", remote, { candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate, connectionId: this.cid, type: "data" });
    };
    pc.oniceconnectionstatechange = () => {
      this.diag.ice = pc.iceConnectionState;
      console.info("[multiplayer]", remote, "ICE", pc.iceConnectionState, JSON.stringify(this.diag));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.close();
    };
    pc.ondatachannel = (e) => this.useChannel(e.channel);
    if (initiator) {
      this.useChannel(pc.createDataChannel("osu", { ordered: true }));
      (async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          signal.send("OFFER", remote, { sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription, type: "data", connectionId: this.cid, serialization: "raw", reliable: true });
        } catch (err) { this.close(); }
      })();
    }
  }
  useChannel(dc) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = 256 * 1024;
    const opened = () => { if (this.opened) return; this.opened = true; console.info("[multiplayer] connected to", this.remote); this.h.open?.(this); };
    dc.onopen = opened;
    if (dc.readyState === "open") queueMicrotask(opened);
    dc.onmessage = (e) => {
      if (typeof e.data === "string") {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        this.h.message?.(this, m);
      } else this.h.binary?.(this, e.data);
    };
    dc.onclose = () => this.close();
  }
  async onSignal(m) {
    const pc = this.pc;
    try {
      if (m.type === "OFFER") {
        this.cid = m.payload.connectionId;
        await pc.setRemoteDescription(m.payload.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        this.signal.send("ANSWER", this.remote, { sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : pc.localDescription, type: "data", connectionId: this.cid });
        this.flush();
      } else if (m.type === "ANSWER") {
        this.diag.answered = true;
        this.h.answered?.(this);
        await pc.setRemoteDescription(m.payload.sdp);
        this.flush();
      } else if (m.type === "CANDIDATE") {
        const c = m.payload.candidate;
        const k = this.kind(c);
        if (k in this.diag.theirs) this.diag.theirs[k]++;
        if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
        else this.pending.push(c);
      }
    } catch (_) { /* a broken offer: the connection times out */ }
  }
  flush() { for (const c of this.pending.splice(0)) this.pc.addIceCandidate(c).catch(() => {}); }
  get ready() { return this.dc?.readyState === "open"; }
  send(m) { if (this.ready) this.dc.send(JSON.stringify(m)); }
  async sendBinary(buf) {
    if (!this.ready) throw new Error("closed");
    if (this.dc.bufferedAmount > 1024 * 1024) {
      await new Promise((r) => { const on = () => { this.dc.removeEventListener("bufferedamountlow", on); r(); }; this.dc.addEventListener("bufferedamountlow", on); setTimeout(on, 5000); });
    }
    if (!this.ready) throw new Error("closed");
    this.dc.send(buf);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.dc?.close(); } catch (_) {}
    try { this.pc.close(); } catch (_) {}
    this.h.close?.(this);
  }
}

// ---- the room and its screen ----
export function createMultiplayer(api) {
  const $ = api.$;
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const params = new URLSearchParams(location.search);
  const server = params.get("peerserver") || SERVER;   // a local PeerJS-compatible server, for testing
  let name = store.get("osuweb.mpName", "") || `Player${Math.floor(1000 + Math.random() * 9000)}`;

  let room = null;     // { code, host, signal, links: Map, players: Map, map, phase, me }
  let inRound = false;
  let roundDone = false;   // this player's final score has gone out; no more live updates this round
  let lastLive = 0;
  let incoming = null; // a map being received: { name, size, parts, got }

  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (n) => Math.round(n || 0).toLocaleString();
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const status = (msg, err = false) => { const el = $("#mpStatus"); el.textContent = msg || ""; el.classList.toggle("err", !!err); };
  const haveMap = (n) => !!n && api.maps().some((r) => r.name === n);

  // ---------------------------------------------------------------- host side ----
  function hostState() {
    return {
      t: "state",
      code: room.code,
      phase: room.phase,
      map: room.map,
      players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, host: p.host, ready: p.ready, hasMap: p.hasMap, dl: p.dl, live: p.live })),
    };
  }
  let stateTimer = 0;
  function broadcast(now = false) {
    if (!room?.host) return;
    const send = () => {
      stateTimer = 0;
      const st = hostState();
      for (const l of room.links.values()) l.send({ ...st, you: l.remote });
      applyState({ ...st, you: "host" });
    };
    if (now) { clearTimeout(stateTimer); send(); }
    else if (!stateTimer) stateTimer = setTimeout(send, 150);
  }
  function toAll(m) { if (room?.host) for (const l of room.links.values()) l.send(m); }
  function hostMessage(link, m) {
    const p = room.players.get(link.remote);
    if (!p) return;
    if (m.t === "hello") { p.name = String(m.name || "Player").slice(0, 24); broadcast(true); chat(null, `${p.name} joined`, true); }
    else if (m.t === "ready") { p.ready = !!m.v; broadcast(); }
    else if (m.t === "have") { p.hasMap = !!m.v; p.dl = m.dl ?? null; broadcast(); }
    else if (m.t === "live") { p.live = m.live; broadcast(); checkRoundOver(); }
    else if (m.t === "chat") chat(p.name, String(m.text || "").slice(0, 300));
    else if (m.t === "needMap") sendMap(link, m.name);
  }
  async function sendMap(link, mapName) {
    const rec = api.maps().find((r) => r.name === mapName);
    if (!rec) return;
    try {
      const buf = await rec.blob.arrayBuffer();
      link.send({ t: "mapStart", name: mapName, size: buf.byteLength });
      for (let o = 0; o < buf.byteLength; o += CHUNK) await link.sendBinary(buf.slice(o, o + CHUNK));
      link.send({ t: "mapEnd", name: mapName });
    } catch (_) { /* they left */ }
  }
  function checkRoundOver() {
    if (!room?.host || room.phase !== "playing") return;
    if ([...room.players.values()].every((p) => p.live?.done || p.left)) {
      room.phase = "lobby";
      for (const p of room.players.values()) p.ready = p.host;
      broadcast(true);
    }
  }
  async function createRoom() {
    leave(true);
    for (let tries = 0; tries < 4; tries++) {
      const code = rand(5, CODE_CHARS);
      const signal = new Signal(PREFIX + code, server);
      status("Creating a room…");
      try {
        await signal.open();
      } catch (err) {
        if (err.taken) continue;
        status(err.message, true);
        return;
      }
      room = { code, host: true, signal, links: new Map(), players: new Map(), map: null, phase: "lobby", me: "host" };
      room.players.set("host", { id: "host", name, host: true, ready: true, hasMap: false, dl: null, live: null });
      signal.onmessage = (m) => {
        if (!m.src) return;
        let link = room.links.get(m.src);
        if (m.type === "OFFER" && !link) {
          link = new Link(signal, m.src, false, {
            open: (l) => {
              room.players.set(l.remote, { id: l.remote, name: "Player", host: false, ready: false, hasMap: false, dl: null, live: null });
              broadcast(true);
            },
            message: hostMessage,
            close: (l) => {
              room?.links.delete(l.remote);
              const p = room?.players.get(l.remote);
              if (p) { room.players.delete(l.remote); chat(null, `${p.name} left`, true); broadcast(true); checkRoundOver(); }
            },
          });
          room.links.set(m.src, link);
        }
        link?.onSignal(m);
      };
      signal.onclose = () => { if (room?.signal === signal) status("Lost the multiplayer server: no one new can join until you make a new room.", true); };
      const sel = api.selection();
      if (sel?.name) setMap(sel);
      status("");
      history.replaceState(null, "", `?room=${code}`);
      render();
      broadcast(true);
      return;
    }
    status("Couldn't get a room code. Try again.", true);
  }
  function setMap(sel) {
    room.map = sel ? { name: sel.name, diffName: sel.diffName, diffIndex: sel.diffIndex, mods: sel.mods.filter((m) => m !== "AP"), title: sel.title, artist: sel.artist } : null;
    for (const p of room.players.values()) if (!p.host) p.ready = false;
    room.players.get("host").hasMap = !!room.map;
    broadcast(true);
  }

  // ---------------------------------------------------------------- guest side ----
  async function joinRoom(code) {
    code = String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length < 4) { status("Type the room's code first.", true); return; }
    leave(true);
    const signal = new Signal(PREFIX + "p-" + rand(12), server);
    status(`Joining ${code}…`);
    try { await signal.open(); } catch (err) { status(err.message, true); return; }
    const hostId = PREFIX + code;
    room = { code, host: false, signal, links: new Map(), players: new Map(), map: null, phase: "lobby", me: null };
    const why = (l) => {
      const d = l?.diag;
      if (!d || !d.answered) return `The host's tab didn't answer. Make sure room ${code} is still open in the host's tab (and that tab isn't asleep), then try again.`;
      const routes = (o) => [o.host && "local", o.srflx && "internet", o.relay && "relay"].filter(Boolean).join(" + ") || "none";
      return `Found the host, but a direct connection couldn't be made (a firewall or network is blocking it). `
        + `Details: ICE ${d.ice}; your routes: ${routes(d.mine)}; host's routes: ${routes(d.theirs)}.`;
    };
    const timer = setTimeout(() => { if (room && !room.me) { status(why(room.links.get(hostId)), true); leave(true); } }, 25000);
    const link = new Link(signal, hostId, true, {
      answered: () => status(`Found room ${code}, connecting…`),
      open: (l) => { clearTimeout(timer); l.send({ t: "hello", name }); status(""); history.replaceState(null, "", `?room=${code}`); },
      message: (l, m) => guestMessage(l, m),
      binary: (l, buf) => { if (incoming) { incoming.parts.push(buf); incoming.got += buf.byteLength; reportHave(); } },
      close: () => { if (room?.links.get(hostId) === link) { clearTimeout(timer); const was = !!room.me; leave(true); status(was ? "The host closed the room." : why(link), true); } },
    });
    room.links.set(hostId, link);
    signal.onmessage = (m) => {
      if (m.type === "EXPIRE" || m.type === "LEAVE") { if (!room?.me) { clearTimeout(timer); leave(true); status(`Room ${code} wasn't found. Check the code.`, true); } return; }
      if (m.src === hostId) link.onSignal(m);
    };
    render();
  }
  const hostLink = () => (room && !room.host ? room.links.get(PREFIX + room.code) : null);
  let lastHave = 0;
  function reportHave(force) {
    const l = hostLink();
    if (!l || !room.map) return;
    const now = performance.now();
    if (!force && now - lastHave < 250) return;
    lastHave = now;
    const has = haveMap(room.map.name);
    l.send({ t: "have", v: has, dl: !has && incoming ? Math.min(99, Math.floor((incoming.got / Math.max(1, incoming.size)) * 100)) : null });
  }
  async function guestMessage(link, m) {
    if (m.t === "state") {
      const mapChanged = room.map?.name !== m.map?.name;
      applyState(m);
      if (mapChanged && m.map) {
        if (haveMap(m.map.name)) reportHave(true);
        else { link.send({ t: "needMap", name: m.map.name }); reportHave(true); }
      }
    } else if (m.t === "mapStart") {
      incoming = { name: m.name, size: m.size, parts: [], got: 0 };
    } else if (m.t === "mapEnd" && incoming && incoming.name === m.name) {
      const blob = new Blob(incoming.parts, { type: "application/zip" });
      incoming = null;
      try { await api.saveMap(m.name, blob); } catch (_) {}
      reportHave(true);
      render();
    } else if (m.t === "chat") chat(m.from, m.text, m.sys, true);
    else if (m.t === "start") startRound(m.map);
  }

  // ---------------------------------------------------------------- both ----
  function applyState(st) {
    if (!room) return;
    room.me = st.you;
    room.phase = st.phase;
    room.map = st.map;
    room.players = new Map(st.players.map((p) => [p.id, p]));
    render();
    renderBoard();
  }
  const log = [];
  function chat(from, text, sys = false, remote = false) {
    if (!text) return;
    log.push({ from, text, sys });
    if (log.length > 80) log.shift();
    if (room?.host && !remote) toAll({ t: "chat", from, text, sys });
    renderChat();
  }
  function sendChat(text) {
    text = text.trim();
    if (!text || !room) return;
    if (room.host) chat(name, text);
    else { hostLink()?.send({ t: "chat", text }); }
  }
  function leave(quiet) {
    if (!room) { if (!quiet) render(); return; }
    const r = room;
    room = null;
    inRound = false;
    incoming = null;
    for (const l of r.links.values()) { l.h.close = null; l.close(); }
    r.signal.close();
    log.length = 0;
    history.replaceState(null, "", location.pathname);
    render();
    renderBoard();
  }

  // the round: everyone opens the map and plays it on their own clock
  async function startRound(map) {
    if (!map) return;
    if (!haveMap(map.name)) { status("You don't have this map yet, so you'll sit this one out.", true); return; }
    inRound = true;
    roundDone = false;
    lastLive = 0;
    document.body.dataset.mp = "1";
    const ok = await api.play(map);
    if (!ok) { inRound = false; delete document.body.dataset.mp; status("Couldn't open the room's map.", true); sendLive({ done: true, failed: true, score: 0, acc: 0, combo: 0, miss: 0 }); }
    renderBoard();
  }
  function sendLive(live) {
    if (!room) return;
    if (room.host) { const p = room.players.get("host"); if (p) { p.live = live; broadcast(); checkRoundOver(); } }
    else hostLink()?.send({ t: "live", live });
  }
  function liveOf(st, done) {
    return { score: Math.round(st.score), acc: st.accuracy, combo: st.combo, maxCombo: st.maxCombo, miss: st.miss, failed: !!st.failed, done: !!done, p: st.endTime > 0 ? Math.max(0, Math.min(1, st.time / st.endTime)) : 0 };
  }
  function start() {
    if (!room?.host || !room.map) return;
    room.phase = "playing";
    for (const p of room.players.values()) p.live = null;
    broadcast(true);
    toAll({ t: "start", map: room.map });
    startRound(room.map);
  }

  // ---------------------------------------------------------------- screen ----
  function render() {
    const inRoom = !!room && (room.host || !!room.me);
    $("#mpJoin").hidden = inRoom;
    $("#mpRoom").hidden = !inRoom;
    $("#mpName").value = name;
    if (!inRoom) return;
    $("#mpCode").textContent = room.code;
    const me = room.players.get(room.me);
    // map
    const m = room.map;
    $("#mpMapTitle").textContent = m ? m.title || m.name.replace(/\.osz$/i, "") : "No map picked yet";
    $("#mpMapArtist").textContent = m ? m.artist || "" : room.host ? "Pick one with Choose map." : "Waiting for the host to pick one.";
    $("#mpMapDiff").textContent = m ? `${m.diffName || ""}${m.mods?.length ? ` · +${m.mods.join("")}` : ""}` : "";
    $("#mpMapDiff").hidden = !m;
    $("#mpPick").hidden = !room.host;
    // players
    const list = [...room.players.values()];
    $("#mpCount").textContent = `${list.length} player${list.length === 1 ? "" : "s"}`;
    $("#mpPlayers").innerHTML = list.map((p) => {
      let pill;
      if (room.phase === "playing" && p.live) pill = `<span class="pill play">${p.live.done ? (p.live.failed ? "Failed" : "Finished") : "Playing"} · ${fmt(p.live.score)}</span>`;
      else if (room.phase === "playing") pill = `<span class="pill play">Playing</span>`;
      else if (m && !p.hasMap) pill = p.dl != null ? `<span class="pill dl">Getting map ${p.dl}%</span>` : `<span class="pill dl">Needs map</span>`;
      else pill = p.host ? `<span class="pill host">Host</span>` : p.ready ? `<span class="pill ok">Ready</span>` : `<span class="pill">Not ready</span>`;
      return `<li class="${p.id === room.me ? "me" : ""}"><i class="av" style="--h:${hue(p.name)}">${esc(p.name.charAt(0).toUpperCase())}</i><b>${esc(p.name)}${p.host ? ' <span class="crown" title="Host">👑</span>' : ""}${p.id === room.me ? ' <small>(you)</small>' : ""}</b>${pill}</li>`;
    }).join("");
    // the main button
    const go = $("#mpGo");
    if (room.host) {
      const waiting = list.filter((p) => !p.host && (!p.ready || !p.hasMap));
      go.textContent = room.phase === "playing" ? "Round in progress…" : "Start";
      go.disabled = room.phase === "playing" || !m || waiting.length > 0;
      go.title = !m ? "Pick a map first" : waiting.length ? `Waiting for ${waiting.map((p) => p.name).join(", ")}` : "";
      $("#mpHint").textContent = room.phase === "playing" ? "" : !m ? "Pick a map to start." : waiting.length ? `Waiting for ${waiting.map((p) => p.name).join(", ")} to be ready.` : list.length > 1 ? "Everyone's ready!" : "You can start on your own, or share the code first.";
    } else {
      const ready = !!me?.ready;
      go.textContent = room.phase === "playing" ? "Round in progress…" : ready ? "Not ready" : "Ready";
      go.disabled = room.phase === "playing" || !m || !haveMap(m.name);
      go.classList.toggle("on", ready);
      $("#mpHint").textContent = room.phase === "playing" ? "" : !m ? "" : !haveMap(m.name) ? (incoming ? "Getting the map from the host…" : "Getting the map…") : ready ? "Waiting for the host to start." : "Press Ready when you are.";
    }
    renderChat();
  }
  function renderChat() {
    const box = $("#mpChatLog");
    if (!box) return;
    box.innerHTML = log.map((l) => l.sys ? `<div class="sys">${esc(l.text)}</div>` : `<div><b style="--h:${hue(l.from)}">${esc(l.from)}</b> ${esc(l.text)}</div>`).join("");
    box.scrollTop = box.scrollHeight;
  }
  // the scoreboard beside the playfield, and the room's results under the round's results
  function ranked() {
    return [...(room?.players.values() || [])].map((p) => ({ ...p, live: p.live || { score: 0, acc: 1, combo: 0, miss: 0 } })).sort((a, b) => b.live.score - a.live.score);
  }
  function renderBoard() {
    const board = $("#mpBoard");
    const show = !!room && inRound && api.screen() === "play";
    board.hidden = !show;
    if (show) {
      board.innerHTML = ranked().map((p, i) => `<li class="${p.id === room.me ? "me" : ""}${p.live.failed ? " failed" : ""}"><span class="rk">${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="sc">${fmt(p.live.score)}</span><span class="cb">${p.live.combo || 0}x · ${((p.live.acc ?? 1) * 100).toFixed(1)}%</span></li>`).join("");
    }
    const res = $("#mpResults");
    if (res) {
      res.hidden = !room || !inRound;
      if (!res.hidden) {
        res.innerHTML = `<h3>Room ${esc(room.code)}</h3><ol>${ranked().map((p, i) => `<li class="${p.id === room.me ? "me" : ""}"><span class="rk">#${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="sc">${fmt(p.live.score)}</span><span class="st">${p.live.done ? (p.live.failed ? "Failed" : `${((p.live.acc ?? 0) * 100).toFixed(2)}% · ${p.live.maxCombo ?? 0}x · ${p.live.miss ?? 0} miss`) : "playing…"}</span></li>`).join("")}</ol>`;
      }
    }
  }

  // ---- controls ----
  $("#mpName").oninput = (e) => { name = e.target.value.slice(0, 24) || "Player"; store.set("osuweb.mpName", name); };
  $("#mpCreate").onclick = () => createRoom();
  $("#mpJoinBtn").onclick = () => joinRoom($("#mpJoinCode").value);
  $("#mpJoinCode").onkeydown = (e) => { if (e.key === "Enter") joinRoom(e.target.value); };
  $("#mpLeave").onclick = () => { leave(); status("You left the room."); };
  $("#mpCopy").onclick = async () => {
    const link = `${location.origin}${location.pathname}?room=${room?.code}`;
    try { await navigator.clipboard.writeText(link); $("#mpCopy").textContent = "Link copied!"; }
    catch (_) { prompt("Copy this invite link:", link); }
    setTimeout(() => { $("#mpCopy").textContent = "Copy invite link"; }, 1800);
  };
  $("#mpPick").onclick = () => api.pickMap((sel) => { if (room?.host) setMap(sel); api.showScreen("mp"); });
  $("#mpGo").onclick = () => {
    if (!room) return;
    if (room.host) start();
    else { const me = room.players.get(room.me); hostLink()?.send({ t: "ready", v: !me?.ready }); }
  };
  $("#mpChatForm").onsubmit = (e) => { e.preventDefault(); sendChat($("#mpChatIn").value); $("#mpChatIn").value = ""; };
  $("#mpBack").onclick = () => api.showScreen("playmenu");
  addEventListener("keydown", (e) => {
    if (api.screen() !== "mp" || e.code !== "Escape" || e.target.closest?.("input")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    api.showScreen("playmenu");
  }, true);
  addEventListener("beforeunload", () => leave(true));
  // an invite link (?room=CODE) fills in the code, ready to join
  const invited = (params.get("room") || "").toUpperCase();
  if (invited) $("#mpJoinCode").value = invited;
  render();

  return {
    invited: !!invited,
    get inRound() { return inRound; },
    // each frame of a round: the score goes to the room a few times a second
    tick(st) {
      if (!inRound || roundDone || !room) return;
      const now = performance.now();
      if (now - lastLive < 300) return;
      lastLive = now;
      sendLive(liveOf(st, false));
      renderBoard();
    },
    // the round's results: final score to the room, the room's ranking under the results
    finish(st) {
      if (!inRound || !room) return;
      roundDone = true;
      sendLive(liveOf(st, true));
      renderBoard();
    },
    // leaving the results (or quitting the round) goes back to the room
    roundOver(quit) {
      if (!inRound) return false;
      if (quit && room && !roundDone) { const p = room.players.get(room.me); sendLive({ ...(p?.live || { score: 0, acc: 0, combo: 0, miss: 0 }), done: true, failed: true }); }
      roundDone = true;
      inRound = false;
      delete document.body.dataset.mp;
      renderBoard();
      render();
      return !!room;
    },
    screenChanged() { renderBoard(); if (api.screen() === "mp") render(); },
  };
}
