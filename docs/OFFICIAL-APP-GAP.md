# What the official app does that our editors don't (yet)

Written 2026-10-09 for one PacketLogger session with the iOS Cortex Cloud app. Covers the Nano Cortex on NanOS
2.2.1 (the latest release found: 2.2.1, 2025-12-10, a boot fix only [N221]). "Our editors" = this Electron app and
the native Mac edition (`AJs-Creations/nano-cortex-editor-mac`); parity rule: both have the same features unless noted.

Sources (cited by tag below):

- **[M]** Nano Cortex manual, https://neuraldsp.com/manual/nano-cortex (sections: Footswitches, Tempo Mode, Settings,
  Tempo, Tuner, USB MIDI Out, Incoming MIDI, Cloud Backups, Expression Pedal, Presets Library, Neural Capture Library,
  New Neural Capture, Neural Capture Details, Impulse Responses, IR Loader, Firmware Updates)
- **[GP]** "Creating and managing presets", https://neuraldsp.com/getting-started/creating-and-managing-presets-nano-cortex/
- **[GA]** "Using the Cortex Cloud app with Nano Cortex", https://neuraldsp.com/getting-started/using-the-cortex-cloud-app-with-nano-cortex/
- **[N200]** NanOS 2.0.0 notes, https://neuraldsp.com/us/nano-cortex-updates/nanos-2-0-0-is-now-available
- **[N210]** NanOS 2.1.0 notes, https://neuraldsp.com/nano-cortex-updates/nanos-2-1-0-is-now-available
- **[N220]** NanOS 2.2.0 notes, https://neuraldsp.com/nano-cortex-updates/nanos-2-2-0-is-now-available
- **[N221]** NanOS 2.2.1 notes, https://neuraldsp.com/us/nano-cortex-updates/nanos-2-2-1-is-now-available
- **[SOS]** Sound On Sound, NanOS v2.0 & v2.1 review, https://www.soundonsound.com/reviews/neural-dsp-nanos-v2-0-v2-1
- **[F-NAME]** Forum, "Nano Cortex - Preset Name Bug" (2024-11-12), https://unity.neuraldsp.com/t/nano-cortex-preset-name-bug/16117
- **[F-SAVEAS]** Forum, "Edit a preset and save as at another storage place" (2026-01-29), https://unity.neuraldsp.com/t/edit-a-preset-and-save-as-at-another-storage-place/21037
- Our side: `docs/HANDOFF.md`, `docs/INVESTIGATION.md`, `PLAN.md` and `docs/PROTOCOL-NOTES.md` in the native repo.

Status key. **Ours**: done / partial / missing / n/a (not something a desktop BLE editor should do). **Protocol**:
decoded (we build the bytes and the pedal accepted them) / upstream (DrD85's editor builds it, never run on Anup's
pedal by us) / observed (seen in a trace, layout not understood) / unknown.

## (a) Feature inventory

### Presets and footswitches

