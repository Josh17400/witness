--[[
Witness adapter for Lua games (protocol v1). Pure Lua 5.1 / LuaJIT / 5.2-5.4, one file.
Transport: LuaSocket (bundled with LÖVE, Defold and most Lua distributions).

Witness lets an outside tool (the `witness` CLI) drive a game deterministically: reset it
with a seed, feed it input on exact frames, step it at a fixed dt, and read back its state,
screenshots, audio and logs. See docs/PROTOCOL.md in the Witness repo.

    local witness = require("witness")
    if witness.active() then
      witness.run{
        name = "My Game", fps = 60, size = {640, 360},
        reset = function(seed, scene, params) ... end,  -- deterministic initial state
        input = function(ev) ... end,                    -- one protocol event, at the start of its frame
        update = function(dt) ... end,                   -- exactly one fixed frame
        snapshot = function() return {...} end,          -- JSON-able table
        screenshot = function(scale) return w, h, rgba end,
        audio = capture,                                 -- witness.capture(rate, channels)
        calls = { teleport = function(x, y) ... end },
      }
    end

LÖVE games: use witness_love.lua, which builds all of this from love.* callbacks.
Nothing here runs unless the game calls it: requiring the module opens no socket.
--]]

local witness = { PROTOCOL = 1, DEFAULT_ADDR = "127.0.0.1:7357", VERSION = "1.0" }

local floor, huge, char, byte, format = math.floor, math.huge, string.char, string.byte, string.format
local concat, sort = table.concat, table.sort
local unpack = unpack or table.unpack -- luacheck: ignore (5.1 global vs 5.2+ table.unpack)

-------------------------------------------------------------------------------- mode detection

local function has_flag(flag)
  local args = rawget(_G, "arg")
  if type(args) ~= "table" then return false end
  for _, a in pairs(args) do if a == flag then return true end end
  return false
end

--- True when the game should run in witness mode (WITNESS_ADDR set or --witness passed).
function witness.active()
  local addr = os.getenv("WITNESS_ADDR")
  return (addr ~= nil and addr ~= "") or has_flag("--witness")
end

--- True when a human plays normally and WITNESS_RECORD=<file.jsonl> asks for a replay.
function witness.recording()
  local f = os.getenv("WITNESS_RECORD")
  return f ~= nil and f ~= "" and not witness.active()
end

--- host, port the adapter connects to.
function witness.address()
  local addr = os.getenv("WITNESS_ADDR")
  if addr == nil or addr == "" then addr = witness.DEFAULT_ADDR end
  local host, port = addr:match("^(.*):(%d+)$")
  if not host then error("WITNESS_ADDR must look like 127.0.0.1:7357, got " .. addr, 2) end
  return (host ~= "" and host or "127.0.0.1"), tonumber(port)
end

-------------------------------------------------------------------------------- JSON

local ARRAY, OBJECT = { __jsontype = "array" }, { __jsontype = "object" }
--- Mark a table so it always encodes as a JSON array / object (matters for empty tables,
--- which otherwise encode as []).
function witness.array(t) return setmetatable(t or {}, ARRAY) end
function witness.object(t) return setmetatable(t or {}, OBJECT) end

