# Handoff plan

Work through the steps in order. Each step ends with something Anup can check. Model tags follow the
leader/worker convention: Fable for protocol and hardware work, Opus for implementation, Sonnet for mechanical tasks.
Read `docs/INVESTIGATION.md` first; it is the evidence behind steps 0 and 1.

## 0. Stack decision (Anup)

Step 1 of the old plan was "match Cortex Control's stack". Result: Cortex Control is **JUCE 8 / C++**, talks to the
Quad Cortex over **USB HID + protobuf**, has **no Bluetooth code and no Nano Cortex support**. Matching it buys
nothing: its transport and protocol don't apply to the Nano, and JUCE is the one target with no BLE GATT client.

Recommendation: **stay on Electron** and finish the product. Two independent community editors ship on
Electron + Web Bluetooth on macOS, so the risk is low. If a native app is still wanted later, the right target is
**Swift (SwiftUI + CoreBluetooth)**, done after the protocol is hardware-verified so the port has golden fixtures to
test against.

**Decided 2026-10-08:** stay on Electron through steps 1–4, then port to Swift (SwiftUI + CoreBluetooth) against the
recordings and fixtures. **Revised later the same day:** this repo stays the Electron product for good (the fallback,
and the version that could be shared, including with Windows users); a native Mac app, if it happens, is a separate
project that consumes the recordings and fixtures from here.

## 1. Move the protocol layer to DrD85's editor (Opus) — done 2026-10-08

DrD85/nano-cortex-editor (MIT) is a superset of the choldy editor we vendored and adds BLE preset switching,
rename, tuner, library loading and a coalescing write queue. Replacing the base gets most of old step 4 for free.

1. Vendor `index.html` from DrD85 as `editor/index.html` (verbatim, keep the LICENSE and note the version/commit in
   `editor/README.md`). The Classic Editor menu item now shows DrD85's full UI, a strong fallback.
2. Re-point `scripts/build-core.js` at the new file: new slice markers, keep the existing safety patches where they
   still apply, drop the MIDI output fallback patch if the MIDI path is gone, and extend `REQUIRED` with
   `presetChangeFrame`, `renamePresetTo`, `tunerModeFrame`, `requestLibraryContent`, `buildFrame`, `frameType`,
   `MSG`. Fail loudly on anything missing.
3. In `pro/ui.js`: preset switching calls `selectPreset` over BLE and no longer checks for a MIDI port; add Rename
   (in the preset title and the preset list context menu), Tuner (`T`, overlay with note/cents/reference pitch),
   and a "Load from pedal library" picker in the Capture and Cab/IR inspectors. Keep the layout as is.
4. Demo mode: fake `SetPresetSlotsRequest`/`Response`, rename, tuner metering and library responses so everything
   runs without a pedal.
5. `test/ux-test.js`: update "without MIDI…" checks to the BLE path; add checks for rename, tuner open/close packets,
   library load packet, and that fast knob turns coalesce to one pending write per parameter.