| Feature | What the official app does | Ours | Protocol | Trace? | During the capture |
|---|---|---|---|---|---|
| Load preset | Tap a preset [GP] | done | decoded (29/30) | no | — |
| Footswitch-initiated preset change | Pedal tells the app, app acks [M] | done (ack path coded, not yet seen on hardware: HANDOFF §2) | upstream (29 in, 30 out) | yes (cheap) | Press Footswitch I on the pedal while connected |
| Save (overwrite) | Hold SAVE 3 s on the pedal, or app save [GP] | done | decoded (3/4) | no | — |
| Create new preset / Save as | "Create New Preset…" or load an empty slot, then SAVE + name [GP]; app menu has "Save as…" [F-SAVEAS] | done (Save as… into any slot) | decoded (3/4) | optional | Create New Preset in slot 63, so we see if the app sends anything besides type 3 |
| Rename | Context menu RENAME PRESET [M][GP] | done | decoded (111/112) | no | — |
| Delete | Context menu DELETE PRESET [M][GP] | done | decoded (50/31/51) | no | Used for clean-up only |
| Discard edits | Not in the app (edits are dropped on preset change) | done (ours) | decoded (re-select) | no | — |
| Assign to footswitch | ASSIGN TO FOOTSWITCH → IA/IB/IIA/IIB; one preset may sit on several switches [M][GP] | missing (native PLAN row 17; neither UI shows the assignments) | upstream: state fields 14/15/38/39 read; type 29 fields 5–8 are sent as −1 ("unchanged"), real values never sent | **yes** | Assign preset 63 to IIB, then put the original back |
| Rearrange (drag and drop) | Tap-and-hold, drag to another slot; "MIDI CC unchanged", PC follows the slot [M]; new in 2.2.0 [N220] | implemented (#14): drag a preset row; list and state read back after | decoded (143/144, insertion; INVESTIGATION §12) | done | Verify on hardware, with footswitches |
| Show all presets / PC-CC view | Single-screen list; PC/CC button shows PC numbers per slot [M] | done (our sidebar lists all 64; PC = slot − 1) | n/a | no | — |
| Copy / duplicate | No explicit command in [M]/[GP]; Save as is the route. Duplicated names link slots together [F-NAME] | partial (Save as) | decoded | no | — |
| Scenes / stomp mode | **None.** [M] documents only 4-Preset Mode (IA/IB/IIA/IIB) and 2-Preset Mode (Footswitch II = global bypass). Scene/stomp forum threads are about Quad Cortex | n/a | — | no | — |
| Setlists | Not in the app | n/a (ours planned: native row 18) | — | no | — |
| Looper | **None** in [M] or any release note | n/a | — | no | — |
| Presets from Cortex Cloud | Unclear: [M] says with Nano selected the Cloud shows "compatible captures, users" (no presets) | missing (HANDOFF 4b.2, native row 10) | unknown | check | If the app offers a Nano preset download, do one; otherwise note that it doesn't |

### Signal chain (per preset)

| Feature | What the official app does | Ours | Protocol | Trace? | During the capture |
|---|---|---|---|---|---|
| Input gate on/off + amount 0–100 % | Fixed gate before pre FX 1 [N200][M] | done | decoded | no | — |
| Capture: select slot / bank, bypass | 25 slots in 5 banks, swap, bypass [M] | done | decoded | no | — |
| Capture volume −24…+12 dB | Slider [M] | done | decoded | no | — |
| Amp knobs Gain/Bass/Mid/Treble/Level | [M] | done | decoded | no | — |
| Pre FX ×2, post FX ×3: model, params, bypass, Amount | Device lists per slot; slot rules (transpose pre 1 only, mod/doubler post 1, delay post 2, reverb post 3) [SOS][N200] | done | decoded | no | — |
| Delay/mod "Sync" to tempo | Sync parameters on time-based effects [M] | done as plain FX params (no tempo shown) | decoded (param) | no | — |
| IR: slot, bypass, level, HPF, LPF | IR Loader screen [M] | done | decoded | no | — |
| IR: microphone + 6 mic positions | Factory IRs only, not user IRs [M] | done (slot-wide, DECISIONS #11) | decoded (94/96) | no | — |
| **IR phase invert** | PHASE button on the IR Loader screen [M] | missing | unknown | **yes** | On preset 63: phase on, then off |
| Cab from the library (no slot) | [M] IR LIBRARY | partial (shown, tone knobs stale: HANDOFF §2) | decoded (78/79) | no | — |
| Expression assignments (per preset) | Up to: GAIN/BASS/MID/TREBLE/AMOUNT/LEVEL with range + reverse; slot bypass for CAPTURE/IR/FX with SWITCH/STOP/HEEL-TOE, latch emulation, switch delay ≤ 2000 ms [M] | missing (UI) | upstream (60/61/62, DrD85's EXP panel; dropped by build-core) | **yes** (to confirm upstream bytes) | On preset 63: add a GAIN 20–80 % range, add an FX-slot bypass, delete both |
| Expression calibration | RECALIBRATE heel→toe, SAVE [M] | missing | unknown | only if a pedal is plugged in | Recalibrate (needs an expression pedal in EXP/MIDI) |
| Tempo: BPM, tap pad, knob | Tempo screen [M][N210] | missing (our metronome is local) | unknown (state field 56 = f32 120.0 is a guess) | **yes** | BPM 120 → 100, four taps, back to 120 |
| Tempo mode: global vs per preset | TEMPO MODE [M][N210] | missing (HANDOFF 5k, native row 25) | unknown | **yes** | Global → Preset → Global, on preset 63 |
| USB MIDI Out per preset | Up to 12 CC/PC messages on preset load (channel, CC#/value, bank 0/32 + program) [M] | missing | unknown | **yes** | On preset 63: add CC 20 = 1 on channel 16, delete it |
| USB MIDI Out per footswitch | Up to 12 messages per footswitch [M] | missing | unknown | **yes** | Add one footswitch message, delete it |

### Device settings (app ⋯ menu → Settings) [M]

All of these are global, not per preset. Type 65 → 66 is the global read; the two monitoring writes are now confirmed
as standalone type-67 field 12/13 commands with type-66 readback fields 15/16 and type-68 ACKs. Our Settings window
separates these pedal settings from preset settings.

| Setting (default) | Ours | Protocol | Trace? | During the capture |
|---|---|---|---|---|
| Device name (≤ 22 chars) | missing | unknown | **yes** | Rename to "GapTest", then back (do it last; may change the advertised name) |
| Storage (free space) | missing | observed? (unknown which message) | yes (read) | Open Settings and wait |
| LED brightness (60 %) | missing | unknown | **yes** | 60 → 80 → 60 |
| USB playback volume (−6.0 dB) | missing | unknown | **yes** | −6 → −3 → −6 |
| Analog outputs auto-sum [N220] | missing | unknown | **yes** | off → on (restore) |
| Preset operation mode: 4-Preset / 2-Preset | missing | unknown | **yes** | 4 → 2 → 4 |
| Knob operation mode: immediate / latching | missing | unknown | **yes** | toggle, toggle back |
| IR bypass on output 1L / 2R / global [N210] | missing | unknown | **yes** | Bypass 1L, un-bypass |
| Trails (no effect in 4-Preset mode) [N210] | missing | unknown | **yes** | toggle, toggle back |
| EXP/MIDI input: expression / MIDI | missing | unknown | **yes** | EXP → MIDI → EXP |
| MIDI channel 1–16 | missing (read only, upstream) | upstream read (66 f8); write unknown | **yes** | 1 → 2 → 1 |
| MIDI Thru (TRS → USB) | missing | unknown | **yes** | on → off |
| MIDI clock source OFF / USB / TRS | missing | unknown | **yes** | OFF → USB → OFF |
| Mute guitar input / mute guitar output | done (Settings → Device: Mute Input / Mute Outputs 1L/2R) | 67.12 → 66.15; 67.13 → 66.16; type-68 ACK | **yes** | each on → off (output mute silences the rig) |
| About: NanOS version, serial | partial (firmware shown from the state dump) | observed (46/47) | no (already in traces) | Open About |
| Factory reset | n/a (**never trace**) | — | **no** | Don't |
| Firmware update | n/a (app-only, over BLE; nothing to update past 2.2.1) | — | **no** | Don't |

### Tuner

| Feature | What the official app does | Ours | Protocol | Trace? | During the capture |
|---|---|---|---|---|---|
| Tuner on/off, note/cents | [M] | done | decoded (127/128) | no | — |
| Reference 400–480 Hz (440) | [M] | done | decoded (127 f5) | no | — |
| Mute while tuning | MUTE toggle [M] | partial (we send muted=1; no toggle) | decoded (127 f7) | no | — |
| Tuner started on the pedal (hold Footswitch II) | [M] | done (upstream parses it) | upstream | optional | Hold Footswitch II, then exit |

### Captures, IRs and the Cloud

| Feature | What the official app does | Ours | Protocol | Trace? | During the capture |
|---|---|---|---|---|---|
| Library → slot (captures and IRs) | Swap / IR LIBRARY [M] | done | decoded (76–81) | no | — |
| Download a capture from Cortex Cloud | Download button [M][GA] | done (Send to Nano) | decoded (13/14) | no | — |
| Download a user IR from Cortex Cloud | Profile → Impulse Responses → Download [M] | implemented: per-row Send to Nano action; refreshes “IRs on pedal” after type 16 | Cloud list/download API verified; BLE decoded (15/16, 76/77) | **yes** | Needs an end-to-end check with a connected pedal |
| Audition a capture / IR before downloading | Play button; slots pulse; EXIT or Stop ends it; pedal caches several [M][N220] | implemented (#14): Live Preview in the Cloud toolbar, ▶ on library IRs; stopped before any save or preset change | decoded (150/151, 158/159, 148/149, keep-alive 91/92; INVESTIGATION §12) | done | Verify on hardware |
| Delete a capture / IR from the pedal | Capture details → ⋯ → DELETE [M][GA] | implemented for user IRs: right-click a library item → Delete; capture deletion remains open | IR: decoded (82/83, then 76/77); capture: unknown | **yes** | Verify IR deletion on hardware; capture deletion still needs a trace |
| Edit capture details (name, type, description, instrument) | EDIT, own captures only [M] | missing | unknown | optional | Only if Anup has a capture of his own |
| Upload capture to Cloud, visibility, send to a friend | Capture details [M] | n/a (Cloud-side, our Cloud tab has the website) | — | no | — |
| Create a Neural Capture (≈ 5 min, needs a target device) | Guided flow: calibration, capture gain ≤ +24 dB, metadata, A/B compare, save to slot / library [M] | missing | unknown | **no** (needs a target rig; separate session) | — |
| Capture V2 playback | Pedal-side [N220] | done implicitly (we only move files) | — | no | Check the library parse on a V2 capture if one is on the pedal |
| Cloud backups (≤ 5): create, rename, update, download (restore), delete | ⋯ → Backups [M][N220]; SAVE ring spins while it runs | missing (ours planned: local file backup, native row 16) | unknown | **yes** (create only) | Create backup "GapTest", then delete it in the app. **Do not restore** |
| Offline mode (settings without login) | [N220] | n/a (we never need a login for the pedal) | — | no | — |

### Pedal-only things (no app involvement, listed for completeness)

Tap tempo by holding Footswitch I; tuner by holding Footswitch II; Parameter Lock (hold EXIT 3 s); capture-volume /
gate mode (hold CAPTURE 2 s); pairing (EXIT + CAPTURE 1 s) [M]. USB is a class-compliant audio interface (24-bit,
48 kHz, 4 in / 3 out) and receives MIDI PC 0–63 and CC 1, 34–43 [M]. None needs a BLE trace, but the pedal probably
*notifies* the app for tap tempo and tuner, which the capture below includes.

## (b) Capture session checklist

One PacketLogger session, iOS Cortex Cloud app, NanOS 2.2.1. Prepare:

- Back up the presets first (the session itself never restores anything). Screenshot the app's footswitch
  assignments and every Settings value before you start, so you can put them back.
- On the Cortex Cloud **website**, upload one throw-away IR (any short WAV) named "GapTest IR" (needed for step 22).
- Presets 62, 63 and 64 should be empty. The test presets get **unique** names ("GapTest A", "GapTest B"): the
  pedal links presets that share a name [F-NAME].
- **Pause about 5 s between actions** and **say the step number and the time out loud, or write it down** (or tap
  a note on another device), so the trace can be split per action. Do one thing per step; don't touch anything else.

1. Start PacketLogger, open the app, connect to the pedal. Wait 10 s doing nothing (baseline: keep-alive, device
   info, settings read).
2. Press **Footswitch I** on the pedal once, wait, press it again (device-initiated preset change and the app's ack).
3. In the app, **Create New Preset…** into slot 63; name it "GapTest A"; save.
4. **Save as** into slot 64, name "GapTest B" (the ⋯ "Save as…" route, if it lets you pick a slot).
5. Load preset 63.
6. **IR phase**: open the IR Loader, phase on. Wait. Phase off.
7. **Tempo**: open Tempo. BPM 120 → 100 with the knob (one step at a time is fine), wait, then tap the pad 4 times
   at a steady pace, wait, set it back to 120.
8. **Tempo mode**: Global → Preset, wait, Preset → Global.
9. Back to Tempo mode Preset, set 90 BPM, **save** preset 63, then set the mode back to Global (tells us whether
   the tempo lives in the preset's save).
10. **Expression**: Expression Pedal → assignments for preset 63: add GAIN with range 20–80 %. Wait. Add a bypass
    assignment for one FX slot (HEEL-TOE). Wait. Delete both.
11. (Only with an expression pedal plugged in) **Recalibrate**, rock heel → toe, SAVE.
12. **USB MIDI Out**, Preset Load: add CC #20 value 1 on channel 16. Wait. Delete it.
13. **USB MIDI Out**, Footswitches: add one CC #21 value 1 on channel 16 to one footswitch. Wait. Delete it.
14. **Assign to footswitch**: put "GapTest A" (63) on IIB. Wait. Put the original IIB preset back.
15. **Drag and drop**: drag 64 "GapTest B" onto the empty slot 62. Wait. Drag it back to 64. (Note whether the app
    calls it a move or a swap.)
16. **Settings**, one change at a time, each reverted before the next: LED brightness 60 → 80 → 60; USB playback
    volume −6 → −3 → −6; auto-sum toggle and back; 4-Preset → 2-Preset → 4-Preset; knob mode toggle and back;
    IR bypass on output 1L and back; Trails toggle and back; EXP/MIDI input → MIDI → expression; MIDI channel 1 → 2 →
    1; MIDI Thru toggle and back; MIDI clock source → USB → OFF; Mute guitar input on → off; Mute guitar output on →
    off. Say each name out loud as you go.
17. Open **About** and the **Storage** view; wait.
18. **Tuner** in the app: open, change the reference 440 → 441 → 440, toggle MUTE, close.
19. Hold **Footswitch II** on the pedal (tuner on the pedal), then exit it there.
20. Hold **Footswitch I** on the pedal (tempo mode), tap it 4 times, exit with Footswitch II.
21. **Audition**: in Cloud search, press Play on one capture for ~5 s, Stop. Then Play on one IR for ~5 s, Stop.
22. **Download "GapTest IR"** from your profile's Impulse Responses to the Nano.
23. **Delete "GapTest IR"** from the Nano.
24. **Delete one capture** from the Nano's library that you don't need (e.g. one of the test sends, "Klon Centaur 1"
    or "Darkglass AO900 1"; it stays in the Cloud's downloaded list and can be sent again).
25. (Only if you own a capture) **Edit** its details: change the description, save, change it back.
26. (If the app offers one with Nano selected) **Download a Nano preset** from the Cloud into an empty slot. If the
    Cloud has no Nano presets, write that down.
27. **Cloud backup**: Backups → CREATE NEW CLOUD BACKUP, name "GapTest"; wait until the SAVE ring stops. Then delete
    that backup in the app. **Never tap DOWNLOAD (restore) on a backup.**
28. **Device name**: rename to "GapTest", wait, rename back to the original.
29. Clean-up: delete presets 63 and 64 (and 62 if something landed there); check the footswitch assignments and
    Settings against your screenshots. Stop PacketLogger.

Never during this session: Factory Reset, Firmware Update, restoring a backup, Create Neural Capture.

Afterwards, extract C304/C305 to JSON locally (mask the serial). Never commit the `.pklg` or the JSON; recordings stay
off the repository.

## (c) Open questions (sources disagree or are silent)

1. **Drag and drop: move or swap?** [M] says drag "to reassign it to a different Preset slot" and MIDI CC stays; it
   doesn't say what happens to an occupied target. Step 15 uses an empty target; a second drag onto an occupied
   slot would answer it.
2. **Save as.** [GP] documents "Create New Preset…" (load an empty slot, then SAVE); a forum user (2026-01-29)
   reports the ⋯ "Save as…" just overwrote the current slot [F-SAVEAS]. Our Save as (type 3 to another slot) is
   verified on the pedal, so this only matters for parity of wording.
3. **Duplicate names.** [F-NAME] (2024-11) says the pedal keys presets by name, so duplicates are linked;
   [N210] lists "prevented duplicate preset names" as a fix. Unverified whether 2.2.1 rejects a duplicate name on
   save/rename, accepts it, or links. Our Rename and Save as don't check. Worth one deliberate test on 62/63.
4. **Nano presets on Cortex Cloud.** [M] says the Cloud shows the Nano "compatible captures, users" (presets only
   for Quad Cortex), but HANDOFF 4b.2 / native row 10 plan a "Nano preset download" trace. Possibly the feature
   doesn't exist; step 26 settles it.
5. **Tempo storage.** [M] and [N210] confirm global vs per-preset tempo; where the per-preset tempo lives is
   unknown (state dump field 56 = f32 120.0 is a guess, PROTOCOL-NOTES §7). Step 9 checks whether it is saved with
   the preset.
6. **Capture library deletion.** IR deletion is type 82/83 (decoded in Investigation §6a); capture deletion remains unknown (step 24).
7. **IR download path.** Resolved: raw WAV uses type 15/16 and library refresh uses 76/77 (Investigation §6a).
8. **Audition.** Resolved (#14): a capture is streamed as type 150 (not 13), a library IR is played with 158, both
   stop with 148 → 149 and need the 91 keep-alive (Investigation §12).
9. **Footswitch fields.** Type 29 fields 5–8 are the assignment fields per DrD85, and the state dump reports them
   in 14/15/38/39; the order (IA/IB/IIA/IIB vs A1/B1/A2/B2) and whether 2-Preset mode reuses them are unverified
   (step 14).
10. **Expression assignments.** DrD85's 60/61/62 implementation exists upstream; never run by us on Anup's pedal.
    [N220] fixed "expression pedal assignments" bugs, so behaviour may have changed since DrD85 wrote it.
11. **Firmware.** No release after 2.2.1 (2025-12-10) was found on https://neuraldsp.com/news as of 2026-10-09.
    The Sweetwater 2.2.0 article (403 to our fetch) also lists "Cortex Cloud Offline Mode" and "Capture Auditioning";
    consistent with [N220].
12. **Scenes.** Not a Nano feature per [M]; search results mentioning scenes/stomp are Quad Cortex threads. If the
    app shows anything scene-like for the Nano, note it.
