// Multiplayer: rooms of players who play the same map at the same time and see each other's scores live.
//
// The site is static (GitHub Pages), so there is no game server. Players connect to each other directly over
// WebRTC data channels, and public matchmaking servers only introduce them: they pass one "offer" and one "answer"
// between the two browsers, each holding every network route that browser found (no trickled candidates).
// Two kinds of matchmaking server are used at once, so one being down doesn't stop anyone:
//   * the free PeerJS cloud server (0.peerjs.com), where the host registers as "osuwebport-<code>";
//   * public WebTorrent trackers, where the room is a "torrent" (a hash of the code) that the host joins and a
//     joining player sends offers into.
// The host listens on all of them; a joining player tries all of them at once and keeps the first connection that
// opens. The host's browser runs the room: everyone connects to the host, and the host passes the room's state,
// chat and scores on to everyone.
//
// The host picks the map; a player without it gets it sent by the host over the data channel and saved like an
// imported map. When everyone is ready, the host starts the round: each player plays it on their own clock and
// reports score, combo, accuracy and misses a few times a second.
//
// The server list: a host can make its room public. Public hosts also join one shared "lobby" torrent on the
// trackers. A browser looking for rooms sends a batch of little "list" offers into that torrent; the tracker hands
// each to a random peer in it, and every public host that gets one answers with its room's details (code, host,
// map, players) in place of a connection answer. No connection is made for the list itself.
//
// createMultiplayer(api) wires it into the page; api is described where index.html calls it.

const PEERJS = "wss://0.peerjs.com:443/peerjs";
const TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev",
  "wss://tracker.btorrent.xyz",
];
const ICE = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" },
];
const PREFIX = "osuwebport-";
const CHUNK = 16 * 1024;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// the connection log ("Connection details" on the multiplayer screen, and the console)
const LOG = [];
let onLog = null;
const t0 = performance.now();
function mpLog(msg) {
  const line = `${((performance.now() - t0) / 1000).toFixed(1)}s  ${msg}`;
  LOG.push(line);
  if (LOG.length > 300) LOG.shift();
  console.info("[multiplayer]", msg);
  onLog?.();
}
const short = (id) => String(id || "").replace(PREFIX, "");
const hostOf = (url) => { try { return new URL(url.replace(/^ws/, "http")).hostname; } catch (_) { return url; } };
const rand = (n, chars = "abcdefghijklmnopqrstuvwxyz0123456789") => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
// a "torrent" on the trackers: 20 hex characters of SHA-1 of a name
async function hashOf(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));
  return [...d.slice(0, 10)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// the room's torrent
const roomHash = (code) => hashOf(`osuwebport/${code}`);
// the server list's torrent, the "offer" that asks for a room's details, and the start of the answer carrying them
const LOBBY = "osuwebport/lobby/1";
const LIST_ASK = "osuwebport-list";
const LIST_INFO = "osuwebport-room:";
const LIST_OFFERS = 4; // reduced from 20 to prevent tracker rate-limiting on cloud hosting
// counts the kinds of route in an SDP (host = same network, srflx = through the router, relay = TURN)
function countRoutes(sdp, into) {
  for (const m of String(sdp || "").matchAll(/ typ (host|srflx|relay|prflx)/g)) if (m[1] in into) into[m[1]]++;
  return into;
}
const routesText = (o) => `${o.host} local, ${o.srflx} internet, ${o.relay} relay`;
// waits until the browser has found its routes (or ms passed), so the offer / answer carries them all
function gathered(pc, ms = 3500) {
  return new Promise((res) => {
    if (pc.iceGatheringState === "complete") return res();
    const t = setTimeout(res, ms);
    pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } });
  });
}
const descOf = (pc) => ({ type: pc.localDescription.type, sdp: pc.localDescription.sdp });

