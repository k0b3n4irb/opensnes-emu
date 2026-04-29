--[[
visual-capture.lua — capture the SNES framebuffer at a chosen frame

Used by tools/opensnes-emu/test/phases/visual-mesen2.mjs to drive Mesen2
in headless --testrunner mode. Cannot use emu.takeScreenshot() because
the video decoder is intentionally not initialised when --testrunner is
active (UI/Utilities/TestRunner.cs passes noVideo=true to InitializeEmu).
We use emu.getScreenBuffer() instead, which goes through GetVideoFilter()
and works without the decoder.

Inputs (read from environment via getenv since --testrunner has no
positional script args):
    MESEN_CAPTURE_FRAME — frame number to capture at (default 120)
    MESEN_CAPTURE_OUTPUT — absolute path of the output file (required)

Output file layout (.bin):
    [0..3]   width  (u32 little-endian)
    [4..7]   height (u32 little-endian)
    [8..]    width * height * 4 bytes RGBA, row-major, A=255

Mesen2 reports the SNES PPU frame size dynamically — typically 256×239
on NTSC, can grow with hi-res / interlace modes. The header bytes let
the Node wrapper handle whatever dimensions Mesen2 produces without
hard-coding them.

Exit codes:
    0  — buffer captured successfully
    2  — output file could not be opened (sandbox? permission?)
    3  — getScreenBuffer returned an empty buffer
    4  — MESEN_CAPTURE_OUTPUT was not provided
--]]

local target = tonumber(os.getenv("MESEN_CAPTURE_FRAME") or "120") or 120
local out_path = os.getenv("MESEN_CAPTURE_OUTPUT")

if out_path == nil or out_path == "" then
    emu.stop(4)
    return
end

local frames = 0

local function on_frame()
    frames = frames + 1
    if frames < target then return end

    local buf = emu.getScreenBuffer()
    local total = #buf
    if total == 0 then
        emu.stop(3)
        return
    end

    -- Mesen2 SNES output is always 256 pixels wide; height = total / 256.
    local w = 256
    local h = math.floor(total / w)

    local f = io.open(out_path, "wb")
    if f == nil then
        emu.stop(2)
        return
    end

    -- 8-byte header: width (u32 LE) + height (u32 LE)
    f:write(string.char(w & 0xFF, (w >> 8) & 0xFF, (w >> 16) & 0xFF, (w >> 24) & 0xFF))
    f:write(string.char(h & 0xFF, (h >> 8) & 0xFF, (h >> 16) & 0xFF, (h >> 24) & 0xFF))

    -- emu.getScreenBuffer returns a flat array of integers; each integer
    -- encodes one pixel as 0x00RRGGBB in the LOW 24 bits (Mesen masks the
    -- alpha out: see GetScreenBuffer in Core/Debugger/LuaApi.cpp). We
    -- write little-endian RGBA so a downstream PNG encoder can treat the
    -- buffer as standard 8-bit-per-channel pixels with opaque alpha.
    for i = 1, total do
        local v = buf[i]
        f:write(string.char(
            (v >> 16) & 0xFF,   -- R
            (v >> 8)  & 0xFF,   -- G
            v         & 0xFF,   -- B
            0xFF                -- A
        ))
    end
    f:close()

    emu.stop(0)
end

emu.addEventCallback(on_frame, emu.eventType.endFrame)