Verify: `npm run build:core` passes, `npm run test:ux` green on macOS (fix the harness for ⌘ first if it isn't),
Classic Editor opens DrD85's UI on demo data.

## 2. First session with the real pedal (Fable, with Anup)

Produces the ground truth every later step is tested against. Back up presets in the Cortex Cloud app first.

1. ~~Add session recording~~ Done: **Record** in the status bar; JSON lands in `test/fixtures/sessions/` (git-ignored; recordings are never committed). The editor
   log is mirrored to the terminal when run with `npm start`.
2. With Anup and the pedal (phone app disconnected, pedal on, Mac Bluetooth on; **no USB cable needed**), record:
   - [x] Connect. Auto-pick works (pedal must be in pairing mode the first time).
   - [x] Initial sync shows the right preset names, capture and IR names, current blocks and values.
   - [x] Preset switch over BLE from the app (13/13 confirmed). Footswitch-initiated change (ack path): not yet observed.
   - [x] Amp knobs, capture volume, FX params, bypass, gate, cab level: confirmed by read-back (Anup confirmed audibly for knobs/presets).
   - [x] Model change, capture slot, IR slot. Mic/position needed a protocol fix (library index), see INVESTIGATION §4.
   - [x] Rename preset 64 → "Claude Test 64"; save gain 150 / volume −3 dB / Green 808 on. Power-cycled: name and edits persisted, pedal reports clean.
   - [x] Tuner on/off (metering only while a string sounds).
   - [x] Library capture and library IR loaded into slots 25 and 5 (same content as before, so nothing changed on the pedal).
   - [x] Reconnect after power-cycle works (the first scans after boot may come up empty; retry). Phone-app-holds-connection message: not yet checked.
   - [ ] Cab from the library (not a slot): cab tone knobs are stale; decide how to read them.
   - [ ] Optional: plug USB in and confirm a MIDI PC from the Mac also switches presets (fallback only).
3. Fix what breaks. Add a UX-test check for each fix where it can be tested. Inline the expected bytes
   in the UX test (recordings themselves are never committed).

## 3. Responsiveness (Opus)

- Stream knob writes during a drag through the coalescing queue (DrD85's queue already keeps one write in
  flight and one pending per parameter). Use step 2's recordings to pick the rate the pedal tolerates.
- Remember the pedal and reconnect automatically when it powers on.
- On launch, show the last known state immediately while the sync runs.

## 4. Remaining features

- Bulk backup and restore: loop DrD85's per-preset export/import over all 64 slots into one folder (Opus).
- Preset reorder and copy: try `SetPresetSlotsRequest` fields 5–8 (footswitch slots) first; otherwise needs a
  capture of the official app (Fable).
- Send captures **from Cortex Cloud** into the pedal: decoded from a PacketLogger trace and implemented
  (INVESTIGATION §6): "Send to Nano" on a capture page in the Cloud tab → confirm → streamed over C304 → library
  refresh → optional slot load. Verified on the pedal 2026-10-08: "Klon Centaur 1" (10 350 B) went over in 22 writes,
  the pedal answered type 14 with the cloud's hash, and the library listed it as user capture 2
  (recorded session, not published).
- IRs from Cortex Cloud: implemented from the 2026-10-15 trace and authenticated page inspection (Investigation section 6a). The Cloud profile's Impulse Responses list receives per-row **Send to Nano** buttons; each downloads raw WAV data, sends type 15, waits for type 16, then refreshes type 76/77 so “IRs on pedal” updates. End-to-end pedal verification is still needed.
- Delete a user IR from the pedal: implemented from the decoded type 82/83 exchange (Investigation §6a), with type 76/77 refresh and a right-click **Delete…** action in the IR library list. Hardware verification is still needed; capture deletion remains undecoded.

## 4b. Queue after the first release (in suggested order)

1. Merge the PR stack (#2 → #6), tag v0.2.0, `npm run dist`, install.
2. **Nano presets from Cortex Cloud** (Fable): one PacketLogger trace of the phone app downloading a Nano preset
   (it also brings the captures it depends on); decode, implement next to `pro/transfer.js`.
3. **Slot usage before loading** (Opus): the slot chooser should say which presets use each slot (the phone app
   scans all presets; upstream has `scanSlotUsage`, currently dropped by build-core). Needs a progress UI.
4. **Connect polish** (Opus): keep scanning while the connect card is open instead of giving up after 5 s;
   reconnect automatically after a drop; remember the last pedal.
5. Cab-from-library tone knobs, preset reorder/copy; verify the new Cloud IR send flow on hardware.
5b. Parity with the official app's upload (Sonnet): send `3.2 = hex MD5 of the .cns bytes` in the type-13 message
   (found while porting to Swift; the pedal accepts uploads without it). Add to `pro/transfer.js` + a test.
5c. **Library-referenced captures/cabs** (Opus, done in PR #19): the state dump reports capture position 6 / cab slot 6 (one past
   the range) when a preset uses a capture or IR straight from the library rather than a slot (found during the
   Swift port's slot scan, 2026-10-08; `docs/PROTOCOL-NOTES.md` §8 in the native repo). The pro UI computes slot 26
   and shows nothing sensible; show "From the library: <name>" instead and skip the cab refresh for it.
5d. **Cab mic/position is stored in the cab slot, not the preset** (Opus): a type-94 mic/position write changes
   the slot for every preset that uses it and survives a preset switch without a save (verified 2026-10-08). Say so
   in the inspector before the first write, like the slot chooser does for library loads.
5e. **Context menus** (Opus): right-click on preset rows (Load, Rename…, Save current sound here…), chain nodes
   (Bypass/Enable, Change effect…, Clear slot) and capture/IR slot buttons (Load, Load from library into this slot…).
   Mirrors the native app (parity rule in CLAUDE.md).
5f. **Delete a preset** (Fable, done in PR #20, verified on the pedal 2026-10-09): no message known. One PacketLogger trace of the Cortex Cloud phone
   app deleting a preset, decode, implement in both apps.
5g. **Slot usage scan** (Opus, done in PR #19, not yet run on the pedal): the native app's explicit scan (walk every preset, back to the origin, show which
   presets use each capture/cab slot) — parity.
5h. **Backup/restore, footswitch assignment, setlists, undo/A-B, device & settings pages, preset rearranging
   (needs a trace)**: mirror the native rows 16–22 in the native repo's `PLAN.md`.
5i. **Settings** (Opus, done in PR on `feature/settings`): ⌘, / Ctrl+, (app menu → Settings…, Edit menu on Windows,
   "Settings" in the status bar). Accent colour from Cortex Control's palette (live, stored in `settings.accent`,
   Dock / window icon re-rendered in the accent and cached under `userData/icons/`), metronome defaults and click
   sound (Click, Woodblock, Tick, Beep, Cowbell, synthesized), reconnect to the remembered pedal at launch, Forget
   pedal, Activity drawer at launch, Show recordings folder. **Not yet tried on the pedal**: the launch reconnect.
5j. **Advanced metronome** (Opus, done in PR on `feature/advanced-metronome`): Simple / Advanced switch in the overlay
   (Settings → "Opens in"). Advanced: beats 1–16 over 4 / 8 / 16, accent cells (Accent → Normal → Soft → Mute) with
   presets 4/4, 3/4, 6/8, 5/4, 7/8, 12/8, subdivisions 2 / 3 / 4 with swing, count-in 0–2 bars, tempo trainer, gap
   trainer, Levels… popover (accent / main / subdivisions, also in Settings), bar counter and sub pips. Parity: the
   native app needs the same (`metroBarEvents` is the spec).
5k. **Metronome ↔ preset tempo sync** (Fable, ⚠️ needs a trace): decode the preset tempo (phone-app trace of changing a preset's tempo), then a Settings toggle; mirrors native row 25.
5l. **Discard edits** (Fable, done in PR on `feature/discard-edits`): reload the preset from the pedal (re-select the current slot); outlined Discard button next to Save, shown only when dirty, confirmed in a dialog, also in the current preset row's menu.
5m. **Capture kind icons in the library picker** (Fable, done in PR on `feature/capture-kind-icons`): capture rows show `[type icon] [instrument icon] Author` from `CAPTURE_KINDS` in `pro/ui.js` (our own SVGs, reused verbatim by the native app); unknown words get no icon, stay in the row tooltip and are logged once (`[library] unknown capture kind`), so tell us any you see.
5n. **Metronome overlay layout tidy** (Fable, done in PR on `feature/metronome-layout`): parity with native PR #22. Label left / mode right, bar counter and signature on one line, −/+ around the BPM with a tempo slider, one 30 px control height (steppers, pills, drop-downs, accent cells), shared 3-column grid, trainers on one grid, Volume / Output / Levels… on one baseline.
5o. **Footswitch assignment** (Fable, done in PR on `feature/footswitch-assignment`): Footswitches strip (IA IB / IIA IIB) under the preset list, click loads, right-click assigns the current preset or one from a picker; the preset-row menu has "Assign to footswitch …". With unsaved edits it asks first (the pedal drops them on an assignment). Protocol (INVESTIGATION §8): the preset-change message type 29 with field 4 = −1, the slot's field (5 IA, 6 IB, 7 IIA, 8 IIB) = preset index, the other three −1 and field 9 = 0, acked by type 30. **Not yet tried on the pedal** from this app.
5p. **Preset tempo + metronome sync** (Fable, done in PR on `feature/preset-tempo`; mirrors native row 25, decoded in `INVESTIGATION.md` §9): Tempo field in every inspector's title row (TEMPO label scrubs sideways, − number +, BPM, Tap); −/+/scrub go live (type 145 `3:1`) and commit (`3:0`, dirty) 0.8 s after they settle, Tap 2.6 s, Enter at once, Save flushes a pending commit; shows state-dump field 56 and pedal-side changes (rx 145, not written back). Settings → Metronome → "Follow the preset tempo" (off by default): the metronome plays the preset tempo, its changes go live and commit after 1.5 s, trainer steps live only. Not yet tried on the pedal.
5q. **Expression pedal assignments** (Fable, done in PR on `feature/expression-assignments`): EXP pill ahead of In (count badge, `E`) opens the panel in the inspector; per-preset set read with 60 on every preset load/connect, whole set written with one 62 per edit (sweeps Heel/Toe/Invert, switches Heel-toe/Switch/Stop + Delay/Latch/Invert), dirty → Save; bytes match the phone-app trace (INVESTIGATION §10); parity with the native panel. **Not yet tried on the pedal**: whether Save persists the set, and any target the trace didn't exercise.
5r. **Device page and capture info** (Fable, done in PR on `feature/device-page`, not yet tried on the pedal): Settings gets General / Device tabs; Device reads 65 + 46 + 91 when it opens (About: name, firmware, serial, hash; LED brightness 0–255 as %, USB playback −20…0 dB, one 67 write carrying both, coalesced, nothing sent before a 66 read; Raw settings read-only); "Info…" on the capture node and capture slots sends 17 and shows a popover (author, kind icons, tag chips, description, hash + Copy), greyed out for a library-referenced capture. Protocol in INVESTIGATION §11.
5s. **From #14 by @itsbreaded** (integrated on `feature/pr14-integration`): live pedal sync (`pro/live-sync.js`), Cloud IR send, capture / IR audition with the stop gate, IR delete, preset drag-reorder, monitoring mutes and the header Mute (INVESTIGATION §12). **Hardware verification pending** (checklist in the PR); port to the native app (parity).
6. Sharing prep, only if wanted: Windows build (`.ico`, test Web Bluetooth there), notarised Mac build (paid Apple
   Developer), user-facing README, and a decision on the "keep private" rule in CLAUDE.md.

## 5. Package (Sonnet)

Build an unsigned app for Anup's Mac with the Bluetooth usage strings set (already in `package.json`). On first
launch, right-click the app and choose **Open**.

## Session log

### 2026-10-09 — Advanced metronome (5j)
`pro/ui.js` metronome section rewritten around a pure generator: `metroBarEvents(setup, bar)` →
`[{ offsetBeats, role }]` (roles `ROLE.ACCENT/NORMAL/SOFT/SUB/MUTE`; count-in bars are plain clicks, gap-trainer rest
bars turn every event into `mute` so the indicator keeps running), `metroRampBpm` for the trainer rule, both on
`window.__metro` (generator also on `window.__ui`). `metroTick` merges a list of layers (one today; a polyrhythm
layer spreads over the first one's bar) and only applies trainers in `planBar()` at bar starts. Sound goes through
`soundFor(role)` (synth voice today, a sample source later) × `roleGain(role)` (volume × Levels × trim; subs play the
same voice 1.5× higher). Tempo: `effectiveBpm()` is the one source the scheduler reads (`tempoFollowsPreset` /
`presetTempo` prepared for 5k, not exposed), `setBpm(v, 'user')` calls `metro.onTempoChange` (the future pedal
write). BPM counts the chosen note value. Swing 0–100 % moves the off-beat from 1/2 to 2/3 (16ths: each pair within
its half beat). Stored in the `metronome` key: `opensIn`, `adv`, `levels`; a fresh install is exactly the old
overlay. Settings → Metronome: Opens in, Pattern, Subdivision, Count-in, three levels. 56 UX checks; 308/308.

### 2026-10-09 — Settings (5i)
`openSettings()` in `pro/ui.js`, built on `modal()` (new `cls` and `enterSubmits` options; Tab now cycles inputs
and selects too). **Appearance**: seven swatches; `applyAccent()` sets `--accent`, `--accent-hi`, `--focus` and a
new `--on-accent` (dark text on light accents) on `:root`; the active preset row, its number, TX lines in Activity,
the context-menu highlight and the header mark's LED arc now derive from `--accent` via `color-mix()` (purple
values unchanged). `src/accent-icon.js` renders `assets/icon.svg` with the three LED stops replaced (darker, accent,
lighter) in an offscreen window like `scripts/build-icon.js`, cached per colour; `src/main.js` applies it with
`app.dock.setIcon` / `win.setIcon` at startup (accent kept in `userData/settings.json`) and on change.
**Metronome**: sound, output, volume, default BPM, beats; same `metronome` localStorage key as the overlay, plus
`sound`. **Connection**: the Bluetooth picker now remembers the device it chose (`settings.json` `pedal`) and
prefers it; "Reconnect at launch" asks main to run `connectAll()` with a user gesture (`executeJavaScript(…, true)`),
and in that mode the picker only takes the remembered pedal and never shows a chooser. Outside the desktop app the
toggle is disabled with the reason. **Advanced**: Activity drawer at launch, Show recordings folder. Bridge:
`window.nanoShell` in `src/editor-preload.js`. 32 UX checks (incl. a reload for persistence and the rendered icon's
ring colour); 252/252. **Not yet tried on the pedal**: reconnect at launch and the remembered-device preference.

### 2026-10-09 — Slot usage scan (5g) and library-referenced captures/cabs (5c)
Parity with the native app. Capture inspector → "Usage…" (next to "Load from library…") opens a popover:
"Scan slot usage…" (disabled with the reason while there are unsaved edits, since it switches presets), then the
scan time, "Slot N feeds: …" for the current slot, free capture and cab slots, presets playing a capture / cab
straight from the library, and "Partial scan" if stopped (Stop scan) or a preset didn't answer. `scanUsage()` in
`pro/ui.js` notes the origin, `selectPreset(n)` + `waitForPresetState` for each non-empty preset, reads the slot
from the state, goes back to the origin; progress in the status bar. Result in `ui.usage = { captures, cabs,
library, cabLibrary, date, complete, scanned, total }`; count badges ("3" / "free", tooltip with the presets) on
capture and IR slot buttons and in the slot chooser. 5c: the state-dump wrapper reads fields 9/11/12 before the
core parse; position 6 / cab slot 6 → `state.capture.fromLibrary` / `state.cabIR.fromLibrary`, "From the library:
<name>" on the node and in the inspector, no slot 26, no cab settings request (`requestCabIRParamRefresh` wrapped);
any slot select clears the flags. Also: the absolute capture slot is (bank − 1)·5 + position when names are
missing or two slots hold the same capture. Demo: presets 11–24 sit on other capture slots, Fuzz Wall (9, 19) plays a
library capture, Tremolo Surf (7, 17) a library cab. 31 UX checks; 216/216. **Not yet tried on the pedal**: the
real scan (timing per preset, ~0.5–1 s) and the position-6 parse need a hardware run.

### 2026-10-08 — Save as (another slot)
Anup asked for "save to another slot without overwriting". Added `doSaveAs` / `savePresetAs` in `pro/ui.js`: the
same type-3 write as `savePreset()` with the chosen slot and name (verified on the pedal from the native app:
the live sound lands in the target slot, the source preset keeps its saved state), then `selectPreset(n)`.
Header "Save as…", ⇧⌘S, shortcuts sheet, demo snapshot under the new slot. 9 UX checks; 174/174.


- 2026-10-08: Teardown of Cortex Control 4.1.0 and survey of community editors (`docs/INVESTIGATION.md`). Old step 1
  resolved: JUCE, no Nano support, no Bluetooth. Plan rewritten; stack decision handed to Anup as step 0.
- 2026-10-08 (evening): Phone-app trace captured with PacketLogger; capture upload protocol decoded and implemented
  (`pro/transfer.js`, Send to Nano). UX test 153/153.
- 2026-10-08 (later): First hardware session done on the real pedal (INVESTIGATION §4): everything verified, two
  protocol fixes (cab mic index, gate read-back), recording saved. Dev remote added (`NANO_DEV_PORT`). Cloud tab:
  API mapped, capture bundle format decoded (INVESTIGATION §5). Next: sniff the phone app's transfer.
- 2026-10-08: Step 0 decided (Electron now, Swift later). Step 1 done: DrD85 vendored, acorn-based `build-core.js`,
  preset switching over BLE, rename, tuner, library→slot, device-reported dirty state, coalescing writes; demo mode
  answers typed requests. Session recording (step 2.1) done. UX test 140/140 on macOS. Not yet committed.
