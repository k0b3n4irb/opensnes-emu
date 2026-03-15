# OpenSNES Debug Emulator — WASM Core Build
#
# Compiles snes9x libretro core + bridge.cpp into a single WASM module.
# Requires Emscripten SDK (emsdk) to be activated in the environment.

CORE_DIR    := snes9x/libretro
SNES9X_DIR  := snes9x
BUILD_DIR   := build
BRIDGE_SRC  := bridge.cpp

# Output files
WASM_OUT    := $(BUILD_DIR)/snes9x_libretro.wasm
JS_OUT      := $(BUILD_DIR)/snes9x_libretro.mjs

# Emscripten settings
TOTAL_MEMORY := 67108864
STACK_SIZE   := 1048576

# Exported C bridge functions
BRIDGE_EXPORTS := \
	_bridge_set_framebuffer \
	_bridge_get_vram \
	_bridge_get_vram_size \
	_bridge_read_vram \
	_bridge_get_cgram \
	_bridge_get_cgram_size \
	_bridge_read_cgram \
	_bridge_get_oam \
	_bridge_get_oam_size \
	_bridge_read_oam \
	_bridge_get_wram \
	_bridge_get_wram_size \
	_bridge_read_wram \
	_bridge_get_pc \
	_bridge_get_a \
	_bridge_get_x \
	_bridge_get_y \
	_bridge_get_sp \
	_bridge_get_db \
	_bridge_get_pb \
	_bridge_get_p \
	_bridge_get_bg_mode \
	_bridge_get_bg_scroll_x \
	_bridge_get_bg_scroll_y \
	_bridge_get_inidisp \
	_bridge_get_bg_tile_base \
	_bridge_get_bg_map_base \
	_bridge_get_bg_size \
	_bridge_get_obj_size_select \
	_bridge_get_obj_name_base \
	_bridge_get_brightness \
	_bridge_get_forced_blanking \
	_bridge_get_screen_height \
	_bridge_get_cycles \
	_bridge_get_v_counter \
	_bridge_get_wai_state \
	_bridge_get_framebuffer \
	_bridge_get_fb_width \
	_bridge_get_fb_height \
	_bridge_get_fb_pitch \
	_bridge_is_initialized \
	_bridge_read_region

# Libretro API exports
LIBRETRO_EXPORTS := \
	_retro_api_version \
	_retro_init \
	_retro_deinit \
	_retro_set_environment \
	_retro_set_video_refresh \
	_retro_set_audio_sample \
	_retro_set_audio_sample_batch \
	_retro_set_input_poll \
	_retro_set_input_state \
	_retro_get_system_info \
	_retro_get_system_av_info \
	_retro_load_game \
	_retro_unload_game \
	_retro_run \
	_retro_reset \
	_retro_serialize_size \
	_retro_serialize \
	_retro_unserialize \
	_retro_get_memory_data \
	_retro_get_memory_size \
	_retro_get_region \
	_retro_set_controller_port_device

ALL_EXPORTS := $(LIBRETRO_EXPORTS) $(BRIDGE_EXPORTS) _malloc _free

# Convert space-separated list to comma-separated for Emscripten
COMMA := ,
EMPTY :=
SPACE := $(EMPTY) $(EMPTY)
EXPORTED_FUNCTIONS := $(subst $(SPACE),$(COMMA),$(strip $(ALL_EXPORTS)))

# Emscripten compiler flags
EMCC_FLAGS := \
	-O2 \
	-s MODULARIZE=1 \
	-s EXPORT_ES6=1 \
	-s EXPORTED_FUNCTIONS="[$(EXPORTED_FUNCTIONS)]" \
	-s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','HEAPU8','HEAPU16','HEAPU32','addFunction','removeFunction']" \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=$(TOTAL_MEMORY) \
	-s STACK_SIZE=$(STACK_SIZE) \
	-s NO_EXIT_RUNTIME=1 \
	-s ENVIRONMENT='node' \
	-s FILESYSTEM=1 \
	-s ASSERTIONS=1 \
	-s EXPORT_NAME='createSnes9x' \
	-s ALLOW_TABLE_GROWTH=1

# Include paths for bridge.cpp → snes9x headers
BRIDGE_INCLUDES := -I$(SNES9X_DIR) -I$(CORE_DIR)

.PHONY: all clean core bridge

all: $(JS_OUT)

# Step 1: Build snes9x libretro core as static library (.bc or .a)
# The Makefile with platform=emscripten produces a .bc file
core:
	@echo "=== Building snes9x libretro core ==="
	cd $(CORE_DIR) && emmake make -f Makefile platform=emscripten \
		STATIC_LINKING=1 \
		-j$$(nproc)
	@echo "=== Core built ==="

# Step 2: Compile bridge.cpp (includes snes9x headers for direct global access)
$(BUILD_DIR)/bridge.o: $(BRIDGE_SRC) | $(BUILD_DIR)
	@echo "=== Compiling bridge ==="
	em++ -O2 -std=c++14 -c $(BRIDGE_SRC) -o $@ $(BRIDGE_INCLUDES) -DHAVE_STDINT_H -DHAVE_STRINGS_H -D__LIBRETRO__

# The snes9x Makefile produces a .bc file that is actually an ar archive.
# Rename to .a so Emscripten 5.x handles it correctly.
CORE_BC  := $(CORE_DIR)/snes9x_libretro_emscripten.bc
CORE_LIB := $(BUILD_DIR)/libsnes9x.a

$(CORE_LIB): core | $(BUILD_DIR)
	cp $(CORE_BC) $(CORE_LIB)

# Step 3: Link everything into WASM module (use em++ for C++ objects)
$(JS_OUT): $(CORE_LIB) $(BUILD_DIR)/bridge.o | $(BUILD_DIR)
	@echo "=== Linking WASM module ==="
	em++ $(EMCC_FLAGS) \
		$(BUILD_DIR)/bridge.o \
		$(CORE_LIB) \
		-o $(JS_OUT)
	@ls -lh $(WASM_OUT) $(JS_OUT)
	@echo "=== Build complete ==="

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR)
	-cd $(CORE_DIR) 2>/dev/null && emmake make -f Makefile platform=emscripten clean 2>/dev/null

# Build bridge only (for testing without full core rebuild)
bridge-only: $(BUILD_DIR)/bridge.o
	@echo "Bridge object built: $(BUILD_DIR)/bridge.o"

# Print the export list (for debugging)
print-exports:
	@echo "$(EXPORTED_FUNCTIONS)"
