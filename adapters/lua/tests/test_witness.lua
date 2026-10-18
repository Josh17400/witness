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

print(string.format("%s: %d checks, %d failed", fails == 0 and "OK" or "FAILED", count, fails))
if fails > 0 then os.exit(1) end
