--[[
Witness for LÖVE 11.x: builds the whole adapter from the game's normal love.* callbacks.

    -- main.lua, after defining love.load / love.update / love.draw / love.keypressed ...
    local wl = require("witness_love")
    wl.setup{
      name = "My Game", size = {320, 180},          -- size: the window/logical size Witness reports
      reset = function(seed, scene, params) ... end, -- default: love.load() again (RNG already seeded)
      snapshot = function() return {...} end,        -- JSON-able state; expose .entities = {{id,type,pos}}
      calls = { teleport = function(x, y) ... end },
      audio = mixer,                                 -- optional: wl.newMixer(...) (see GUIDE.md)
      touch = false,                                 -- true: the game handles love.touch* itself, so
                                                     -- finger 0 doesn't also fire love.mouse* (istouch)
    }

* Witness mode (WITNESS_ADDR set or --witness): replaces love.run with a loop that only advances
  on `step`, at a fixed dt. Input goes through love.handlers (so love.keypressed & co fire as
  usual) and love.keyboard.isDown / love.mouse.* / love.touch.* / love.timer.* report the
  injected, simulated state. Touch fires love.touchpressed/moved/released (integer ids, 0 = first
  finger) and, for finger 0, love.mousepressed/moved/released with istouch = true like a phone.
  Screenshots render love.draw and capture the backbuffer.
* Recording (WITNESS_RECORD=<file.jsonl>, normal play): wraps the default loop to write a replay
  (dt + input per frame, F8 = marker; touches as small integer finger ids, mouse events with
  istouch skipped) and seeds love.math/math.random with the replay seed.
* Otherwise setup() does nothing at all.
--]]

local witness = require("witness")

local wl = { witness = witness }

-- Witness key names whose LÖVE KeyConstant differs. Everything else ("a", "space", "left",
-- "f1", "escape", "backspace", "tab", ...) is already the same name.
local TO_LOVE = { enter = "return", shift = "lshift", ctrl = "lctrl", alt = "lalt" }
local FROM_LOVE = { ["return"] = "enter", kpenter = "enter", lshift = "shift", rshift = "shift",
                    lctrl = "ctrl", rctrl = "ctrl", lalt = "alt", ralt = "alt" }
-- Witness mouse buttons are 0 left, 1 middle, 2 right; LÖVE's are 1 left, 2 right, 3 middle.
local BUTTON_TO_LOVE = { [0] = 1, [1] = 3, [2] = 2 }
local BUTTON_FROM_LOVE = { [1] = 0, [2] = 2, [3] = 1 }

--- Replace LÖVE's blue error screen (which waits for a click) with: print the traceback to
--- stderr, report it to Witness when connected, exit(1). Installed automatically when this
--- module is required in witness mode; call it yourself for other unattended runs (CI demos).
--- Errors raised before this module loads need the same handler in conf.lua (see GUIDE.md).
function wl.headless_errors()
  local function handler(msg)
    local trace = debug.traceback("", 2):gsub("\n[^\n]*boot%.lua[^\n]*", "")
    local text = "Error: " .. tostring(msg) .. "\n" .. trace
    io.stderr:write(text, "\n")
    io.stderr:flush()
    if witness.connected() then
      pcall(witness.send, { event = "log", level = "error", message = text, frame = witness.frame() })
    end
    os.exit(1)
  end
  love.errorhandler = handler
  love.errhand = handler -- LÖVE 0.10 name
end

if witness.active() then wl.headless_errors() end

function wl.love_key(name) return TO_LOVE[name] or name end
function wl.witness_key(key) return FROM_LOVE[key] or key end

local function seed_rng(seed)
  if love.math and love.math.setRandomSeed then love.math.setRandomSeed(seed) end
  math.randomseed(seed)
end

-------------------------------------------------------------------------------- mixer (audio)

local Mixer = {}
Mixer.__index = Mixer

--- A game-side mixer: the one place every sound goes through, so Witness can capture it.
--- Normal play: voices are mixed into a QueueableSource (call mixer:update() from love.update).
--- Witness mode: sounds go sample-accurately into a witness.capture advanced by simulated time.
function wl.newMixer(rate, channels, buffer_frames)
  local self = setmetatable({ rate = rate or 22050, channels = channels or 1,
                              buffer_frames = buffer_frames or 1024, voices = {},
                              cache = setmetatable({}, { __mode = "k" }) }, Mixer)
  self.capture = witness.capture(self.rate, self.channels)
  if not witness.active() and love.audio and love.audio.newQueueableSource then
    self.source = love.audio.newQueueableSource(self.rate, 16, self.channels, 8)
  end
  return self
end

