-- Witness mode (WITNESS_ADDR set): a small borderless window parked off-screen (witness_love then
-- minimizes it; screenshots render into an offscreen canvas), no vsync so nothing waits on the
-- display. Normal play gets a 3x window.
local witness_mode = (os.getenv("WITNESS_ADDR") or "") ~= ""
local unattended = witness_mode
for _, a in ipairs(arg or {}) do
  if a == "--demo" then unattended = true end
end

function love.conf(t)
  t.identity = "witness-coins"
  t.version = "11.5"
  t.window.title = "Coins (LÖVE) - arrows/WASD, F8 marks a replay moment"
  t.window.width = witness_mode and 320 or 960
  t.window.height = witness_mode and 180 or 540
  t.window.vsync = witness_mode and 0 or 1
  if witness_mode then
    t.window.borderless = true
    t.window.x, t.window.y = -10000, -10000
  end
  t.modules.joystick = false
  t.modules.physics = false
  t.modules.video = false
end

-- Unattended runs (Witness, CI demos): nobody can click LÖVE's blue error screen away, so print
-- the error and exit instead. witness_love installs the same handler (and also reports the error
-- to Witness); this copy covers errors raised before main.lua has loaded it.
if unattended then
  function love.errorhandler(msg)
    io.stderr:write("Error: " .. tostring(msg) .. "\n" .. debug.traceback("", 2) .. "\n")
    io.stderr:flush()
    os.exit(1)
  end
end
