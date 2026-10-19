-- Unit tests for witness.lua's pure-Lua pieces (JSON, base64, audio capture, recording).
--   lua tests/test_witness.lua      (from adapters/lua; any of Lua 5.1-5.4 / LuaJIT, no LuaSocket needed)
local here = (debug.getinfo(1, "S").source:match("^@(.*[/\\])") or "./")
package.path = here .. "../?.lua;" .. package.path
local w = require("witness")

local fails, count = 0, 0
local function eq(got, want, what)
  count = count + 1
  if got ~= want then
    fails = fails + 1
    print("FAIL " .. what .. ": got " .. tostring(got) .. ", want " .. tostring(want))
  end
end

-- JSON encode: sorted keys, arrays, escapes, NaN/inf, empty tables, integers vs floats
eq(w.encode({ b = 1, a = { 1, 2.5, "x\n\"y" }, c = {}, d = 0 / 0, e = 1 / 0, f = true }),
   '{"a":[1,2.5,"x\\n\\"y"],"b":1,"c":[],"d":"NaN","e":"Infinity","f":true}', "encode object")
eq(w.encode(w.object({})), "{}", "empty object marker")
eq(w.encode(0.1), "0.1", "short float")
eq(w.encode(1 / 3), "0.33333333333333331", "round-trip float")
eq(w.encode(-7), "-7", "integer")
eq(w.encode("\1"), '"\\u0001"', "control char")
eq(tonumber(w.encode(2 / 3)), 2 / 3, "float round-trips exactly")

-- JSON decode
local d = w.decode('{"id":3,"cmd":"input","events":[{"frame":0,"type":"key","key":"right","down":true}],' ..
                   '"s":"a\\u00e9\\ud83d\\ude00\\n","n":-1.5e2,"z":null,"e":[]}')
eq(d.id, 3, "number")
eq(d.events[1].key, "right", "nested")
eq(d.events[1].down, true, "boolean")
eq(d.s, "a\195\169\240\159\152\128\n", "unicode escapes and surrogate pairs")
eq(d.n, -150, "exponent")
eq(d.z, nil, "null")
eq(w.encode(d.e), "[]", "decoded empty array stays an array")
eq(w.encode(w.decode("{}")), "{}", "decoded empty object stays an object")
eq(pcall(w.decode, '{"a":}'), false, "malformed JSON raises")
eq(pcall(w.decode, '[1] x'), false, "trailing characters raise")

-- base64 (RFC 4648 vectors) through the pure-Lua path
local saved_love = rawget(_G, "love")
rawset(_G, "love", nil)
for input, want in pairs({ [""] = "", f = "Zg==", fo = "Zm8=", foo = "Zm9v", foob = "Zm9vYg==",
                           fooba = "Zm9vYmE=", foobar = "Zm9vYmFy" }) do
  eq(w.base64(input), want, "base64 " .. input)
end
eq(w.base64("\0\255\128"), "AP+A", "base64 binary")
rawset(_G, "love", saved_love)

