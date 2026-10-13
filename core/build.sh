#!/usr/bin/env bash
# Builds the osu!standard core to WebAssembly and runs the wasm property tests.
#
#   ./build.sh            clang wasm32 build (works here, no Emscripten needed)
#   EMCC=1 ./build.sh     Emscripten build (emcc -sSTANDALONE_WASM), when emsdk is installed
#
# Output: build/osu_core.wasm
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p build

SRC="src/path.cpp src/beatmap.cpp src/score.cpp src/judge.cpp src/api.cpp"
EXPORTS=(
  osu_input_buffer osu_load osu_error osu_meta
  osu_skin_buffer osu_set_skin_colours osu_colour_count osu_colours
  osu_restart osu_update osu_press osu_set_mods
  osu_fill_records osu_records osu_top_count osu_slider_point_count osu_slider_points osu_stats
)

if [[ "${EMCC:-0}" == "1" ]]; then
  EXPORT_LIST=""
  for e in "${EXPORTS[@]}"; do EXPORT_LIST+="_${e},"; done
  emcc -std=c++17 -O2 -fno-exceptions -fno-rtti -Isrc -Iinclude $SRC \
    -sSTANDALONE_WASM=1 -sINITIAL_MEMORY=134217728 -sALLOW_MEMORY_GROWTH=0 \
    -sEXPORTED_FUNCTIONS="${EXPORT_LIST%,}" -sEXPORTED_RUNTIME_METHODS=HEAPU8 \
    -Wl,--no-entry -o build/osu_core.wasm
else
  FLAGS=()
  for e in "${EXPORTS[@]}"; do FLAGS+=("-Wl,--export=$e"); done
  clang++ --target=wasm32-unknown-unknown -std=c++17 -O2 -nostdlib \
    -fno-exceptions -fno-rtti -Isrc -Iinclude $SRC -o build/osu_core.wasm \
    -Wl,--no-entry -Wl,--allow-undefined -Wl,--export-memory \
    -Wl,--initial-memory=134217728 "${FLAGS[@]}"
fi

echo "built build/osu_core.wasm ($(stat -c %s build/osu_core.wasm) bytes)"

if command -v node >/dev/null 2>&1; then
  node tests/run_wasm.mjs build/osu_core.wasm
fi

# The web front end loads ../web/osu_core.wasm; copy only after the property tests pass.
cp build/osu_core.wasm ../web/osu_core.wasm
echo "copied to web/osu_core.wasm"
echo "end-to-end (needs Chromium): python3 ../web/tests/make_fixture.py /tmp/fixture.osz && python3 ../web/tests/make_skin_fixture.py /tmp/test-skin.osk && python3 ../web/tests/e2e_test.py /tmp/fixture.osz /tmp/test-skin.osk"