// ---- the PeerJS server: a WebSocket that passes OFFER / ANSWER messages between peer ids ----
class Signal {
  constructor(id, url) {
    this.id = id;
    this.url = url;
    this.name = "PeerJS";
    this.onmessage = null;
    this.onclose = null;
  }
  open() {
    return new Promise((resolve, reject) => {
      let opened = false;
      mpLog(`PeerJS: connecting as ${short(this.id)}`);
      const ws = new WebSocket(`${this.url}?key=peerjs&id=${encodeURIComponent(this.id)}&token=${rand(12)}&version=1.5.4`);
      this.ws = ws;
      const fail = (msg) => { if (!opened) { opened = true; mpLog(`PeerJS: failed (${msg})`); reject(new Error(msg)); try { ws.close(); } catch (_) {} } };
      const timer = setTimeout(() => fail("no answer"), 9000);
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m.type === "OPEN") {
          mpLog(`PeerJS: connected as ${short(this.id)}`);
          opened = true;
          clearTimeout(timer);
          this.hb = setInterval(() => this.raw({ type: "HEARTBEAT" }), 5000);
          resolve();
        } else if (m.type === "ID-TAKEN") {
          clearTimeout(timer);
          mpLog(`PeerJS: ID-TAKEN for ${short(this.id)}`);
          if (!opened) { opened = true; reject(Object.assign(new Error("id-taken"), { taken: true })); }
        } else if (m.type === "ERROR") {
          clearTimeout(timer);
          mpLog(`PeerJS: ERROR ${JSON.stringify(m.payload || {})}`);
          fail(m.payload?.msg || "refused");
        } else {
          mpLog(`PeerJS: got ${m.type}${m.src ? ` from ${short(m.src)}` : ""}`);
          this.onmessage?.(m);
        }
      };
      ws.onerror = () => { clearTimeout(timer); fail("couldn't reach it"); };
      ws.onclose = (e) => { clearInterval(this.hb); if (opened) { if (!this.closing) mpLog(`PeerJS: connection closed by the server (code ${e.code}${e.reason ? `, ${e.reason}` : ""})`); this.onclose?.(); } else { clearTimeout(timer); fail(`closed, code ${e.code}`); } };
    });
  }
  raw(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  send(type, dst, payload) {
    mpLog(`PeerJS: sending ${type} to ${short(dst)}${this.ws?.readyState === 1 ? "" : " (NOT CONNECTED)"}`);
    this.raw({ type, dst, payload });
  }
  close() { clearInterval(this.hb); this.onclose = null; this.closing = true; try { this.ws?.close(); } catch (_) {} }
}

// ---- a WebTorrent tracker: announces into a "torrent", passes offers and answers between its peers ----
class Tracker {
  constructor(url) {
    this.url = url;
    this.name = hostOf(url);
    this.onOffer = null;
    this.onAnswer = null;
    this.keep = new Map();      // info_hash -> timer that announces again
    this.started = new Set();   // info_hashes announced in
  }
  open() {
    return new Promise((resolve, reject) => {
      let done = false;
      mpLog(`tracker ${this.name}: connecting`);
      let ws;
      try { ws = new WebSocket(this.url); } catch (err) { reject(err); return; }
      this.ws = ws;
      const timer = setTimeout(() => { if (!done) { done = true; mpLog(`tracker ${this.name}: no answer`); try { ws.close(); } catch (_) {} reject(new Error("timeout")); } }, 8000);
      ws.onopen = () => { if (done) return; done = true; clearTimeout(timer); mpLog(`tracker ${this.name}: connected`); resolve(); };
      ws.onerror = () => { if (!done) { done = true; clearTimeout(timer); mpLog(`tracker ${this.name}: couldn't reach it`); reject(new Error("unreachable")); } };
      ws.onclose = (e) => { for (const k of this.keep.values()) clearInterval(k); this.keep.clear(); if (done && !this.closing) mpLog(`tracker ${this.name}: connection closed (code ${e.code})`); };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        if (m["failure reason"] || m.failure_reason) { mpLog(`tracker ${this.name}: error "${m["failure reason"] || m.failure_reason}"`); return; }
        const quiet = m.offer?.sdp === LIST_ASK || String(m.answer?.sdp || "").startsWith(LIST_INFO);
        if (m.offer && m.offer_id) { if (!quiet) mpLog(`tracker ${this.name}: got an offer`); this.onOffer?.(m.peer_id, m.offer, m.offer_id, m.info_hash); }
        else if (m.answer && m.offer_id) { if (!quiet) mpLog(`tracker ${this.name}: got an answer`); this.onAnswer?.(m.peer_id, m.answer, m.offer_id, m.info_hash); }
      };
    });
  }
  raw(m) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  announce(hash, peerId, offers = []) {
    this.raw({ action: "announce", info_hash: hash, peer_id: peerId, numwant: Math.max(1, offers.length), uploaded: 0, downloaded: 0, left: 1, event: this.started.has(hash) ? undefined : "started", offers });
    this.started.add(hash);
  }
  // stays in the torrent: trackers drop peers that don't announce again
  keepAnnouncing(hash, peerId) {
    clearInterval(this.keep.get(hash));
    this.announce(hash, peerId);
    this.keep.set(hash, setInterval(() => this.announce(hash, peerId), 40000));
  }
  // leaves the torrent
  stop(hash, peerId) {
    clearInterval(this.keep.get(hash));
    this.keep.delete(hash);
    if (!this.started.delete(hash)) return;
    this.raw({ action: "announce", info_hash: hash, peer_id: peerId, numwant: 0, uploaded: 0, downloaded: 0, left: 1, event: "stopped" });
  }
  answer(hash, peerId, toPeer, offerId, answer) {
    mpLog(`tracker ${this.name}: sending an answer`);
    this.raw({ action: "announce", info_hash: hash, peer_id: peerId, to_peer_id: toPeer, offer_id: offerId, answer });
  }
  close() {
    if (this.peerId) for (const h of [...this.started]) this.stop(h, this.peerId);
    for (const k of this.keep.values()) clearInterval(k);
    this.keep.clear();
    this.closing = true;
    try { this.ws?.close(); } catch (_) {}
  }
}

