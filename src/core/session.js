// Witness core: the TCP/WebSocket server an adapter connects to, and a Session that sends
// protocol commands (docs/PROTOCOL.md) and matches replies by id.
import { hint } from "./expr.js";
import net from "node:net";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export class WitnessError extends Error {}

/** Listen on host:port (port 0 = random). Resolves {server, port, nextSession()}. */
export function listen({ host = "127.0.0.1", port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const waiting = [];
    const ready = [];
    const timers = new Set();
    const server = net.createServer((sock) => {
      sniff(sock).then((conn) => {
        const s = new Session(conn);
        // a connection that goes away before its hello (a probe, a dying old game) is dropped, not an unhandled rejection
        s.helloP.catch(() => { const i = ready.indexOf(s); if (i >= 0) ready.splice(i, 1); });
        const w = waiting.shift();
        if (w) w(s); else ready.push(s);
      }).catch(() => sock.destroy());
    });
    server.on("error", reject);
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        /** Wait for the next adapter connection (and its hello). */
        nextSession(timeoutMs = 30000) {
          return new Promise((res, rej) => {
            const timer = setTimeout(() => { timers.delete(timer); rej(new WitnessError(`no game connected within ${timeoutMs / 1000}s — is the Witness adapter wired in, and does the game read WITNESS_ADDR? (see 'witness doctor${hint.flags}')`)); }, timeoutMs);
            timers.add(timer);
            const done = () => { clearTimeout(timer); timers.delete(timer); };
            const take = (s) => s.helloP.then(() => { done(); res(s); }, (e) => { done(); rej(e); });
            const s = ready.shift();
            if (s) take(s); else waiting.push(take);
          });
        },
        close() { server.close(); for (const t of timers) clearTimeout(t); timers.clear(); },   // a pending wait never fires after close
      });
    });
  });
}

// Decide between raw NDJSON and WebSocket by peeking at the first bytes. A WebSocket handshake may arrive in several
// chunks: it is read up to its blank line first. A bad handshake closes that socket only (never an uncaught throw).
function sniff(sock) {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    const stop = () => { sock.pause(); sock.removeListener("data", onData); };
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      const start = head.slice(0, 4).toString("latin1");
      if (start.length < 4 && "GET ".startsWith(start)) return;   // too short to tell yet
      if (start !== "GET ") { stop(); resolve(ndjsonConn(sock, head)); return; }
      if (head.indexOf("\r\n\r\n") < 0) {
        if (head.length > 65536) { stop(); sock.destroy(); reject(new Error("websocket handshake too long")); }
        return;
      }
      stop();
      try { resolve(wsUpgrade(sock, head)); } catch (e) { reject(e); }
    };
    sock.on("data", onData);
    sock.once("error", reject);
    sock.once("close", () => reject(new Error("closed before saying anything")));
  });
}

/** A line-based connection: {send(obj), onMessage(fn), onClose(fn), close()}. */
function ndjsonConn(sock, first) {
  const handlers = { msg: [], close: [] };
  // a character's UTF-8 bytes can be split across two chunks: the decoder holds the partial bytes until the rest
  const dec = new StringDecoder("utf8");
  let buf = "";
  const feed = (d) => {
    buf += dec.write(d);
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line.startsWith("@w") ? line.slice(2) : line); }
      catch {
        // report it instead of silently dropping it (a bare NaN in a snapshot is the classic cause)
        for (const h of handlers.msg) h({ event: "badline", line: line.slice(0, 300) });
        continue;
      }
      for (const h of handlers.msg) h(obj);
    }
  };
  sock.on("data", feed);
  sock.on("close", () => handlers.close.forEach((h) => h()));
  sock.on("error", () => {});
  setImmediate(() => { feed(first); sock.resume(); });   // after the Session attaches its handlers
  return {
    kind: "tcp",
    send: (o) => sock.write(JSON.stringify(o) + "\n"),
    onMessage: (h) => handlers.msg.push(h),
    onClose: (h) => handlers.close.push(h),
    close: () => sock.end(),
  };
}

