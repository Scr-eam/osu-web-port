// Player settings, named after the options in osu! (lazer's settings screens). Each one is
// described here, shown in the settings panel and saved in localStorage. Changing one applies
// straight away; the panel is built from this list, so adding an option is one entry.
// Keys, the mouse-button toggle and the skin choice are handled in index.html.

export const SETTING_DEFS = [
  // Input
  { section: "Input", key: "relative", type: "bool", def: false,
    label: "High precision mouse", tip: "Reads raw mouse movement with the pointer locked during a round. Esc releases it." },
  { section: "Input", key: "sensitivity", type: "range", def: 1, min: 0.1, max: 4, step: 0.01,
    label: "Cursor sensitivity", tip: "Only applies with high precision mouse, as in osu!.", needs: "relative" },
  // Gameplay
  { section: "Gameplay", key: "cursorSize", type: "range", def: 1, min: 0.1, max: 2, step: 0.01, label: "Cursor size" },
  { section: "Gameplay", key: "cursorRotate", type: "bool", def: true, label: "Cursor rotation" },
  { section: "Gameplay", key: "cursorTrail", type: "bool", def: true, label: "Cursor trail" },
  { section: "Gameplay", key: "snakeIn", type: "bool", def: true, label: "Snaking in sliders" },
  { section: "Gameplay", key: "snakeOut", type: "bool", def: true, label: "Snaking out sliders" },
  { section: "Gameplay", key: "keyOverlay", type: "bool", def: false, label: "Key overlay" },
  { section: "Gameplay", key: "healthFade", type: "bool", def: true, label: "Fade playfield when health is low" },
  { section: "Gameplay", key: "hitLighting", type: "bool", def: true, label: "Hit lighting",
    tip: "A glow when a note is hit, as in osu!." },
  { section: "Gameplay", key: "hitFade", type: "range", def: 200, min: 20, max: 1000, step: 10, label: "Hit fade (ms)",
    tip: "How long a hit note takes to fade. Short leaves just the jiggle; long leaves a faint ghost of the note." },
  { section: "Gameplay", key: "showVideo", type: "bool", def: true, label: "Beatmap video",
    tip: "Plays the beatmap's video behind the playfield, from its start time. Videos with sound are muted. A video this browser cannot play (FLV, AVI, WMV, MPG) is converted first, which takes a while the first time." },
  { section: "Gameplay", key: "dimVideo", type: "range", def: 0.5, min: 0, max: 1, step: 0.01, label: "Video dim",
    tip: "How dark the video is behind the notes. 1 hides it." },
  // Skin
  { section: "Skin", key: "defaultLook", type: "select", def: "argon", options: [["argon", "Argon"], ["flat", "Flat"]],
    label: "Default look", tip: "How notes look when no skin is chosen. Flat draws plain shapes." },
  { section: "Skin", key: "beatmapSkins", type: "bool", def: true, label: "Beatmap skins",
    tip: "Uses the skin files inside a beatmap, such as its hit circle images and hit sounds. Off uses your chosen skin." },
  { section: "Skin", key: "beatmapColours", type: "bool", def: true, label: "Beatmap combo colours",
    tip: "Uses the combo colours a beatmap sets. Off uses the skin's or the default colours." },
  // Audio
  { section: "Skin", key: "menuFx", type: "select", def: "on", options: [["on", "On"], ["system", "Follow system"], ["off", "Off"]],
    label: "Main menu animations", tip: "Particles, light rays and the beat pulse on the main menu. Follow system turns them off when the computer is set to reduce motion (Windows: Animation effects)." },
  { section: "Audio", key: "offset", type: "range", def: 0, min: -500, max: 500, step: 1,
    label: "Audio offset (ms)", tip: "Shifts the timing of the whole round. Positive values make you judge later." },
  { section: "Audio", key: "volMusic", type: "range", def: 1, min: 0, max: 1, step: 0.01, label: "Music volume" },
  { section: "Audio", key: "volFx", type: "range", def: 1, min: 0, max: 1, step: 0.01, label: "Effect volume" },
  { section: "Audio", key: "hitsounds", type: "bool", def: true, label: "Hit sounds" },
  { section: "Audio", key: "unmuteMaps", type: "bool", def: true, label: "Hit sounds on muted maps",
    tip: "Some maps set their hit sound volume to 0 on purpose. On plays them at full volume anyway; off keeps them silent, as osu! does." },
];

// Copies stored values onto s. Anything that does not match its type or range keeps the default.
export function applyStored(s, stored) {
  for (const d of SETTING_DEFS) {
    s[d.key] = d.def;
    const v = stored ? stored[d.key] : undefined;
    if (d.type === "bool" && typeof v === "boolean") s[d.key] = v;
    if (d.type === "range" && typeof v === "number" && v >= d.min && v <= d.max) s[d.key] = v;
    if (d.type === "select" && d.options.some(([value]) => value === v)) s[d.key] = v;
  }
  return s;
}

// Builds the controls into container. onChange(key, value) is called for every change.
// Returns refresh(), which updates controls that depend on other settings.
export function buildSettingsPanel(container, s, onChange) {
  const controls = [];
  let section = null;
  for (const d of SETTING_DEFS) {
    if (d.section !== section) {
      section = d.section;
      const h = document.createElement("h3");
      h.textContent = section;
      container.append(h);
    }
    const row = document.createElement("label");
    row.className = "setting";
    row.title = d.tip || "";
    const name = document.createElement("span");
    name.textContent = d.label;
    row.append(name);
    let input;
    let shown = null;
    if (d.type === "bool") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = s[d.key];
      input.onchange = () => onChange(d.key, input.checked);
    } else if (d.type === "range") {
      input = document.createElement("input");
      input.type = "range";
      input.min = d.min;
      input.max = d.max;
      input.step = d.step;
      input.value = s[d.key];
      shown = document.createElement("output");
      const show = (v) => { shown.textContent = d.step < 1 ? Number(v).toFixed(2) : String(Math.round(v)); };
      show(s[d.key]);
      input.oninput = () => { show(input.value); onChange(d.key, Number(input.value)); };
    } else {
      input = document.createElement("select");
      for (const [value, text] of d.options) input.append(new Option(text, value));
      input.value = s[d.key];
      input.onchange = () => onChange(d.key, input.value);
    }
    input.id = `set-${d.key}`;
    row.append(input);
    if (shown) row.append(shown);
    container.append(row);
    controls.push({ d, input, row });
  }
  return function refresh() {
    for (const { d, input, row } of controls) {
      if (!d.needs) continue;
      const off = !s[d.needs];
      input.disabled = off;
      row.classList.toggle("off", off);
    }
  };
}