// ---- one WebRTC connection to another player, with one ordered, reliable data channel ----
class Link {
  constructor(remote, initiator, handlers, via = "") {
    this.remote = remote;
    this.via = via;
    this.h = handlers;              // { open, message, binary, answered, close }
    this.closed = false;
    this.opened = false;
    // for the log and the error message: did the other side answer, how far ICE got, which routes each side has
    this.diag = { answered: false, ice: "new", mine: { host: 0, srflx: 0, relay: 0 }, theirs: { host: 0, srflx: 0, relay: 0 } };
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc = pc;
    pc.oniceconnectionstatechange = () => {
      this.diag.ice = pc.iceConnectionState;
      mpLog(`direct link (${via}): ${pc.iceConnectionState}`);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.close(`connection ${pc.connectionState}`);
    };
    pc.ondatachannel = (e) => this.useChannel(e.channel);
    if (initiator) this.useChannel(pc.createDataChannel("osu", { ordered: true }));
  }
  async offer() {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    const d = descOf(this.pc);
    countRoutes(d.sdp, this.diag.mine);
    return d;
  }
  async answerTo(desc) {
    countRoutes(desc.sdp, this.diag.theirs);
    await this.pc.setRemoteDescription(desc);
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    const d = descOf(this.pc);
    countRoutes(d.sdp, this.diag.mine);
    mpLog(`answering (${this.via}): my routes ${routesText(this.diag.mine)}; theirs ${routesText(this.diag.theirs)}`);
    return d;
  }
  async accept(desc) {
    if (this.diag.answered || this.closed) return;
    this.diag.answered = true;
    countRoutes(desc.sdp, this.diag.theirs);
    mpLog(`got an answer (${this.via}): my routes ${routesText(this.diag.mine)}; theirs ${routesText(this.diag.theirs)}`);
    this.h.answered?.(this);
    try { await this.pc.setRemoteDescription(desc); } catch (err) { mpLog(`bad answer (${this.via}): ${err.message}`); }
  }
  useChannel(dc) {
    this.dc = dc;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = 256 * 1024;
    const opened = () => { if (this.opened || this.closed) return; this.opened = true; mpLog(`connected (${this.via})`); this.h.open?.(this); };
    dc.onopen = opened;
    if (dc.readyState === "open") queueMicrotask(opened);
    dc.onmessage = (e) => {
      if (typeof e.data === "string") {
        let m;
        try { m = JSON.parse(e.data); } catch (_) { return; }
        this.h.message?.(this, m);
      } else this.h.binary?.(this, e.data);
    };
    dc.onclose = () => this.close("data channel closed");
  }
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
  close(why = "") {
    if (this.closed) return;
    this.closed = true;
    if (this.opened || why !== "another route won") mpLog(`direct link (${this.via}) closed${why ? `: ${why}` : ""}`);
    try { this.dc?.close(); } catch (_) {}
    try { this.pc.close(); } catch (_) {}
    this.h.close?.(this);
  }
}