-- SoundData -> interleaved float array at the mixer's channel count (cached per SoundData).
function Mixer:floats(sd)
  local f = self.cache[sd]
  if f then return f end
  assert(sd:getSampleRate() == self.rate, "witness_love mixer: SoundData sample rate must match the mixer")
  local src, dst, n = sd:getChannelCount(), self.channels, sd:getSampleCount()
  f = {}
  for i = 0, n - 1 do
    if src == dst then
      for c = 1, dst do f[i * dst + c] = sd:getSample(i, c) end
    elseif src == 2 then
      f[i + 1] = (sd:getSample(i, 1) + sd:getSample(i, 2)) * 0.5
    else
      local v = sd:getSample(i, 1)
      f[i * 2 + 1], f[i * 2 + 2] = v, v
    end
  end
  self.cache[sd] = f
  return f
end

--- Play a SoundData (gain defaults to 1). With `name` it is also announced to Witness as that
--- sound (see wl.sound), e.g. mixer:play(coin_sd, 0.8, "coin").
function Mixer:play(sd, gain, name)
  if name then witness.sound(name, gain or 1) end
  local samples = self:floats(sd)
  if witness.active() then
    self.capture:play(samples, gain or 1)
  elseif self.source then
    self.voices[#self.voices + 1] = { samples = samples, pos = 0, gain = gain or 1 }
  end
end

--- Announce a sound the game just started (witness.sound): wl.sound("jump") or
--- wl.sound("hit", 0.8, x, y). Call it next to Source:play(). No-op outside witness mode.
wl.sound = witness.sound

--- Normal play only: keep the QueueableSource fed. Call once per love.update.
function Mixer:update()
  local qs = self.source
  if not qs then return end
  while qs:getFreeBufferCount() > 0 do
    local n, ch = self.buffer_frames, self.channels
    local sd = love.sound.newSoundData(n, self.rate, 16, ch)
    for v = #self.voices, 1, -1 do
      local voice = self.voices[v]
      local s, pos, g, len = voice.samples, voice.pos, voice.gain, #voice.samples
      local count = math.min(n * ch, len - pos)
      for i = 0, count - 1 do
        local frame, c = math.floor(i / ch), i % ch + 1
        local cur = sd:getSample(frame, c) + s[pos + i + 1] * g
        sd:setSample(frame, c, cur > 1 and 1 or (cur < -1 and -1 or cur))
      end
      voice.pos = pos + count
      if voice.pos >= len then table.remove(self.voices, v) end
    end
    qs:queue(sd)
  end
  if not qs:isPlaying() then qs:play() end
end

-------------------------------------------------------------------------------- witness mode

local W = { keys = {}, scancodes = {}, buttons = {}, touches = {}, mx = 0, my = 0, dt = 1 / 60 }

-- love.handlers[name](...) when LÖVE has that handler, else the love.<name> callback directly.
local function fire(name, ...)
  local f = love.handlers and love.handlers[name]
  if f then return f(...) end
  if love[name] then return love[name](...) end
end

-- Injected input, delivered through love.handlers exactly like the default love.run does.
local function inject(ev, user_input)
  local h = love.handlers
  local t = ev.type
  if t == "touch" then
    -- integer ids (0 = first finger); LÖVE games treat touch ids as opaque keys
    local id, x, y, p = ev.id or 0, ev.x or 0, ev.y or 0, ev.pressure or 1
    local prev = W.touches[id]
    if ev.phase == "down" then
      W.touches[id] = { x = x, y = y, pressure = p }
      fire("touchpressed", id, x, y, 0, 0, p)
    elseif ev.phase == "up" or ev.phase == "cancel" then
      -- LÖVE has no touch-cancel callback: "cancel" (the system ended the touch) arrives as touchreleased
      W.touches[id] = nil
      fire("touchreleased", id, x, y, prev and x - prev.x or 0, prev and y - prev.y or 0, p)
    else
      W.touches[id] = { x = x, y = y, pressure = p }
      fire("touchmoved", id, x, y, prev and x - prev.x or 0, prev and y - prev.y or 0, p)
    end
    -- finger 0's mouse fallback arrives next as a "mouse" event with from_touch = true (witness.lua)
  elseif t == "key" then
    local key = wl.love_key(ev.key)
    if ev.down then
      local repeated = W.keys[key] == true
      W.keys[key], W.scancodes[key] = true, true
      h.keypressed(key, key, repeated)
    else
      W.keys[key], W.scancodes[key] = nil, nil
      h.keyreleased(key, key)
    end
  elseif t == "mouse" then
    local x, y = ev.x or W.mx, ev.y or W.my
    local istouch = ev.from_touch == true -- the finger-0 fallback: LÖVE's istouch argument
    if x ~= W.mx or y ~= W.my then
      local dx, dy = x - W.mx, y - W.my
      W.mx, W.my = x, y
      h.mousemoved(x, y, dx, dy, istouch)
    end
    if ev.down ~= nil then
      local b = BUTTON_TO_LOVE[ev.button or 0] or 1
      if ev.down then W.buttons[b] = true; h.mousepressed(x, y, b, istouch, 1)
      else W.buttons[b] = nil; h.mousereleased(x, y, b, istouch, 1) end
    end
  elseif t == "wheel" then
    h.wheelmoved(0, -(ev.dy or 0) / 100) -- Witness: + = scroll down; LÖVE: + = up
  elseif t == "text" then
    h.textinput(ev.text or "")
  end
  if user_input then user_input(ev) end -- actions, pads, axes, or extra game-side handling
end

-- Polling APIs report injected input and simulated time (witness mode only).
local function patch_love()
  if love.keyboard then
    love.keyboard.isDown = function(...)
      for i = 1, select("#", ...) do if W.keys[select(i, ...)] then return true end end
      return false
    end
    love.keyboard.isScancodeDown = function(...)
      for i = 1, select("#", ...) do if W.scancodes[select(i, ...)] then return true end end
      return false
    end
  end
  if love.mouse then
    love.mouse.getPosition = function() return W.mx, W.my end
    love.mouse.getX = function() return W.mx end
    love.mouse.getY = function() return W.my end
    love.mouse.isDown = function(...)
      for i = 1, select("#", ...) do if W.buttons[select(i, ...)] then return true end end
      return false
    end
  end
  if love.touch then
    love.touch.getTouches = function()
      local ids = {}
      for id in pairs(W.touches) do ids[#ids + 1] = id end
      table.sort(ids) -- stable order: determinism
      return ids
    end
    local function active(id)
      local t = W.touches[id]
      if not t then error("Invalid active touch ID: " .. tostring(id), 3) end
      return t
    end
    love.touch.getPosition = function(id) local t = active(id); return t.x, t.y end
    love.touch.getPressure = function(id) return active(id).pressure end
  end
  if love.timer then
    love.timer.getDelta = function() return W.dt end
    love.timer.getTime = function() return witness.time() end
    love.timer.getFPS = function() return math.floor(1 / W.dt + 0.5) end
    love.timer.getAverageDelta = function() return W.dt end
    love.timer.step = function() return W.dt end
    love.timer.sleep = function() end
  end
end

-- Discard real OS input while Witness drives the game (but keep the window responsive).
local IGNORED = { keypressed = true, keyreleased = true, textinput = true, textedited = true,
                  mousepressed = true, mousereleased = true, mousemoved = true, wheelmoved = true,
                  touchpressed = true, touchreleased = true, touchmoved = true, quit = true,
                  joystickpressed = true, joystickreleased = true, joystickaxis = true,
                  joystickhat = true, gamepadpressed = true, gamepadreleased = true, gamepadaxis = true }
local function pump_os_events()
  if not love.event then return end
  love.event.pump()
  for name, a, b, c, d, e, f in love.event.poll() do
    if not IGNORED[name] and love.handlers[name] then love.handlers[name](a, b, c, d, e, f) end
  end
end

local function render_frame()
  love.graphics.origin()
  love.graphics.clear(love.graphics.getBackgroundColor())
  if love.draw then love.draw() end
end

local function screenshot(opts)
  return function()
    if not (love.graphics and love.graphics.isActive()) then error("no graphics context (window disabled?)", 0) end
    local result
    if opts.screenshot_canvas ~= false then
      -- default: draw into an offscreen canvas, so the window can stay minimized/off-screen.
      -- Games that call love.graphics.setCanvas() themselves inside love.draw should pass
      -- screenshot_canvas = false to capture the real backbuffer instead.
      local w, h = opts.size[1], opts.size[2]
      W.canvas = W.canvas or love.graphics.newCanvas(w, h)
      love.graphics.push("all")
      love.graphics.setCanvas(W.canvas)
      render_frame()
      love.graphics.pop()
      result = W.canvas:newImageData()
    else
      render_frame()
      love.graphics.captureScreenshot(function(img) result = img end)
      love.graphics.present() -- the callback fires at the end of present()
    end
    if not result then error("captureScreenshot returned nothing", 0) end
    return result:getWidth(), result:getHeight(), result:getString()
  end
end

local function run_witness(opts)
  local user_reset = opts.reset
  local handlers = {
    name = opts.name or (love.window and love.window.getTitle and love.window.getTitle()) or "LÖVE game",
    engine = "LÖVE " .. table.concat({ love.getVersion() }, ".", 1, 3),
    fps = opts.fps or 60, size = opts.size, keys = opts.keys, calls = opts.calls,
    call_args = opts.call_args, call_help = opts.call_help, env = opts.env, perf = opts.perf,
    snapshot = opts.snapshot,
    audio = opts.audio and (opts.audio.capture or opts.audio) or nil,
    touch = opts.touch,
    reset = function(seed, scene, params)
      W.keys, W.scancodes, W.buttons, W.touches, W.mx, W.my = {}, {}, {}, {}, 0, 0
      seed_rng(seed)
      if user_reset then user_reset(seed, scene, params)
      elseif love.load then love.load({}, {}) end
    end,
    input = function(ev) inject(ev, opts.input) end,
    update = function(dt)
      W.dt = dt
      pump_os_events()
      if love.update then love.update(dt) end
    end,
  }
  if love.graphics and opts.screenshot ~= false then handlers.screenshot = screenshot(opts) end
  witness.run(handlers)
end

--- Wire Witness into a LÖVE game. Call once at the end of main.lua (see the header).
function wl.setup(opts)
  opts = opts or {}
  if witness.active() then
    assert(opts.snapshot, "witness_love.setup needs a snapshot function")
    if not opts.size and love.graphics then opts.size = { love.graphics.getDimensions() } end
    function love.run()
      patch_love()
      -- keep the window out of the way: screenshots render offscreen (see screenshot_canvas)
      if opts.minimize ~= false and opts.screenshot_canvas ~= false and love.window then love.window.minimize() end
      if love.load then love.load(love.arg.parseGameArguments(arg), arg) end
      return function()
        local ok, err = pcall(run_witness, opts)
        if not ok then
          io.stderr:write("[witness] " .. tostring(err) .. "\n")
          return 1
        end
        return 0
      end
    end
  elseif witness.recording() then
    wl.record(opts)
  end
end

-------------------------------------------------------------------------------- recording

-- LÖVE touch ids (light userdata) -> small integer finger ids: 0 = first finger down, and a
-- slot is reused once its finger lifts (what Witness touch events and replays use).
local touch_slots = {}
local function touch_slot(id)
  local s = touch_slots[id]
  if s == nil then
    local used = {}
    for _, v in pairs(touch_slots) do used[v] = true end
    s = 0
    while used[s] do s = s + 1 end
    touch_slots[id] = s
  end
  return s
end
local TOUCH_PHASE = { touchpressed = "down", touchmoved = "move", touchreleased = "up" }

local function to_event(name, a, b, c, d, e, f)
  if name == "keypressed" or name == "keyreleased" then
    return { type = "key", key = wl.witness_key(a), down = name == "keypressed" }
  elseif TOUCH_PHASE[name] then -- touch*(id, x, y, dx, dy, pressure)
    local ev = { type = "touch", id = touch_slot(a), x = b, y = c, phase = TOUCH_PHASE[name], pressure = f }
    if name == "touchreleased" then touch_slots[a] = nil end
    return ev
  elseif name == "mousepressed" or name == "mousereleased" then
    if d then return nil end -- istouch: synthesized from a finger; replay recreates it from the touch
    return { type = "mouse", x = a, y = b, button = BUTTON_FROM_LOVE[c] or 0, down = name == "mousepressed" }
  elseif name == "mousemoved" then
    if e then return nil end -- istouch
    return { type = "mouse", x = a, y = b }
  elseif name == "wheelmoved" then
    return { type = "wheel", dy = -b * 100 }
  elseif name == "textinput" then
    return { type = "text", text = a }
  end
end

--- Normal play with WITNESS_RECORD set: the default love.run plus a replay line per frame.
function wl.record(opts)
  local rec = witness.start_recording(opts.name or "LÖVE game", opts.fps or 60)
  function love.run()
    seed_rng(rec.seed)
    if love.load then love.load(love.arg.parseGameArguments(arg), arg) end
    if love.timer then love.timer.step() end
    local dt = 0
    return function()
      local events = {}
      if love.event then
        love.event.pump()
        for name, a, b, c, d, e, f in love.event.poll() do
          if name == "quit" and (not love.quit or not love.quit()) then
            witness.stop_recording()
            return a or 0
          end
          if name == "keypressed" and a == "f8" then witness.mark("F8")
          elseif name ~= "keypressed" or not c then -- skip OS key repeats
            local ev = to_event(name, a, b, c, d, e, f)
            if ev and not (ev.type == "key" and ev.key == "f8") then events[#events + 1] = ev end
          end
          love.handlers[name](a, b, c, d, e, f)
        end
      end
      if love.timer then dt = love.timer.step() end
      if love.update then love.update(dt) end
      witness.record_frame(dt, events)
      if love.graphics and love.graphics.isActive() then
        render_frame()
        love.graphics.present()
      end
      if love.timer then love.timer.sleep(0.001) end
    end
  end
end

return wl
