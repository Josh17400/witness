-- Coins in plain Lua (5.1 / LuaJIT / 5.2-5.4 + LuaSocket): witness.lua without any engine.
--   lua coins.lua            run under Witness (witness doctor / test from this folder)
-- It is witness-only: plain Lua has no window, so the frame is rasterized in software.

local here = (debug.getinfo(1, "S").source:match("^@(.*[/\\])") or "./")
package.path = here .. "../../../adapters/lua/?.lua;" .. here .. "?.lua;" .. package.path
local witness = require("witness")

local W, H, SPEED, RATE = 320, 180, 120, 22050
local player, coins, score, keys
local capture = witness.capture(RATE, 1)

local ding = {}
for i = 0, math.floor(RATE * 0.15) - 1 do
  ding[i + 1] = math.sin(2 * math.pi * 880 * i / RATE) * 0.5 * math.exp(-i / (RATE * 0.04))
end

local function reset(seed)
  score, keys = 0, {}
  player = { id = 1, type = "Player", pos = { 40, 90 }, hp = 3 }
  coins = {}
  for i = 0, 4 do
    coins[#coins + 1] = { id = 10 + i, type = "Coin",
                          pos = { 80 + 40 * i, i == 0 and 90 or 60 + (seed * 7 + i * 13) % 61 } }
  end
end

local function held(a, b) return (keys[a] or keys[b]) and 1 or 0 end

local function update(dt)
  local p = player.pos
  p[1] = math.max(0, math.min(W, p[1] + (held("right", "d") - held("left", "a")) * SPEED * dt))
  p[2] = math.max(0, math.min(H, p[2] + (held("down", "s") - held("up", "w")) * SPEED * dt))
  for i = #coins, 1, -1 do
    local c = coins[i]
    if math.sqrt((c.pos[1] - p[1]) ^ 2 + (c.pos[2] - p[2]) ^ 2) < 12 then
      table.remove(coins, i)
      score = score + 1
      witness.info("coin " .. c.id .. " collected")
      capture:play(ding)
    end
  end
end

local function render()
  local bg, rows = string.char(20, 24, 40, 255), {}
  local blobs = {}
  for _, c in ipairs(coins) do blobs[#blobs + 1] = { c.pos, 5, string.char(255, 210, 60, 255) } end
  blobs[#blobs + 1] = { player.pos, 7, string.char(80, 200, 255, 255) }
  for y = 0, H - 1 do
    local row = nil
    for _, b in ipairs(blobs) do
      local cx, cy, r = math.floor(b[1][1] + 0.5), math.floor(b[1][2] + 0.5), b[2]
      local dy = y - cy
      if dy >= -r and dy <= r then
        row = row or {}
        local half = math.floor(math.sqrt(r * r - dy * dy))
        for x = math.max(0, cx - half), math.min(W - 1, cx + half) do row[x] = b[3] end
      end
    end
    if row then
      local px = {}
      for x = 0, W - 1 do px[x + 1] = row[x] or bg end
      rows[y + 1] = table.concat(px)
    else
      rows[y + 1] = bg:rep(W)
    end
  end
  return W, H, table.concat(rows)
end

reset(1)
if not witness.active() then
  print("coins.lua is witness-only: run it with `witness doctor` / `witness test` from this folder")
  os.exit(0)
end
witness.run{
  name = "Coins (plain Lua)", fps = 60, size = { W, H }, engine = _VERSION .. (jit and (" / " .. jit.version) or ""),
  reset = reset,
  input = function(ev) if ev.type == "key" then keys[ev.key] = ev.down or nil end end,
  update = update,
  snapshot = function()
    local entities = { player }
    for _, c in ipairs(coins) do entities[#entities + 1] = c end
    return { score = score, scene = "level1", player = player, entities = entities }
  end,
  screenshot = render,
  audio = capture,
  calls = {
    teleport = function(x, y) player.pos = { tonumber(x), tonumber(y) }; return player.pos end,
    addcoin = function(x, y)
      coins[#coins + 1] = { id = 100 + #coins, type = "Coin", pos = { tonumber(x), tonumber(y) } }
      return #coins
    end,
  },
  call_help = { teleport = "move the player", addcoin = "add a coin, returns the coin count" },
  env = function() return setmetatable({ player = player, coins = coins, score = score }, { __index = _G }) end,
}