local ESC = { ['"'] = '\\"', ["\\"] = "\\\\", ["\b"] = "\\b", ["\f"] = "\\f",
              ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
local function esc_str(s)
  return '"' .. s:gsub('[%c"\\]', function(c) return ESC[c] or format("\\u%04x", byte(c)) end) .. '"'
end

local function num(v)
  if v ~= v then return '"NaN"' end
  if v == huge then return '"Infinity"' end
  if v == -huge then return '"-Infinity"' end
  if v == floor(v) and v > -1e15 and v < 1e15 then return format("%d", v) end
  local s = format("%.14g", v)
  if tonumber(s) ~= v then s = format("%.17g", v) end
  return s
end

local encode
local function is_array(t)
  local mt = getmetatable(t)
  local kind = mt and mt.__jsontype
  if kind then return kind == "array" end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k ~= floor(k) then return false end
    n = n + 1
  end
  return n == #t -- also true for {} (empty tables encode as [])
end

local function key_str(k) return type(k) == "string" and k or tostring(k) end

encode = function(v, out, depth)
  local tv = type(v)
  if tv == "nil" then out[#out + 1] = "null"
  elseif tv == "boolean" then out[#out + 1] = v and "true" or "false"
  elseif tv == "number" then out[#out + 1] = num(v)
  elseif tv == "string" then out[#out + 1] = esc_str(v)
  elseif tv == "table" then
    if depth > 64 then out[#out + 1] = '"<max depth>"'; return end
    local mt = getmetatable(v)
    if mt and type(mt.__tojson) == "function" then return encode(mt.__tojson(v), out, depth + 1) end
    if is_array(v) then
      out[#out + 1] = "["
      for i = 1, #v do
        if i > 1 then out[#out + 1] = "," end
        encode(v[i], out, depth + 1)
      end
      out[#out + 1] = "]"
    else
      -- sorted keys: Lua's iteration order isn't stable, and snapshots must be byte-identical
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = key_str(k) end
      sort(keys)
      local lookup = {}
      for k, val in pairs(v) do lookup[key_str(k)] = val end
      out[#out + 1] = "{"
      for i, k in ipairs(keys) do
        if i > 1 then out[#out + 1] = "," end
        out[#out + 1] = esc_str(k)
        out[#out + 1] = ":"
        encode(lookup[k], out, depth + 1)
      end
      out[#out + 1] = "}"
    end
  else
    out[#out + 1] = esc_str(tostring(v)) -- functions, userdata, threads
  end
end

--- Encode a Lua value as one line of JSON (sorted keys, NaN as "NaN", empty tables as []).
function witness.encode(v)
  local out = {}
  encode(v, out, 0)
  return concat(out)
end

local function utf8char(cp)
  if cp < 0x80 then return char(cp) end
  if cp < 0x800 then return char(0xC0 + floor(cp / 64), 0x80 + cp % 64) end
  if cp < 0x10000 then return char(0xE0 + floor(cp / 4096), 0x80 + floor(cp / 64) % 64, 0x80 + cp % 64) end
  return char(0xF0 + floor(cp / 262144), 0x80 + floor(cp / 4096) % 64, 0x80 + floor(cp / 64) % 64, 0x80 + cp % 64)
end

local UNESC = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }

--- Decode one JSON document. Returns the value, or raises an error naming the position.
function witness.decode(s)
  local pos = 1
  local function fail(msg) error(format("bad JSON at %d: %s", pos, msg), 0) end
  local function ws() pos = s:find("[^ \t\r\n]", pos) or #s + 1 end
  local value
  local function str()
    local out, i = {}, pos + 1
    while true do
      local j = s:find('["\\]', i)
      if not j then fail("unterminated string") end
      out[#out + 1] = s:sub(i, j - 1)
      if s:sub(j, j) == '"' then pos = j + 1; return concat(out) end
      local c = s:sub(j + 1, j + 1)
      if c == "u" then
        local cp = tonumber(s:sub(j + 2, j + 5), 16) or fail("bad \\u escape")
        i = j + 6
        if cp >= 0xD800 and cp <= 0xDBFF and s:sub(i, i + 1) == "\\u" then
          local lo = tonumber(s:sub(i + 2, i + 5), 16)
          if lo and lo >= 0xDC00 and lo <= 0xDFFF then
            cp = 0x10000 + (cp - 0xD800) * 1024 + (lo - 0xDC00)
            i = i + 6
          end
        end
        out[#out + 1] = utf8char(cp)
      else
        out[#out + 1] = UNESC[c] or fail("bad escape \\" .. c)
        i = j + 2
      end
    end
  end
  value = function()
    ws()
    local c = s:sub(pos, pos)
    if c == "{" then
      local t = {}
      pos = pos + 1; ws()
      if s:sub(pos, pos) == "}" then pos = pos + 1; return setmetatable(t, OBJECT) end
      while true do
        ws()
        if s:sub(pos, pos) ~= '"' then fail("expected a key") end
        local k = str()
        ws()
        if s:sub(pos, pos) ~= ":" then fail("expected ':'") end
        pos = pos + 1
        t[k] = value()
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "}" then return t end
        if d ~= "," then fail("expected ',' or '}'") end
      end
    elseif c == "[" then
      local t, n = {}, 0
      pos = pos + 1; ws()
      if s:sub(pos, pos) == "]" then pos = pos + 1; return setmetatable(t, ARRAY) end
      while true do
        n = n + 1
        t[n] = value()
        ws()
        local d = s:sub(pos, pos)
        pos = pos + 1
        if d == "]" then return setmetatable(t, ARRAY) end
        if d ~= "," then fail("expected ',' or ']'") end
      end
    elseif c == '"' then return str()
    elseif s:sub(pos, pos + 3) == "true" then pos = pos + 4; return true
    elseif s:sub(pos, pos + 4) == "false" then pos = pos + 5; return false
    elseif s:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil
    else
      local numstr = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
      local n = numstr and tonumber(numstr)
      if not n then fail("unexpected '" .. c .. "'") end
      pos = pos + #numstr
      return n
    end
  end
  local v = value()
  ws()
  if pos <= #s then fail("trailing characters") end
  return v
end

-------------------------------------------------------------------------------- base64

local B64 = {}
do
  local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for i = 0, 63 do B64[i] = alphabet:sub(i + 1, i + 1) end
end

local function base64_pure(data)
  local out, n, len = {}, 0, #data
  for i = 1, len - 2, 3 do
    local a, b, c = byte(data, i, i + 2)
    local v = a * 65536 + b * 256 + c
    n = n + 1
    out[n] = B64[floor(v / 262144)] .. B64[floor(v / 4096) % 64] .. B64[floor(v / 64) % 64] .. B64[v % 64]
  end
  local rest = len % 3
  if rest == 1 then
    local v = byte(data, len) * 65536
    out[n + 1] = B64[floor(v / 262144)] .. B64[floor(v / 4096) % 64] .. "=="
  elseif rest == 2 then
    local a, b = byte(data, len - 1, len)
    local v = a * 65536 + b * 256
    out[n + 1] = B64[floor(v / 262144)] .. B64[floor(v / 4096) % 64] .. B64[floor(v / 64) % 64] .. "="
  end
  return concat(out)
end

--- Base64-encode a string (uses love.data.encode when running inside LÖVE 11).
function witness.base64(data)
  local love = rawget(_G, "love")
  if love and love.data and love.data.encode then return love.data.encode("string", "base64", data) end
  return base64_pure(data)
end

-------------------------------------------------------------------------------- audio capture

local Capture = {}
Capture.__index = Capture

--- A float PCM buffer that advances with simulated time. The game mixes every sound it would
--- play into it with :play(samples) at the current simulated time; the adapter calls
--- :advance(dt) after each frame, and the `audio` command returns exactly the samples between
--- the previous call and now (as s16). Tails past "now" come out on the next call.
function witness.capture(sample_rate, channels)
  local self = setmetatable({ sample_rate = sample_rate or 22050, channels = channels or 1 }, Capture)
  if self.channels ~= 1 and self.channels ~= 2 then error("witness.capture: 1 or 2 channels", 2) end
  self:reset()
  return self
end

function Capture:reset()
  self.buf, self.len = {}, 0   -- interleaved floats from absolute frame self.base
  self.base, self.time, self.cursor = 0, 0, 0
end

--- Mix interleaved float samples (-1..1, this capture's channel count) starting now
--- (+ offset seconds). `samples` is a Lua array.
function Capture:play(samples, gain, offset)
  gain = gain or 1
  local ch = self.channels
  local start = (self.cursor + floor((offset or 0) * self.sample_rate + 0.5) - self.base) * ch
  local buf, len = self.buf, self.len
  local skip = start < 0 and -start or 0
  for i = 1 + skip, #samples do
    local j = start + i
    if j > len then
      for z = len + 1, j - 1 do buf[z] = 0 end
      buf[j] = samples[i] * gain
      len = j
    else
      buf[j] = buf[j] + samples[i] * gain
    end
  end
  self.len = len
end

--- Move "now" forward by dt simulated seconds (rounded on the absolute clock: no drift).
function Capture:advance(dt)
  self.time = self.time + dt
  self.cursor = floor(self.time * self.sample_rate + 0.5)
  local want = (self.cursor - self.base) * self.channels
  local buf = self.buf
  for i = self.len + 1, want do buf[i] = 0 end
  if want > self.len then self.len = want end
end

local function s16_bytes(buf, first, last)
  local parts, bytes, n = {}, {}, 0
  for i = first, last do
    local s = buf[i]
    if s > 1 then s = 1 elseif s < -1 then s = -1 end
    local v = floor(s * 32767 + 0.5)
    if v < 0 then v = v + 65536 end
    bytes[n + 1] = v % 256
    bytes[n + 2] = floor(v / 256)
    n = n + 2
    if n >= 4096 then parts[#parts + 1] = char(unpack(bytes, 1, n)); n = 0 end
  end
  if n > 0 then parts[#parts + 1] = char(unpack(bytes, 1, n)) end
  return concat(parts)
end

--- The `audio` command result: everything mixed since the previous take, as s16 PCM.
function Capture:take()
  local n = (self.cursor - self.base) * self.channels
  local data = n > 0 and s16_bytes(self.buf, 1, n) or ""
  local rest, len = {}, 0
  for i = n + 1, self.len do len = len + 1; rest[len] = self.buf[i] end
  self.buf, self.len, self.base = rest, len, self.cursor
  return { sampleRate = self.sample_rate, channels = self.channels, format = "s16",
           data = witness.base64(data) }
end

-------------------------------------------------------------------------------- adapter state

local A = {
  seed = nil, frame = 0, time = 0, queue = {}, due = {}, down = {}, logs = {},
  connected = false, perf = { frame_ms = 0, update_ms = 0, render_ms = 0 }, recorder = nil,
}

local clock = os.clock
do -- prefer a wall clock with sub-ms resolution for perf numbers
  local ok, socket = pcall(require, "socket")
  if ok and socket and socket.gettime then clock = socket.gettime end
end

--- Send a log line ("info" | "warn" | "error"); errors fail Witness tests. No-op when not connected.
function witness.log(level, message)
  if not A.connected then return end
  if level == "warning" then level = "warn" end
  if level ~= "warn" and level ~= "error" then level = "info" end
  local logs = A.logs
  logs[#logs + 1] = { frame = A.frame, level = level, message = tostring(message) }
  if #logs > 10000 then table.remove(logs, 1) end
end
function witness.info(m) witness.log("info", m) end
function witness.warn(m) witness.log("warn", m) end
function witness.error(m) witness.log("error", m) end

--- The seed for the game's RNG: from the last reset, or the replay header when recording.
function witness.seed()
  if A.seed then return A.seed end
  if witness.recording() then return witness.start_recording().seed end
  return 1
end

function witness.frame() return A.frame end
--- True while connected to the CLI (inside witness.run).
function witness.connected() return A.connected end
function witness.time() return A.time end
--- Events applied at the current frame (for games that pull input instead of an input handler).
function witness.input_events() return A.due end
--- Whether a Witness key name ("right", "space", ...) is held, from injected key events.
function witness.is_down(key) return A.down[key] == true end

-------------------------------------------------------------------------------- transport

local function connect(hello)
  local ok, socket = pcall(require, "socket")
  if not ok then error("witness: LuaSocket is required (require 'socket' failed: " .. tostring(socket) .. ")", 0) end
  local host, port = witness.address()
  local sock, err
  for attempt = 1, 20 do
    sock, err = socket.connect(host, port)
    if sock then break end
    if socket.sleep then socket.sleep(math.min(0.05 * attempt, 0.5)) end
  end
  if not sock then error(format("witness: could not reach the Witness CLI at %s:%d (%s)", host, port, tostring(err)), 0) end
  sock:settimeout(nil)
  pcall(sock.setoption, sock, "tcp-nodelay", true)
  A.sock, A.connected = sock, true
  witness.send({ hello = hello })
end

--- Send one protocol object (used for replies; games rarely need it).
function witness.send(obj)
  local line = witness.encode(obj) .. "\n"
  local i = 1
  while i <= #line do
    local last, err, partial = A.sock:send(line, i)
    if last then i = last + 1
    elseif partial and partial >= i then i = partial + 1
    else error("witness: send failed: " .. tostring(err), 0) end
  end
end

local function close()
  if A.sock then pcall(A.sock.close, A.sock) end
  A.sock, A.connected = nil, false
end

-------------------------------------------------------------------------------- commands

local function args_of(fn)
  if not debug or not debug.getinfo then return nil end
  local ok, info = pcall(debug.getinfo, fn, "u")
  if not ok or not info or not info.nparams or not debug.getlocal then return nil end -- 5.1: unknown
  local names = {}
  for i = 1, info.nparams do
    local okl, name = pcall(debug.getlocal, fn, i)
    if not okl or not name then return nil end
    names[i] = name
  end
  return #names > 0 and concat(names, " ") or nil
end

local function step_once(h, dt)
  local f, queue, keep, due = A.frame, A.queue, {}, {}
  for i = 1, #queue do
    local e = queue[i]
    if (e.frame or 0) <= f then due[#due + 1] = e else keep[#keep + 1] = e end
  end
  A.queue, A.due = keep, due
  for i = 1, #due do
    local e = due[i]
    if e.type == "key" and e.key then A.down[e.key] = e.down and true or nil end
    if h.input then h.input(e) end
  end
  if h.update then h.update(dt) end
  if h.audio and h.audio.advance then h.audio:advance(dt) end
  A.frame, A.time = f + 1, A.time + dt
end

local function merge(dst, src)
  if type(src) == "table" then for k, v in pairs(src) do dst[k] = v end end
  return dst
end

local commands = {}

function commands.reset(h, m)
  A.seed = floor(tonumber(m.seed) or 1)
  A.frame, A.time, A.queue, A.due, A.down, A.logs = 0, 0, {}, {}, {}, {}
  if h.audio and h.audio.reset then h.audio:reset() end
  if h.reset then h.reset(A.seed, m.scene, m.params or {}) end
  return {}
end

function commands.input(h, m)
  local q = A.queue
  for _, e in ipairs(m.events or {}) do q[#q + 1] = e end
  return {}
end

function commands.step(h, m)
  local frames = floor(tonumber(m.frames) or 1)
  if frames < 1 then error("step needs frames >= 1", 0) end
  local dt, dts = tonumber(m.dt) or 1 / h.fps, m.dts
  local t0 = clock()
  for i = 1, frames do step_once(h, (dts and tonumber(dts[i])) or dt) end
  A.perf.update_ms = (clock() - t0) * 1000 / frames
  A.perf.frame_ms = A.perf.update_ms
  return { frame = A.frame, time = A.time }
end

function commands.snapshot(h, m)
  return { frame = A.frame, time = A.time, state = h.snapshot(m.paths) }
end

function commands.screenshot(h, m)
  local t0 = clock()
  local w, hgt, data = h.screenshot(m.scale)
  A.perf.render_ms = (clock() - t0) * 1000
  if type(w) == "table" then return w end
  if #data ~= w * hgt * 4 then
    error(format("screenshot returned %d bytes, expected %dx%dx4 = %d", #data, w, hgt, w * hgt * 4), 0)
  end
  return { width = w, height = hgt, format = "rgba8", data = witness.base64(data) }
end

function commands.audio(h)
  if type(h.audio) == "function" then return h.audio() end
  return h.audio:take()
end

function commands.call(h, m)
  local fn = h.calls[m.name]
  if not fn then
    local known = {}
    for k in pairs(h.calls) do known[#known + 1] = k end
    sort(known)
    error(format("unknown call '%s' (known: %s)", tostring(m.name), #known > 0 and concat(known, ", ") or "none"), 0)
  end
  local args = m.args or {}
  return { result = fn(unpack(args, 1, #args)) }
end

local function pack(...) return { n = select("#", ...), ... } end

local load_with_env
if setfenv then -- Lua 5.1 / LuaJIT
  load_with_env = function(src, env)
    local fn, err = loadstring(src, "=witness eval")
    if fn then setfenv(fn, env) end
    return fn, err
  end
else
  load_with_env = function(src, env) return load(src, "=witness eval", "t", env) end
end

function commands.eval(h, m)
  local env = type(h.env) == "function" and h.env() or h.env or _G
  local expr = tostring(m.expr or "")
  local fn = load_with_env("return " .. expr, env)
  if not fn then -- not an expression: run it as statements, return null
    local err
    fn, err = load_with_env(expr, env)
    if not fn then error(err, 0) end
  end
  local results = pack(fn())
  if results.n <= 1 then return { value = results[1] } end
  results.n = nil
  return { value = witness.array(results) } -- several return values: a JSON array
end

function commands.logs()
  local logs = A.logs
  A.logs = {}
  return { logs = witness.array(logs) }
end

function commands.perf(h)
  local out = {}
  for k, v in pairs(A.perf) do out[k] = floor(v * 10000 + 0.5) / 10000 end
  if h.perf then merge(out, h.perf()) end
  return out
end

local function traceback(err)
  local tb = debug and debug.traceback and debug.traceback("", 2) or ""
  -- keep only the game's frames: everything above the first adapter frame
  local lines = {}
  for line in tb:gmatch("[^\n]+") do
    if line:find("witness.lua", 1, true) then break end
    if not line:find("[C]:", 1, true) and not line:find("stack traceback", 1, true) and #lines < 8 then
      lines[#lines + 1] = line
    end
  end
  return tostring(err) .. (#lines > 0 and ("\n" .. concat(lines, "\n")) or "")
end

-------------------------------------------------------------------------------- run

--- Connect to the Witness CLI and serve commands until quit/disconnect, then return.
--- See the header comment for the handler table. `update` and `snapshot` are required.
function witness.run(h)
  assert(type(h) == "table", "witness.run expects a table of handlers")
  assert(h.update and h.snapshot, "witness.run needs at least update and snapshot handlers")
  assert(not A.connected, "witness.run is already serving")
  h.fps = h.fps or 60
  h.calls = h.calls or {}
  local caps = { "step", "input", "snapshot", "logs", "perf", "eval" }
  if h.reset then caps[#caps + 1] = "reset" end
  if h.screenshot then caps[#caps + 1] = "screenshot" end
  if h.audio then caps[#caps + 1] = "audio" end
  local calls = {}
  for name, fn in pairs(h.calls) do
    calls[#calls + 1] = { name = name, args = (h.call_args and h.call_args[name]) or args_of(fn),
                          help = h.call_help and h.call_help[name] or nil }
  end
  sort(calls, function(a, b) return a.name < b.name end)
  if #calls > 0 then caps[#caps + 1] = "call" end
  local available = {}
  for _, c in ipairs(caps) do available[c] = true end
  connect({ protocol = witness.PROTOCOL, name = h.name or "game", engine = h.engine or _VERSION,
            language = "lua", fps = h.fps, size = h.size, capabilities = caps,
            calls = witness.array(calls), keys = h.keys })

  while true do
    local line, err = A.sock:receive("*l")
    if not line then break end -- "closed": the CLI went away
    if line:sub(1, 2) == "@w" then line = line:sub(3) end
    if line:find("%S") then
      local okd, msg = pcall(witness.decode, line)
      if not okd or type(msg) ~= "table" then
        witness.log("error", "witness: unreadable command: " .. tostring(msg))
      else
        local id, cmd = msg.id, msg.cmd
        if cmd == "quit" then
          witness.send({ id = id, ok = true })
          break
        end
        local fn = commands[cmd]
        if not fn or (not available[cmd] and cmd ~= "logs") then
          witness.send({ id = id, ok = false, error = "unknown or unsupported command '" .. tostring(cmd) .. "'" })
        else
          local ok, result = xpcall(function() return fn(h, msg) end, traceback)
          if ok then
            witness.send(merge({ id = id, ok = true }, result))
          else
            witness.log("error", tostring(cmd) .. " failed: " .. tostring(result):match("[^\n]*"))
            witness.send({ id = id, ok = false, error = tostring(result) })
          end
        end
      end
    end
    if err then break end
  end
  close()
end

-------------------------------------------------------------------------------- recording (replays)

--- Open the WITNESS_RECORD replay (once) and return {seed=, path=}. No-op unless recording().
--- The seed comes from `seed`, else WITNESS_SEED, else the clock; seed your RNG with witness.seed().
function witness.start_recording(name, fps, seed)
  if not witness.recording() or A.record_failed then return { seed = A.seed or 1 } end
  if not A.recorder then
    local path = os.getenv("WITNESS_RECORD")
    seed = seed or tonumber(os.getenv("WITNESS_SEED") or "") or (os.time() % 1000000 + 1)
    local file, err = io.open(path, "w")
    local dir = path:match("^(.*)[/\\][^/\\]+$")
    if not file and dir then -- create the folder (pure Lua has no mkdir: use the shell once)
      if package.config:sub(1, 1) == "\\" then
        os.execute('mkdir "' .. dir:gsub("/", "\\") .. '" 2>nul')
      else
        os.execute("mkdir -p '" .. dir:gsub("'", "'\\''") .. "'")
      end
      file, err = io.open(path, "w")
    end
    if not file then -- never break normal play over a replay: warn once and keep going
      A.record_failed = true
      A.seed = seed
      io.stderr:write("[witness] can't write the replay " .. path .. ": " .. tostring(err) .. " (not recording)\n")
      return { seed = seed }
    end
    A.recorder = { file = file, f = 0, seed = seed, path = path }
    A.seed = seed
    file:write(witness.encode({ replay = 1, name = name or "game", seed = seed, fps = fps or 60,
                                started = os.date("!%Y-%m-%dT%H:%M:%SZ") }), "\n")
    file:flush()
  end
  return { seed = A.recorder.seed, path = A.recorder.path }
end

--- Append one replay line for a frame of normal play: its dt and its input events (protocol
--- shapes, without `frame`). Call once per frame. Does nothing unless recording().
function witness.record_frame(dt, events)
  local r = A.recorder
  if not r then
    if not witness.recording() or A.record_failed then return end
    witness.start_recording()
    r = A.recorder
    if not r then return end
  end
  local line = { f = r.f, dt = dt } -- full precision: replays must be exact
  if events and #events > 0 then line["in"] = witness.array(events) end
  if r.mark then line.mark, r.mark = r.mark, nil end
  r.file:write(witness.encode(line), "\n")
  r.f = r.f + 1
  if r.f % 60 == 0 then r.file:flush() end
end

--- Flag the current moment in the replay (bind it to F8). Does nothing unless recording.
function witness.mark(label)
  if A.recorder then A.recorder.mark = tostring(label or "F8") end
end

--- Flush and close the replay file (call on quit; also safe to skip, lines are flushed often).
function witness.stop_recording()
  if A.recorder then A.recorder.file:close(); A.recorder = nil end
end

return witness