// ---- the room and its screen ----
export function createMultiplayer(api) {
  const $= api.$;
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} },
  };
  const params = new URLSearchParams(location.search);
  // matchmaking servers; ?peerserver= and ?trackers= swap in local ones for testing ("off" leaves one kind out)
  const server = params.get("peerserver") === "off" ? null : params.get("peerserver") || PEERJS;
  const trackers = params.get("trackers") === "off" ? [] : params.get("trackers") ? params.get("trackers").split(",") : TRACKERS;
  let name = store.get("osuweb.mpName", "") || `Player${Math.floor(1000 + Math.random() * 9000)}`;

  let room = null;     // { code, host, signals (matchmaking connections), links: Map (host), hostLink (guest), players: Map, map, phase, me }
  let inRound = false;
  let roundDone = false;   // this player's final score has gone out; no more live updates this round
  let lastLive = 0;
  let incoming = null; // a map being received: { name, size, parts, got }

  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmt = (n) => Math.round(n || 0).toLocaleString();
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const status = (msg, err = false) => { const el = $("#mpStatus"); el.textContent = msg || ""; el.classList.toggle("err", !!err); if (msg) mpLog(`${err ? "ERROR shown" : "status"}: ${msg}`); };
  const haveMap = (n) => !!n && api.maps().some((r) => r.name === n);

  // ---------------------------------------------------------------- host side ----
  function hostState() {
    return {
      t: "state",
      code: room.code,
      phase: room.phase,
      public: !!room.public,
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
    status("Creating a room…");
    // a code that is free on PeerJS (when PeerJS is reachable at all)
    let code = null, sig = null;
    if (server) {
      for (let tries = 0; tries < 4 && !sig; tries++) {
        code = rand(5, CODE_CHARS);
        const s = new Signal(PREFIX + code, server);
        try { await s.open(); sig = s; } catch (err) { if (!err.taken) break; }
      }
    }
    code = code || rand(5, CODE_CHARS);
    const r = { code, host: true, signals: [], links: new Map(), players: new Map(), map: null, phase: "lobby", me: "host", public: false };
    room = r;
    r.players.set("host", { id: "host", name, host: true, ready: true, hasMap: false, dl: null, live: null });
    // an offer from a joining player, by any route: answered once per player
    const accept = (guest, desc, reply, via) => {
      if (room !== r) return;
      if (r.links.has(guest)) { mpLog(`already connecting to ${guest.slice(0, 6)}: ignoring its offer via ${via}`); return; }
      const link = new Link(guest, false, {
        open: (l) => {
          r.players.set(l.remote, { id: l.remote, name: "Player", host: false, ready: false, hasMap: false, dl: null, live: null });
          broadcast(true);
        },
        message: hostMessage,
        close: (l) => {
          r.links.delete(l.remote);
          const p = r.players.get(l.remote);
          if (p && room === r) { r.players.delete(l.remote); chat(null, `${p.name} left`, true); broadcast(true); checkRoundOver(); }
        },
      }, via);
      r.links.set(guest, link);
      link.answerTo(desc).then(reply).catch((err) => { mpLog(`couldn't answer (${via}): ${err.message}`); link.close("bad offer"); });
    };
    if (sig) {
      r.signals.push(sig);
      sig.onmessage = (m) => {
        if (m.type === "OFFER" && m.src) {
          accept(m.src.replace(PREFIX + "p-", ""), m.payload.sdp, (ans) => sig.send("ANSWER", m.src, { sdp: ans, type: "data", connectionId: m.payload.connectionId }), "PeerJS");
        }
      };
    }
    const hash = await roomHash(code);
    const me = rand(20);
    r.trackerId = me;
    r.lobby = await hashOf(LOBBY);
    const up = await Promise.all(trackers.map(async (url) => {
      const tr = new Tracker(url);
      try { await tr.open(); } catch (_) { return false; }
      if (room !== r) { tr.close(); return false; }
      tr.peerId = me;
      r.signals.push(tr);
      tr.onOffer = (from, offer, offerId, h) => {
        if (h === r.lobby) {
          // someone looking at the server list: answer with the room's details while the room is public
          if (r.public && offer?.sdp === LIST_ASK) tr.answer(r.lobby, me, from, offerId, { type: "answer", sdp: LIST_INFO + JSON.stringify(roomInfo(r)) });
          return;
        }
        accept(from, offer, (ans) => tr.answer(hash, me, from, offerId, ans), tr.name);
      };
      tr.keepAnnouncing(hash, me);
      if (r.public) tr.keepAnnouncing(r.lobby, me);
      return true;
    }));
    if (room !== r) return;
    const nTr = up.filter(Boolean).length;
    mpLog(`room ${code} is open on: ${[sig && "PeerJS", nTr && `${nTr} of${trackers.length} trackers`].filter(Boolean).join(" and ") || "nothing"}`);
    if (!sig && !nTr) { leave(true); status("Couldn't reach any matchmaking server, so no one could join. Check your connection, then try again.", true); return; }
    const sel = api.selection();
    if (sel?.name) setMap(sel);
    status("");
    history.replaceState(null, "", `?room=${code}`);
    render();
    broadcast(true);
  }
  // what the server list shows about a room
  function roomInfo(r) {
    const cut = (t, n) => String(t || "").slice(0, n);
    const host = r.players.get("host");
    return {
      code: r.code,
      host: cut(host?.name || name, 24),
      players: r.players.size,
      phase: r.phase,
      title: r.map ? cut(r.map.title || r.map.name.replace(/\.osz$/i, ""), 80) : "",
      artist: r.map ? cut(r.map.artist, 60) : "",
      diff: r.map ? cut(r.map.diffName, 60) : "",
      mods: r.map?.mods?.length ? r.map.mods.join("").slice(0, 24) : "",
    };
  }
  // shows the room in the server list, or takes it out
  async function setPublic(on) {
    if (!room?.host) return;
    room.public = !!on;
    const lobby = await hashOf(LOBBY);
    for (const tr of room.signals) {
      if (!(tr instanceof Tracker)) continue;
      if (on) {
        if (tr.ws?.readyState !== 1) {
          try { await tr.open(); } catch (_) { continue; }
          tr.peerId = room.trackerId;
        }
        tr.keepAnnouncing(lobby, room.trackerId);
      } else {
        tr.stop(lobby, room.trackerId);
      }
    }
    mpLog(`room ${room.code} is now ${on ? "public" : "private"}`);
    broadcast(true);
    render();
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
    const token = rand(20);
    const hostId = PREFIX + code;
    const r = { code, host: false, signals: [], links: new Map(), hostLink: null, players: new Map(), map: null, phase: "lobby", me: null };
    room = r;
    status(`Joining ${code}…`);
    const attempts = [];
    let reached = 0;           // matchmaking servers reached
    const live = () => room === r && !r.hostLink;
    // the first route to open wins; the others are dropped
    const win = (l) => {
      if (!live()) { l.h.close = null; l.close("another route won"); return; }
      r.hostLink = l;
      clearTimeout(timer);
      mpLog(`joined room ${code} via ${l.via}`);
      for (const o of attempts) if (o !== l) { o.h.close = null; o.close("another route won"); }
      for (const s of r.signals) s.close();
      r.signals = [];
      l.send({ t: "hello", name });
      status("");
      history.replaceState(null, "", `?room=${code}`);
    };
    const attempt = (via) => {
      const l = new Link("host", true, {
        answered: () => { if (live()) status(`Found room ${code}, connecting…`); },
        open: win,
        message: (l2, m) => guestMessage(l2, m),
        binary: (l2, buf) => { if (incoming) { incoming.parts.push(buf); incoming.got += buf.byteLength; reportHave(); } },
        close: (l2) => { if (room === r && r.hostLink === l2) { leave(true); status("The host closed the room.", true); } },
      }, via);
      attempts.push(l);
      return l;
    };
    const why = () => {
      if (!reached) return "Couldn't reach any matchmaking server. Check your connection, then try again.";
      const answered = attempts.filter((a) => a.diag.answered);
      if (!answered.length) return `No answer from room ${code}. Check the code, and that the room is still open in the host's tab (a tab in the background can fall asleep).`;
      const a = answered[0];
      return `Found the host, but a direct connection couldn't be made (a firewall or network is blocking it). Your routes: ${routesText(a.diag.mine)}; the host's: ${routesText(a.diag.theirs)}.`;
    };
    const timer = setTimeout(() => { if (live()) { const msg = why(); leave(true); status(msg, true); } }, 25000);
    render();
    // PeerJS: an offer to the host's id
    if (server) (async () => {
      const sig = new Signal(PREFIX + "p-" + token, server);
      try { await sig.open(); } catch (_) { return; }
      if (!live()) { sig.close(); return; }
      reached++;
      r.signals.push(sig);
      const l = attempt("PeerJS");
      const offer = await l.offer();
      if (!live()) return;
      sig.onmessage = (m) => {
        if (m.type === "ANSWER" && m.src === hostId) l.accept(m.payload.sdp);
        else if (m.type === "EXPIRE" && m.src === hostId) mpLog("PeerJS: no room with that code there");
      };
      sig.send("OFFER", hostId, { sdp: offer, type: "data", connectionId: "dc_" + rand(10), serialization: "raw", reliable: true });
    })();
    // trackers: offers into the room's torrent (two each, in case another joining player gets one first)
    const hash = await roomHash(code);
    for (const url of trackers) (async () => {
      const tr = new Tracker(url);
      try { await tr.open(); } catch (_) { return; }
      if (!live()) { tr.close(); return; }
      reached++;
      r.signals.push(tr);
      const mine = [];
      for (let i = 0; i < 2; i++) { const l = attempt(tr.name); l.offerId = rand(20); mine.push(l); }
      const offers = await Promise.all(mine.map(async (l) => ({ offer: await l.offer(), offer_id: l.offerId })));
      if (!live()) return;
      tr.onAnswer = (from, answer, offerId) => mine.find((l) => l.offerId === offerId)?.accept(answer);
      tr.announce(hash, token, offers);
    })();
  }
  // ---------------------------------------------------------------- server list ----
  // Asks the lobby torrent on every tracker for public rooms. Answers come in for a few seconds; a room that
  // didn't answer this time is dropped from the list.
  const browse = { trackers: new Map(), rooms: new Map(), asks: new Set(), busy: false, at: 0, timer: 0, id: rand(20) };
  async function refreshList() {
    if (browse.busy || room) return;
    browse.busy = true;
    browse.at = performance.now();
    renderList();
    const lobby = await hashOf(LOBBY);
    const seen = new Set();
    browse.seen = seen;
    await Promise.all(trackers.map(async (url) => {
      let tr = browse.trackers.get(url);
      if (!tr || tr.ws?.readyState !== 1) {
        tr = new Tracker(url);
        try { await tr.open(); } catch (_) { browse.trackers.delete(url); return; }
        tr.peerId = browse.id;
        browse.trackers.set(url, tr);
        tr.onAnswer = (from, answer, offerId, h) => {
          if (h !== lobby || !browse.asks.has(offerId)) return;
          const sdp = String(answer?.sdp || "");
          if (!sdp.startsWith(LIST_INFO)) return;
          let info;
          try { info = JSON.parse(sdp.slice(LIST_INFO.length)); } catch (_) { return; }
          const code = String(info?.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
          if (code.length < 4) return;
          browse.seen?.add(code);
          browse.rooms.set(code, { ...info, code, players: Math.max(1, Math.min(99, info.players | 0)) });
          renderList();
        };
      }
      const offers = Array.from({ length: LIST_OFFERS }, () => {
        const id = rand(20);
        browse.asks.add(id);
        return { offer: { type: "offer", sdp: LIST_ASK }, offer_id: id };
      });
      tr.announce(lobby, browse.id, offers);
    }));
    await new Promise((r) => setTimeout(r, 4000));
    // out of the lobby again, so other people's list offers go to hosts rather than to this page
    for (const tr of browse.trackers.values()) tr.stop(lobby, browse.id);
    for (const code of [...browse.rooms.keys()]) if (!seen.has(code)) browse.rooms.delete(code);
    browse.asks.clear();
    browse.busy = false;
    browse.done = true;
    browse.reached = browse.trackers.size;
    renderList();
  }
  function stopBrowsing() {
    clearInterval(browse.timer);
    browse.timer = 0;
    for (const tr of browse.trackers.values()) tr.close();
    browse.trackers.clear();
  }
  // refreshes while the list is on screen
  function browseWhileShown() {
    const shown = api.screen() === "mp" && !room && !document.hidden;
    if (shown && !browse.timer) {
      if (performance.now() - browse.at > 5000 || !browse.done) refreshList();
      browse.timer = setInterval(() => refreshList(), 20000);
    } else if (!shown && browse.timer) stopBrowsing();
  }
  function renderList() {
    const ul = $("#mpList");
    if (!ul) return;
    const rooms = [...browse.rooms.values()].sort((a, b) => (a.phase === "playing") - (b.phase === "playing") || b.players - a.players || a.code.localeCompare(b.code));
    $("#mpRefresh").disabled = browse.busy;
    $("#mpRefresh").classList.toggle("spin", browse.busy);
    $("#mpListNote").textContent = rooms.length ? `${rooms.length} open` : "";
    if (!rooms.length) {
      const msg = browse.busy ? "Looking for rooms…"
        : browse.done && !browse.reached ? "Couldn't reach the room servers. Check your connection, then refresh."
        : "No public rooms right now. Create one and make it public!";
      ul.innerHTML = `<li class="mp-empty">${esc(msg)}</li>`;
      return;
    }
    ul.innerHTML = rooms.map((x) => {
      const map = x.title ? `${esc(x.title)}${x.diff ? ` <span>[${esc(x.diff)}]</span>` : ""}${x.mods ? ` <span>+${esc(x.mods)}</span>` : ""}` : `<span>No map picked yet</span>`;
      const playing = x.phase === "playing";
      return `<li><i class="av" style="--h:${hue(x.host)}">${esc(String(x.host || "?").charAt(0).toUpperCase())}</i>`
        + `<div class="mp-li-main"><b>${esc(x.host)}'s room</b><small>${map}</small></div>`
        + `<span class="pill">${x.players} player${x.players === 1 ? "" : "s"}</span>`
        + `<span class="pill ${playing ? "dl" : "ok"}">${playing ? "Playing" : "Open"}</span>`
        + `<button data-code="${esc(x.code)}">Join</button></li>`;
    }).join("");
  }

  const hostLink = () => (room && !room.host ? room.hostLink : null);
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
    if (!room.host) room.public = !!st.public;
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
    mpLog("leaving the room");
    for (const l of [...r.links.values(), ...(r.hostLink ? [r.hostLink] : [])]) { l.h.close = null; l.close("left the room"); }
    for (const s2 of r.signals || []) s2.close();
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
    browseWhileShown();
    if (!inRoom) { renderList(); return; }
    $("#mpCode").textContent = room.code;
    $("#mpPublicBox").hidden = !room.host;
    $("#mpPublic").checked = !!room.public;
    $("#mpPublicTag").hidden = room.host || !room.public;
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

  // ---- connection test: for each matchmaking server, two connections inside this page find each other through it ----
  async function testOne(kind, url) {
    const name = kind === "peerjs" ? "PeerJS" : hostOf(url);
    const a = kind === "peerjs" ? new Signal(PREFIX + "t-" + rand(12), url) : new Tracker(url);
    const b = kind === "peerjs" ? new Signal(PREFIX + "t-" + rand(12), url) : new Tracker(url);
    const links = [];
    const end = (res) => { for (const l of links) { l.h.close = null; l.close(); } a.close(); b.close(); return `${name}: ${res}`; };
    try { await a.open(); await b.open(); } catch (_) { return end("✗ couldn't reach it"); }
    const offerer = new Link("b", true, {}, name), answerer = new Link("a", false, {}, name);
    links.push(offerer, answerer);
    let relayed = false;
    const opened = new Promise((res) => { offerer.h.open = () => res(true); setTimeout(() => res(false), 15000); });
    const offer = await offerer.offer();
    if (kind === "peerjs") {
      b.onmessage = (m) => { if (m.type === "OFFER") { relayed = true; answerer.answerTo(m.payload.sdp).then((ans) => b.send("ANSWER", m.src, { sdp: ans })); } };
      a.onmessage = (m) => { if (m.type === "ANSWER") offerer.accept(m.payload.sdp); };
      a.send("OFFER", b.id, { sdp: offer, type: "data", connectionId: "dc_test" });
    } else {
      const hash = (await roomHash("test-" + rand(8))), idA = rand(20), idB = rand(20);
      b.onOffer = (from, o, offerId) => { relayed = true; answerer.answerTo(o).then((ans) => b.answer(hash, idB, from, offerId, ans)); };
      a.onAnswer = (from, ans) => offerer.accept(ans);
      b.announce(hash, idB);
      await new Promise((r) => setTimeout(r, 1200));    // let b be in the torrent first
      a.announce(hash, idA, [{ offer, offer_id: rand(20) }]);
    }
    const ok = await opened;
    if (ok) return end("✓ works");
    if (!relayed) return end("✗ reached it, but it didn't pass messages along");
    if (!offerer.diag.answered) return end("✗ the answer didn't come back");
    return end(`✗ messages pass, but the direct link didn't open (ICE ${offerer.diag.ice})`);
  }
  async function selfTest() {
    const btn = $("#mpTest");
    btn.disabled = true;
    $("#mpLogBox").open = true;
    mpLog("--- connection test ---");
    status("Testing every matchmaking server (takes up to 20 seconds)…");
    const results = await Promise.all([...(server ? [testOne("peerjs", server)] : []), ...trackers.map((u) => testOne("tracker", u))]);
    for (const res of results) mpLog(`test: ${res}`);
    const good = results.filter((x) => x.includes("✓")).length;
    status(good
      ? `${good} of ${results.length} matchmaking servers work from here, so multiplayer should work. (${results.join(" · ")})`
      : `None of the matchmaking servers worked from here. (${results.join(" · ")})`, !good);
    btn.disabled = false;
  }
  // the connection details and test are for troubleshooting: shown with ?mpdebug in the address
  if (params.has("mpdebug")) $("#mpLogBox").hidden = false;
  onLog = () => { const pre = $("#mpLog"); if (pre) { pre.textContent = LOG.join("\n"); pre.scrollTop = pre.scrollHeight; } };
  onLog();

  // ---- controls ----
  $("#mpTest").onclick = () => selfTest();
  $("#mpLogCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(LOG.join("\n")); $("#mpLogCopy").textContent = "Copied!"; } catch (_) { prompt("Copy this:", LOG.join("\n")); }
    setTimeout(() => { $("#mpLogCopy").textContent = "Copy details"; }, 1500);
  };
  $("#mpName").oninput = (e) => { name = e.target.value.slice(0, 24) || "Player"; store.set("osuweb.mpName", name); };
  $("#mpCreate").onclick = () => createRoom();
  $("#mpPublic").onchange = (e) => setPublic(e.target.checked);
  $("#mpRefresh").onclick = () => refreshList();
  $("#mpList").onclick = (e) => { const b = e.target.closest("button[data-code]"); if (b) joinRoom(b.dataset.code); };
  document.addEventListener("visibilitychange", () => browseWhileShown());
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
    screenChanged() { renderBoard(); if (api.screen() === "mp") render(); else browseWhileShown(); },
  };
}