-- audio capture: synced with simulated time, tails carry over, s16 little-endian
local c = w.capture(100, 1)
c:advance(0.05)
c:play({ 1, 1, 1, 1, 1, 1, 1, 1, 1, 1 })
c:advance(0.05)
local function decode64(s) -- tiny decoder for the test
  local map, out, bits, n = {}, {}, 0, 0
  local alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for i = 1, 64 do map[alphabet:sub(i, i)] = i - 1 end
  for ch in s:gmatch("[^=]") do
    bits, n = bits * 64 + map[ch], n + 6
    if n >= 8 then
      n = n - 8
      local byte = math.floor(bits / 2 ^ n)
      out[#out + 1] = string.char(byte)
      bits = bits - byte * 2 ^ n
    end
  end
  return table.concat(out)
end
local first = c:take()
eq(first.format, "s16", "capture format")
local raw = decode64(first.data)
eq(#raw, 20, "0.1 s at 100 Hz = 10 frames")
eq(raw:byte(1), 0, "silence before the sound")
eq(raw:byte(11) + raw:byte(12) * 256, 32767, "sound starts at frame 5 (full scale)")
c:advance(0.1)
raw = decode64(c:take().data)
eq(#raw, 20, "next 10 frames")
eq(raw:byte(9) + raw:byte(10) * 256, 32767, "the tail carried over")
eq(raw:byte(11), 0, "then silence")
c:reset()
eq(#decode64(c:take().data), 0, "reset empties the capture")

-- touch: normalized, delivered, finger 0 also arrives as a mouse event (unless the game opts out)
local got = {}
local h = { fps = 60, update = function() end, input = function(e) got[#got + 1] = e end }
local cmds = w._commands
cmds.reset(h, { seed = 1 })
cmds.input(h, { events = w.decode('[{"frame":0,"type":"touch","id":0,"x":40,"y":90,"phase":"down"},' ..
  '{"frame":1,"type":"touch","x":50.5,"y":91,"pressure":0.5},' ..
  '{"frame":1,"type":"touch","id":1,"x":7,"y":8,"phase":"down"},' ..
  '{"frame":2,"type":"touch","id":0,"x":60,"y":92,"phase":"up"}]') })
cmds.step(h, { frames = 2 })
eq(#got, 5, "touch + fallback events delivered by frame 1")
eq(got[1].type .. got[1].id .. got[1].phase .. got[1].pressure, "touch0down1", "touch down normalized (pressure 1)")
eq(got[2].type, "mouse", "finger 0 is followed by a mouse event")
eq(tostring(got[2].from_touch) .. got[2].button .. tostring(got[2].down) .. got[2].x, "true0true40", "fallback: button 0 down at x,y")
eq(got[3].id .. got[3].phase .. got[3].pressure, "0move0.5", "missing id/phase -> finger 0, move")
eq(got[4].type .. tostring(got[4].down) .. tostring(got[4].button), "mousenilnil", "fallback move: no button")
eq(got[5].type .. got[5].id, "touch1", "finger 1 gets no mouse event")
eq(#w.input_events(), 3, "pull-style frame events include the fallback")
local tx, ty, tp = w.touch(0)
eq(tostring(tx) .. "," .. tostring(ty) .. "," .. tostring(tp), "50.5,91,0.5", "touch(0) while down")
eq(w.touch(1) ~= nil, true, "touch(1) while down")
local mx, my = w.mouse()
eq(mx .. "," .. my .. "," .. tostring(w.mouse_down(0)), "50.5,91,true", "the mouse follows finger 0")
cmds.step(h, { frames = 1 })
eq(got[7].type .. tostring(got[7].down) .. got[7].button, "mousefalse0", "fallback: button 0 up")
eq(w.touch(0), nil, "touch(0) after up")
eq(w.mouse_down(0), false, "mouse button released")
cmds.reset(h, { seed = 1 })
eq(w.touch(1), nil, "reset clears touches")
got = {}
h.touch = true -- the game handles touch itself
cmds.input(h, { events = w.decode('[{"frame":0,"type":"touch","id":0,"x":1,"y":2,"phase":"down"}]') })
cmds.step(h, { frames = 1 })
eq(#got, 1, "touch = true: no mouse fallback")
local expanded = w.expand_input(w.decode('[{"type":"touch","id":0,"x":1,"y":2,"phase":"up"}]'), false)
eq(#expanded .. expanded[2].type .. tostring(expanded[2].down), "2mousefalse", "expand_input fallback")

-- cancel: the system ended the touch. It ends the finger like up (and finger 0's mouse button)
got = {}
h.touch = nil
cmds.reset(h, { seed = 1 })
cmds.input(h, { events = w.decode('[{"frame":0,"type":"touch","id":0,"x":5,"y":6,"phase":"down"},' ..
  '{"frame":0,"type":"touch","id":0,"x":5,"y":6,"phase":"cancel"}]') })
cmds.step(h, { frames = 1 })
eq(#got, 4, "down + cancel, each with its mouse fallback")
eq(got[3].type .. got[3].phase, "touchcancel", "cancel delivered as cancel")
eq(got[4].type .. tostring(got[4].down) .. got[4].button, "mousefalse0", "fallback: cancel -> button 0 up")
eq(w.touch(0), nil, "touch(0) after cancel")
eq(w.mouse_down(0), false, "mouse button released after cancel")
local unknown = w.expand_input(w.decode('[{"type":"touch","id":3,"x":1,"y":2,"phase":"lift"}]'), false)
eq(unknown[1].phase, "move", "unknown phase -> move")

-- recording: touch shape, pressure only when not 1, synthesized mouse events skipped
local rec_path = here .. "touch_record_test.jsonl"
local real_getenv = os.getenv
os.getenv = function(k) if k == "WITNESS_RECORD" then return rec_path end return real_getenv(k) end -- luacheck: ignore
w.start_recording("touch-test", 60, 5)
w.record_touch(0, 10, 20, "down")
w.record_event({ type = "mouse", x = 10, y = 20, button = 0, down = true, from_touch = true })
w.record_frame(1 / 60)
w.record_touch(1, 3, 4, "down", 0.25)
w.record_key("f8", true)
w.record_frame(1 / 60, { { type = "touch", id = 0, x = 15.5, y = 22, phase = "up", pressure = 1 },
                         { type = "mouse", x = 15.5, y = 22, istouch = true }, { type = "key", key = "space", down = true } })
w.record_touch(1, 3, 4, "cancel")
w.record_frame(1 / 60)
w.stop_recording()
os.getenv = real_getenv -- luacheck: ignore
local lines = {}
local fh = io.open(rec_path, "r")
for l in fh:lines() do lines[#lines + 1] = l end
fh:close()
os.remove(rec_path)
eq(#lines, 4, "header + 3 frames")
eq(lines[2], '{"dt":0.016666666666666666,"f":0,"in":[{"id":0,"phase":"down","type":"touch","x":10,"y":20}]}', "touch recorded, fallback mouse skipped")
eq(lines[3], '{"dt":0.016666666666666666,"f":1,"in":[{"id":1,"phase":"down","pressure":0.25,"type":"touch","x":3,"y":4},' ..
   '{"id":0,"phase":"up","type":"touch","x":15.5,"y":22},{"down":true,"key":"space","type":"key"}],"mark":"F8"}', "pressure kept when not 1, istouch mouse skipped, f8 marks")
eq(lines[4], '{"dt":0.016666666666666666,"f":2,"in":[{"id":1,"phase":"cancel","type":"touch","x":3,"y":4}]}', "cancel recorded as cancel")

-- sound events: no-op while disconnected; once connected, one line at once, stamped with the frame being simulated
local sent = {}
local fake = { send = function(_, data, i) sent[#sent + 1] = data:sub(i or 1); return #data end }
w.sound("ignored")
eq(#sent, 0, "sound: nothing sent while disconnected")
w._attach(fake)
local sh = { fps = 60, update = function() if w.frame() == 2 then w.sound("coin", 0.5, 10, 20) end end }
cmds.reset(sh, { seed = 1 })
cmds.step(sh, { frames = 4 })
eq(sent[1], '{"event":"sound","frame":2,"name":"coin","pos":[10,20],"volume":0.5}\n', "sound inside step: frame 2")
eq(#sent, 1, "one line per sound (step replies are sent by run, not here)")
w.sound("jump", 2, 0 / 0, 1)
eq(sent[2], '{"event":"sound","frame":4,"name":"jump","volume":1}\n', "between steps: current frame, volume clamped, NaN pos dropped")
w.sound("hit", 0 / 0, 3, 1 / 0)
eq(sent[3], '{"event":"sound","frame":4,"name":"hit"}\n', "NaN volume and infinite pos dropped")
w.sound("")
eq(#sent, 3, "empty name ignored")
fake.send = function() return nil, "closed" end
eq(pcall(w.sound, "lost"), true, "a dead socket doesn't raise")
w._attach(nil)
cmds.reset(sh, { seed = 1 })

print(string.format("%s: %d checks, %d failed", fails == 0 and "OK" or "FAILED", count, fails))
if fails > 0 then os.exit(1) end