/** Minimal RFC 6455 server side (text frames, client-masked, fragmentation-safe). */
function wsUpgrade(sock, first) {
  const handlers = { msg: [], close: [] };
  let head = first.toString("latin1");
  const end = head.indexOf("\r\n\r\n");
  const key = /sec-websocket-key:\s*(.+)\r\n/i.exec(head)?.[1]?.trim();
  if (!key || end < 0) { try { sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch { /* gone */ } throw new Error("bad websocket handshake (no Sec-WebSocket-Key)"); }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = first.slice(Buffer.byteLength(head.slice(0, end + 4), "latin1"));
  let frag = [];
  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mlen = masked ? 4 : 0;
      if (buf.length < off + mlen + len) return;
      const mask = masked ? buf.slice(off, off + 4) : null;
      const payload = Buffer.from(buf.slice(off + mlen, off + mlen + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.slice(off + mlen + len);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { sendFrame(10, payload); continue; }
      if (op === 1 || op === 0) {
        frag.push(payload);
        if (fin) {
          const text = Buffer.concat(frag).toString("utf8");
          frag = [];
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try { const obj = JSON.parse(line); for (const h of handlers.msg) h(obj); } catch { /* ignore */ }
          }
        }
      }
    }
  };
  const sendFrame = (op, data) => {
    const len = data.length;
    const hdr = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.from([0x80 | op, 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    sock.write(Buffer.concat([hdr, data]));
  };
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
  sock.on("close", () => handlers.close.forEach((h) => h()));
  sock.on("error", () => {});
  setImmediate(() => { parse(); sock.resume(); });
  return {
    kind: "websocket",
    send: (o) => sendFrame(1, Buffer.from(JSON.stringify(o), "utf8")),
    onMessage: (h) => handlers.msg.push(h),
    onClose: (h) => handlers.close.push(h),
    close: () => { try { sendFrame(8, Buffer.alloc(0)); } catch { /* gone */ } sock.end(); },
  };
}

export class Session {
  constructor(conn) {
    this.conn = conn;
    this.nextId = 1;
    this.pending = new Map();
    this.logs = [];          // {frame, level, message}
    this.events = [];        // unsolicited structured events other than logs, e.g. {event: "sound", name, frame}
    this.closed = false;
    this.hello = null;
    this.helloP = new Promise((res, rej) => { this._helloRes = res; this._helloRej = rej; });
    this._helloTimer = setTimeout(() => this._helloRej(new WitnessError("the game connected but never sent its hello (see docs/PROTOCOL.md §2)")), 15000);
    this._wire(conn);
  }

  /** Listen to a connection; messages from any connection but the current one (an adopted page's old one) are dropped. */
  _wire(conn) {
    const helloTimer = this._helloTimer;
    conn.onMessage((m) => {
      if (conn !== this.conn) return;
      if (m.hello) { clearTimeout(helloTimer); this.hello = m.hello; this._helloRes(m.hello); return; }
      if (m.event === "badline") {
        this.lastBadLine = m.line;
        this.logs.push({ frame: null, level: "error", message: `the game sent a line that isn't valid JSON (NaN/Infinity? an unescaped string?): ${m.line}` });
        // a garbled reply would otherwise just time out: fail the oldest pending request now
        const first = this.pending.entries().next().value;
        if (first && /"id"\s*:/.test(m.line)) {
          const [id, { rej, cmd, timer }] = first;
          clearTimeout(timer);
          this.pending.delete(id);
          rej(new WitnessError(`the game's reply to '${cmd}' isn't valid JSON: ${m.line.slice(0, 200)} — use the adapter's JSON writer (NaN must be sent as "NaN")`));
        }
        return;
      }
      if (m.event) {
        if (m.event === "log") this.logs.push({ frame: m.frame ?? null, level: m.level || "info", message: String(m.message ?? "") });
        else {
          // structured events (e.g. {"event": "sound", "name": "jump", "frame": 61}): kept for the command to read
          this.events.push(m);
          if (this.events.length > 20000) this.events.splice(0, this.events.length - 20000);
        }
        return;
      }
      if (m.id != null && this.pending.has(m.id)) {
        const { res, rej, cmd, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        if (m.ok === false) rej(new WitnessError(`game error on '${cmd}': ${m.error || "unknown error"}`));
        else res(m);
      }
    });
    conn.onClose(() => {
      if (conn !== this.conn) return;
      this.closed = true;
      clearTimeout(helloTimer);
      this._helloRej(new WitnessError("the game disconnected before saying hello"));
      for (const { rej, cmd, timer } of this.pending.values()) { clearTimeout(timer); rej(new WitnessError(`the game disconnected (or crashed) during '${cmd}'`)); }
      this.pending.clear();
    });
  }

  /**
   * Go on over another session's connection (a browser page reloaded for a reset reconnects as a new session): this
   * session keeps its hello, logs and events; the other one goes quiet.
   */
  adopt(other) {
    const conn = other.conn;
    other.conn = null;
    this.conn = conn;
    this.closed = !!other.closed;
    this._wire(conn);
  }

  has(cap) { return !!(this.hello && (this.hello.capabilities || []).includes(cap)); }
  get fps() { return (this.hello && this.hello.fps) || 60; }

  request(cmd, args = {}, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new WitnessError(`the game is not connected (it may have crashed) — can't '${cmd}'`));
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { this.pending.delete(id); rej(new WitnessError(`the game didn't answer '${cmd}' within ${timeoutMs / 1000}s (is it stuck, or not handling '${cmd}'?)`)); }, timeoutMs);
      this.pending.set(id, { res, rej, cmd, timer });
      this.conn.send({ id, cmd, ...args });
    });
  }

  // convenience wrappers
  /** epoch: the virtual Date's start for this run (ms; witness.json clock.epoch or a replay's), sent only when set. */
  reset(seed, scene, params, epoch = this.epoch) { return this.request("reset", { seed, ...(scene ? { scene } : {}), ...(params ? { params } : {}), ...(epoch != null ? { epoch } : {}) }); }
  /** Queue input; a long replay's events go in several requests (one huge line can stall or overflow an adapter). */
  /** In requests of at most `chunk` events and about `maxBytes` (a web adapter's inbound buffer: Godot's is 4 MiB). */
  async input(events, chunk = 2000, maxBytes = 1 << 20) {
    let part = [], bytes = 0;
    for (const e of events) {
      const n = JSON.stringify(e).length + 1;
      if (part.length && (part.length >= chunk || bytes + n > maxBytes)) { await this.request("input", { events: part }); part = []; bytes = 0; }
      part.push(e); bytes += n;
    }
    if (part.length) await this.request("input", { events: part });
  }
  step(frames, dt, dts) { return this.request("step", { frames, ...(dt ? { dt } : {}), ...(dts ? { dts } : {}) }, Math.max(60000, frames * 50)); }
  snapshot(paths) { return this.request("snapshot", paths ? { paths } : {}); }
  screenshot(scale) { return this.request("screenshot", scale ? { scale } : {}, 120000); }
  audio() { return this.request("audio", {}, 120000); }
  call(name, args = []) { return this.request("call", { name, args }); }
  eval(expr) { return this.request("eval", { expr }); }
  /** Fetch the adapter's logs into this.logs (kept until drainLogs): before a reset, which may clear the adapter's. */
  async pullLogs() {
    if (this.has("logs") && !this.closed) {
      try { const r = await this.request("logs"); for (const l of r.logs || []) this.logs.push(l); } catch { /* optional */ }
    }
  }
  async drainLogs() {
    await this.pullLogs();
    const out = this.logs;
    this.logs = [];
    return out;
  }
  /** Take the collected events of one kind (e.g. "sound"), oldest first; others stay. */
  drainEvents(kind) {
    const out = this.events.filter((e) => e.event === kind);
    this.events = this.events.filter((e) => e.event !== kind);
    return out;
  }
  quit() { return this.closed ? Promise.resolve() : this.request("quit", {}, 5000).catch(() => {}); }
  close() { try { this.conn.close(); } catch { /* gone */ } }
}
