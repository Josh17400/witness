-- Coins: the standard Witness sample game for LÖVE 11.
--   love .                     play (arrows/WASD; F8 marks a replay moment)
--   love . --demo              a scripted 2 s real-time session (records with WITNESS_RECORD)
--   witness doctor / test      drive it through the Witness adapter (see README.md)

-- Inside the Witness repo the adapter lives in adapters/lua/. A real game keeps witness.lua
-- and witness_love.lua next to main.lua, where LÖVE's own loader finds them first.
package.path = love.filesystem.getSource() .. "/../../adapters/lua/?.lua;" .. package.path
local witness = require("witness")
local wl = require("witness_love")

local W, H, SPEED, RATE = 320, 180, 120, 22050
local player, coins, score, scale
local mixer = wl.newMixer(RATE, 1)
local ding

local function make_ding()
  local n = math.floor(RATE * 0.15)
  local sd = love.sound.newSoundData(n, RATE, 16, 1)
  for i = 0, n - 1 do
    sd:setSample(i, math.sin(2 * math.pi * 880 * i / RATE) * 0.5 * math.exp(-i / (RATE * 0.04)))
  end
  return sd
end

local function reset(seed)
  score = 0
  player = { id = 1, type = "Player", pos = { 40, 90 }, hp = 3 }
  coins = {}
  for i = 0, 4 do
    coins[#coins + 1] = { id = 10 + i, type = "Coin",
                          pos = { 80 + 40 * i, i == 0 and 90 or 60 + (seed * 7 + i * 13) % 61 } }
  end
end

-- `--demo`: normal (real-time) play driven by a scripted "player" that holds right from 0 s
-- to 1.2 s and presses F8 at 0.5 s. Its key presses go through LÖVE's event queue, so the
-- replay recorder sees them exactly like a human's; isDown reports what the bot holds.
local demo
for _, a in ipairs(arg or {}) do
  if a == "--demo" and not witness.active() then demo = { t = 0, held = {}, step = 0 } end
end
if demo then
  local real_is_down = love.keyboard.isDown
  love.keyboard.isDown = function(...)
    for i = 1, select("#", ...) do if demo.held[select(i, ...)] then return true end end
    return real_is_down(...)
  end
end

local function demo_update(dt)
  local script = { { 0, "keypressed", "right" }, { 0.5, "keypressed", "f8" }, { 1.2, "keyreleased", "right" } }
  local next_action = script[demo.step + 1]
  if next_action and demo.t >= next_action[1] then
    demo.step = demo.step + 1
    love.event.push(next_action[2], next_action[3], next_action[3], false)
  end
  demo.t = demo.t + dt
  if demo.t >= 2 and not demo.done then
    demo.done = true
    print(string.format("demo finished: t=%.3fs seed=%d score=%d player=(%.4f, %.4f) coins=%d",
      demo.t, witness.seed(), score, player.pos[1], player.pos[2], #coins))
    love.event.quit()
  end
end

function love.load()
  ding = ding or make_ding()
  scale = love.graphics.getWidth() / W
  reset((witness.recording() or demo) and witness.seed() or love.math.random(1, 999))
end

local function axis(neg1, neg2, pos1, pos2)
  local kb = love.keyboard
  return ((kb.isDown(pos1) or kb.isDown(pos2)) and 1 or 0) - ((kb.isDown(neg1) or kb.isDown(neg2)) and 1 or 0)
end

function love.update(dt)
  if demo then demo_update(dt) end
  local dx, dy = axis("left", "a", "right", "d"), axis("up", "w", "down", "s")
  local p = player.pos
  p[1] = math.max(0, math.min(W, p[1] + dx * SPEED * dt))
  p[2] = math.max(0, math.min(H, p[2] + dy * SPEED * dt))
  for i = #coins, 1, -1 do
    local c = coins[i]
    if math.sqrt((c.pos[1] - p[1]) ^ 2 + (c.pos[2] - p[2]) ^ 2) < 12 then
      table.remove(coins, i)
      score = score + 1
      witness.info("coin " .. c.id .. " collected")
      mixer:play(ding)
    end
  end
  mixer:update()
end

function love.draw()
  love.graphics.push()
  love.graphics.scale(scale)
  love.graphics.clear(20 / 255, 24 / 255, 40 / 255)
  love.graphics.setColor(1, 210 / 255, 60 / 255)
  for _, c in ipairs(coins) do love.graphics.circle("fill", c.pos[1], c.pos[2], 5) end
  love.graphics.setColor(80 / 255, 200 / 255, 1)
  love.graphics.circle("fill", player.pos[1], player.pos[2], 7)
  love.graphics.pop()
  if not witness.active() then
    love.graphics.setColor(1, 1, 1)
    love.graphics.print("score " .. score .. (witness.recording() and "   REC" or ""), 8, 8)
  end
end

function love.keypressed(key)
  if demo then demo.held[key] = true end
  if key == "escape" and not witness.active() then love.event.quit() end
end

function love.keyreleased(key)
  if demo then demo.held[key] = nil end
end

wl.setup{
  name = "Coins (LÖVE)", size = { W, H }, fps = 60,
  keys = { "left", "right", "up", "down", "w", "a", "s", "d" },
  reset = reset,
  snapshot = function()
    local entities = { player }
    for _, c in ipairs(coins) do entities[#entities + 1] = c end
    return { score = score, scene = "level1", player = player, entities = entities }
  end,
  calls = {
    teleport = function(x, y) player.pos = { tonumber(x), tonumber(y) }; return player.pos end,
    addcoin = function(x, y)
      coins[#coins + 1] = { id = 100 + #coins, type = "Coin", pos = { tonumber(x), tonumber(y) } }
      return #coins
    end,
  },
  call_help = { teleport = "move the player", addcoin = "add a coin, returns the coin count" },
  audio = mixer,
  env = function() return setmetatable({ player = player, coins = coins, score = score }, { __index = _G }) end,
}
