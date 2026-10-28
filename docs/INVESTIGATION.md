# Investigation: Cortex Control, USB, and the state of the community protocol

Done 2026-10-08 against `Cortex Control v4.1.0.pkg` (kept untracked in the repo root; `*.pkg` is ignored).
Everything below was read from the binary, Neural DSP's docs, and the public community repos. Nothing has
been verified against Anup's pedal yet.

## 1. Cortex Control 4.1.0 teardown

| Question | Finding |
|---|---|
| Tech stack | **JUCE 8, C++.** One 100 MB universal (arm64 + x86_64) binary, no `Frameworks/` folder, namespaces `neural::cortex`, `neural::mvc`, `juce::`. UI is JUCE components driven by embedded XML layouts (`presetModel.xml`, `ioSettingViewController.xml`, …). Built on Jenkins (`rol_native_cortexcontrol_develop`). |
| Linked system frameworks | IOKit, CoreMIDI, CoreAudio, AudioToolbox, WebKit, AVFoundation, Metal. **No CoreBluetooth, no IOBluetooth.** |
| Device transport | **USB HID via hidapi** (`hid_open_path`, `IOHIDDeviceSetReport`, "No HID devices with requested VID/PID found"). Hotplug scanner matches `NeuralDSP Quad Cortex`, `NeuralDSP Quad Cortex mini`, `NeuralDSP USB Audio Device`. |
| Wire format | Google protobuf, package `cortex_protobuf_v2`, descriptors embedded (`Preset.proto`, `ProductionAutomation.proto`). 72 message types (`Grid`=1 … `ModelPreset`=71), e.g. RecallPreset, Tuner, Scene, Looper, CloudProduct, LocalBackup, NeuralCapture. |
| Nano Cortex support | **None.** Zero occurrences of "nano" in 821 k strings. Manual links and copy only mention Quad Cortex and Quad Cortex mini. |
| Entitlements | audio-input, apple-events (Mail compose), unsigned-executable-memory. Not sandboxed. |

Consequences:

- The handoff's step 1 table says JUCE. JUCE has no BLE GATT client, so a JUCE port of this app would need a
  CoreBluetooth bridge in Objective-C++ on top of a C++ UI toolkit. That is the most expensive target on the list.
- Cortex Control's protocol is Quad Cortex only (HID + protobuf v2). It is **not** a route to editing the Nano
  over USB, and its message set does not match the Nano's BLE framing (see §3).
- The only thing worth borrowing from it is the information architecture, not code or protocol.

## 2. Can the Nano be controlled over USB?

Sources: Neural DSP manual ([MIDI on Nano Cortex](https://neuraldsp.com/getting-started/using-midi-on-nano-cortex), [manual](https://neuraldsp.com/manual/nano-cortex)), [rixrix/deskop-nano-cortex](https://github.com/rixrix/deskop-nano-cortex) USB probes, [Unity forum](https://unity.neuraldsp.com/t/make-the-nano-cortex-compatible-with-cortex-control/15907).

- The Nano is a class-compliant **USB audio + USB MIDI** device. No vendor control interface is documented, and
  no desktop app (official or community) edits it over USB.
- Over USB MIDI it **accepts**: Program Change 0–63 (presets), CC 34 gate bypass, CC 35 capture bypass, CC 36
  cab/IR bypass, CC 37–41 FX slots 1–5 bypass (0–63 off, 64–127 on), CC 42 tap tempo, CC 43 tuner, CC 1
  expression. MIDI channel 1–16 (set on the pedal).
- Over USB it **sends nothing back** that is useful: rixrix logged zero MIDI bytes from the pedal. No state,
  no names, no parameters.
- So USB is one-way, coarse control. Everything else (reading state, knobs, models, names, save, rename, tuner
  readout, library) is **BLE GATT only** (service A002/A003, write C304, notify C305).
- The editor does not need the Nano as an audio interface, so there is no
  reason to plug in USB except as an optional MIDI fallback. A USB cable is not needed for any feature below.

## 3. The community protocol has moved past what we vendored

| Repo | License | Last push | What it is |
|---|---|---|---|
| [choldy/nano-cortex-web-editor](https://github.com/choldy/nano-cortex-web-editor) | MIT | 2026-06-22 | Our current `editor/index.html`. Unchanged upstream since we vendored it (md5 matches). |
| [DrD85/nano-cortex-editor](https://github.com/DrD85/nano-cortex-editor) | MIT | 2026-10-08 | **A superset of choldy's**: 113 of choldy's 116 functions kept, ~130 added. Single `index.html` (285 KB script, 188 KB CSS, embedded font) plus an Electron 44 Mac shell. v1.5.2. |
| [rixrix/deskop-nano-cortex](https://github.com/rixrix/deskop-nano-cortex) | Apache-2.0 | 2026-10-05 | Rust + Tauri 2. Separate BLE encoder/decoder (`ble_encoder.rs`, `ble_schema.rs`) and USB/BLE probe binaries. Good second source for packet layouts. |

What DrD85 adds over our protocol layer (all over BLE, no MIDI):

- **Framing is now understood**: `[len = frame.length − 2] C0 [protobuf payload] [u32 LE message type]`.
  Our core treats the trailing bytes as opaque; DrD85 names them.
- **Preset switching over BLE**: `SetPresetSlotsRequest` (type 29) with `{3: context=PlayMode, 4: presetIndex,
  5–8: footswitch slots = −1, 9: currentSlot}`; device-initiated changes arrive as the same type and must be
  acked with `SetPresetSlotsResponse` (30) `{4: status=1}`. **This removes the MIDI requirement entirely.**
- **Rename** `RenamePresetRequest` (111) `{1: action=UPDATE, 3: index, 4: name}` → response 112.
- **Tuner** `TunerMode` (127) `{4: on, 5: baseFreq f32, 6: liveTuner, 7: muted}`, readings via `TunerMetering` (128).
- **Device library**: `RetrieveLibraryContent` (76/77) lists factory + Cortex Cloud captures and IRs already on
  the pedal; `SetCaptureSlotContent` (80/81) and `SetCabinetSlotContent` (78/79) load one into a slot.
- **Expression assignments** (60/61/62), **device settings** (65/66), **dirty-state notifications** (115).
- **Coalescing write queue**: one GATT write in flight, knob writes keyed per parameter so only the latest
  value is pending. This is the "responsiveness" item from the handoff, already done.
- Save-with-name frame confirmed by rixrix: `LEN C0 08 01 18 <slot> 2A <len> <name> 03 00 00 00`.
- Preset export/import as files, MIDI Learn for external controllers, MC6 Pro bank export.

Still not available anywhere: pushing a capture or IR **from Cortex Cloud** into a slot (only items already in
the pedal's library can be loaded), preset reorder/copy, and bulk backup (DrD85's per-preset export gets close).

## 4. Verified on the pedal (2026-10-08, firmware 2.2.1, factory-stock Nano)

Recording: a session recorded with this app (not published). Everything below was observed, not inferred.

| Action | Request | Pedal's reply | Result |
|---|---|---|---|
| Preset change | type 29 `SetPresetSlotsRequest` | `06 C0 08 01 1F…` (31), then type 30 `{4: 1}` "confirmed", then type 115 dirty=false | Works, 13/13. Pedal re-reads cleanly. |
| Amp knob / capture volume / FX param / bypass | legacy frames (types 26, 31, 99…) | type 115 `{3: 1}` (preset now dirty) | Works, audible. |
| Save | `LEN C0 08 01 18 <slot> 2A <len> <name> 03 00 00 00` | type 4 `{3: slot, 4: 1}`, then type 115 with no field 3 (clean) | Works; read-back matched every edit. |
| Rename | type 111 `{1: 1, 3: slot, 4: name}` | type 112 `{3: slot, 4: 1}` | Works. |
| Tuner | type 127 `{4: 1, 5: f32 440, 6: 1, 7: 1}` | pedal echoes type 127 with its state | Works; metering (128) only arrives while a string sounds. |
| Library capture → slot | type 80 | type 115 (dirty) then type 81 `{3: 1}` | Works. |
| Library cab → slot | type 78 | type 79 `{3: 1}` | Works. |
| Cab level | type 94 float | read-back (type 96) shows the new level | Works. |
| **Cab mic / position** | type 94 record `{1: libraryIndex, 2: cabName, 3: pos−1, 4: micName}` | read-back shows the new mic | **Upstream sends `1: 0` and the pedal ignores it.** With the cab's index in the pedal's factory IR library (field 1 of the type 96 record, e.g. 5 for "412 Brit TV GB75Hz '69") it works. Fixed in `pro/ui.js`; worth sending upstream. |
| Gate on + reduction | types 31 and 26 | state dump field 54 absent = on; **field 53 = f32 `(percent + 108) / 255`** | Works. Upstream doesn't read field 53; `pro/ui.js` does. |

Other notes:

- A preset whose cab comes from the library (not one of the 5 slots) skips the cab tone read (`Cab/IR param refresh skipped: current slot is library/unknown`). Its level/HPF/LPF knobs are stale until that is handled.
- Connect: the pedal only advertises when it is in pairing mode the first time; after that the auto-pick finds it within the 5 s scan.
- Unsaved edits are discarded by the pedal on preset change and on power-off, as in the official app.

## 5. Cortex Cloud web API (observed from the app's Cloud tab, 2026-10-08)

The website is a React app over `https://cloud-api.neuraldsp.com`. After login the token lives in the cookie
`WEB_API_ACCESS_TOKEN`, so `fetch(..., { credentials: 'include' })` from the Cloud tab is authenticated. Routes seen
in the bundle: `/login/v1/validate`, `/api/v1/user/signin|signout|profile|refresh_token`, `/homefeed/v1`,
`/search/v1/for/{preset|neuralCapture|impulseResponse|user}?page=&query=&sort=&sortDir=&size=`, `/api/v1/products/{id}`,
`/api/v1/user/downloaded_products/{id}` (the site's "Download" button: marks the item for the user's devices),
`/api/v1/user/downloaded_products_history/…`, `/api/v1/user/products/…` (own uploads).

**The capture file itself:** `GET /api/v1/products/{id}/download` → `{ id, name, payload, payload_hash }`.
`payload` is base64 of a gzip'd **tar** containing:

- `<hash>.cns` — the Neural Capture (example: 10 350 bytes, entropy 7.98 bits/byte: encrypted or compressed), and
- `<hash>.json` — metadata: `name, authorName, authorId, cloudUUID, hash, deviceType, instrumentType, gainType,
  tags, date, description, version: "1", encryption: "Local", parametersBlockLength: "10340",
  path: "/media/p4/Captures/My Captures/<hash>.cns"`.

`hash` is the 64-hex id the pedal's own library uses (field 1 of each capture record in `RetrieveLibraryContent`),
so matching cloud items to what is already on the pedal is a string compare. `payload_hash` is just SHA-256 of the
base64 text. `compatibility` on the product record lists `quad`/`native` (and presumably `nano`).

Not yet known: how the phone app streams the tar (or its two files) into the pedal over C304. Nothing in either
community project does this. One sniffed transfer from the phone app is enough to decode it.

Side effect of the probe: the probed capture lands in the account's cloud Downloads list (reversible from the
same button). Capture bundles are never committed.

## 6. Capture transfer over Bluetooth (decoded from the phone app, 2026-10-08)

Source: a recorded phone-app session, not published, the C304/C305 packets extracted from a PacketLogger trace of the iOS Cortex Cloud app sending
two captures ("Dumbbell ODS 15", 19 811-byte `.cns`; "68 Purple Plexi Dirty", 10 350 bytes) to the Nano. GATT handles
in the trace: 0x36 = C304 (write), 0x38 = C305 (notify), MTU 517. The raw `.pklg` is not kept (it carried the phone's and
pedal's Bluetooth addresses and the pedal's serial), and neither is the extracted JSON.

**Streaming.** Any message is `protobuf body + u32 LE type`. If it fits in one write it is the familiar
`[len] C0 [body] [type]`. Otherwise it is cut into 500-byte writes with a 2-byte header `[len & 0xFF, flags]`:
`flags = 0x40 first | 0x80 last | (len >> 8 & 1)`. (So `C0` = first+last, and `C1`/`81`/`41` just mean the chunk
is longer than 255 bytes.) The app pads the last write to 500 bytes. The pedal's big replies (`FE 41 …`, `FE 01 …`,
`CE 80 …`) use exactly the same scheme, which upstream calls the "FE stream".

**Upload, type 13** (phone → pedal):

```
{ 1: 6, 3: { 1: <.cns bytes>, 2: hex MD5 of the .cns bytes }, 4: CaptureRecord }   (MD5 found later; optional for the pedal)
CaptureRecord { 1: hash, 2: name, 3: cloudUUID, 4: { 1: authorId, 2: authorName }, 5: description,
                6: deviceType ("amp_head" | "default" | …), 7: tags (repeated), 8: gainType, 10: instrumentType,
                12: version (string) }
```

All of it comes straight from the bundle's `.json` (§5). The pedal replies with **type 14**:
`{ 1: 6, 3: status (1 = ok), 4: { 1: userIndex, 2: name, 3: hash } }` about 0.5 s after the last write.
The app then re-reads the state (type 1 `{1: 3, 3: 1, 4: 0, 5: 1}`), re-reads the library (type 76 with only
`5: userCaptures`), and finally loads the capture into a slot with the already-known type 80
`{3: slot − 1, 5: { 1: userIndex, 2: name }}` → type 81 `{1: 6, 3: 1}`.

Also seen in the trace, not needed yet: type 46/47 (device info; firmware "2.2.1", serial), 54/55, 65/66 (settings),
91/92 (keep-alive every 20 s with firmware "2.2.1+06d34443"), and 152/153 + 164/165 (per-slot queries with a
millisecond timestamp, answered "Slot is empty").

Implementation: `pro/transfer.js` (`NanoTransfer.uploadCapture`), the "Send to Nano" button in the Cloud tab
(`src/main.js` fetches and unpacks the bundle with the Cloud session and hands it to the editor through
`src/editor-preload.js`), and `receiveCapture()` in `pro/ui.js`.

## 6a. IR download from Cortex Cloud to the pedal

Source: a contributor's iOS Bluetooth HCI capture (2026-10-15, firmware 2.2.1; not published). It holds Bluetooth
traffic only, no Cortex Cloud HTTPS, and one successful user-IR download to the pedal.

The phone streams **type 15** to C304 using the same 500-byte chunk framing described above:

```
{ 1: 6,
  3: { 1: <WAV bytes>, 2: <32-character lowercase MD5 hex of WAV bytes> },
  4: <36-character Cortex Cloud product UUID>,
  5: <filename ending in .wav> }
```

The observed WAV is 4,154 bytes: mono, 48 kHz, IEEE float32, 1,024 samples. The MD5 in field 3.2 matches the WAV
bytes. The pedal replies with **type 16** `{1: 6, 3: 1, 4: {1: userIRIndex, 2: name}}` (field 3 = 1: accepted). The
app then reads the current state (type 1), asks for the user IRs only (type 76 with field 6 set) and gets the updated
library (type 77), where the new name sits at the index type 16 gave. No type 13 capture upload or type 78 slot load
is involved: the IR lands in the library, and putting it in a slot is a separate step.

This confirms the Bluetooth transfer protocol, WAV packaging, MD5, product identifier, acknowledgment, and library refresh.

The authenticated Cloud Impulse Responses page was inspected in Chrome on 2026-10-15. Its account list uses
`GET /search/v1/for/impulseResponse?...&ownedByMe=true...`; each paginated result includes `productId` and `name`.
`GET /api/v1/products/{id}/download` returns `{ id, name, payload, payload_hash }`. For an IR, `payload` is
base64-encoded raw RIFF/WAVE bytes (not a gzip/tar bundle). The verified sample was 4,154 bytes, mono, 48 kHz,
IEEE float32, matching the IR in the Bluetooth trace. The pedal expects an MD5 of the decoded WAV, so the editor
computes it locally instead of passing through Cloud's `payload_hash`.

The app injects a **Send to Nano** action on each IR row of the account page (only on a Cortex Cloud host and that
path), fetches the WAV through the embedded Cloud session, checks it (`src/cloud-ir.js`: at most 1 MB decoded; a
`fmt ` chunk with PCM 16/24/32-bit or float 32/64-bit, 1–2 channels, 8–192 kHz; a non-empty `data` chunk), confirms
the transfer in the Pro Editor, sends type 15, waits for type 16 and reads the library again (76/77). Code:
`src/main.js`, `src/cloud-preload.js`, `src/editor-preload.js`, `pro/transfer.js`, `pro/ui.js`. Not yet verified end
to end with a pedal.

### Deleting an IR from the pedal

Source: a local BLE capture of the iOS Cortex Cloud app deleting one user IR from a Nano Cortex
(firmware 2.2.1; not published). The app sends **type 82** with `{1: 2, 4: {1: libraryIndex, 2: name}}`, e.g.
`{1: 2, 4: {1: 0, 2: "My IR"}}` (index and name exactly as type 77 lists them). The pedal confirms with **type 83**
`{1: 6, 3: 1}`. The app then
requests the library with type 76 and receives type 77 without the deleted IR. This gives us the request, success
acknowledgment, and refresh flow needed for deletion. The editor uses this only for user IRs; factory cabs are
not deletable.

## 7. Deleting a preset (decoded from the phone app, 2026-10-08)

Source: a recorded phone-app session, not published: the iOS Cortex Cloud app deleting presets
63 and 64. One write per preset:

```
type 50  { 1: 2, 3: index }              08 02 18 3E  → preset 63 (0-based 62)
type 31  { 1: 1 }                        unsolicited notice on C305, ~110 ms later
type 51  { 1: 6, 3: index, 4: 1 }        ack, 4 = status (1 = ok)
```

After the ack the app re-reads the lists with type 1 `{1: 3, 3: 0, 4: 1, 5: 1}` (type-2 reply, ~6 KB, presets
only); the slot then comes back with an empty name. Field 1 = 2 is presumably the item kind (preset); captures
and IRs in the library are likely the same message with another kind — untested. Also in this trace, not needed
yet: type 152/153 and 164/165 `{1: 3, 2: <id varint>, 3: n}` for n = 0…4 answered with `"Slot is empty"`, type
46/47 device info, 54/55, 65/66 settings, 91/92 keepalive (the app sends it every ~55 s).

## 8. Footswitch assignment (decoded from the phone app, 2026-10-09)

Source: a recorded phone-app session, not published (`docs/TRACE-2026-10-09.md`). In 4-Preset mode the pedal has four footswitch slots,
footswitch I / II × bank A / B. They are read from the state dump and written with the preset-change message.

| Slot | State dump (type 2) | Type 29 field | `state.presetSlots` | Field 9 value when switching to it |
|------|---------------------|---------------|---------------------|------------------------------------|
| IA   | 14                  | 5             | `a1`                | 0                                  |
| IB   | 15                  | 6             | `b1`                | 1                                  |
| IIA  | 38                  | 7             | `a2`                | 2                                  |
| IIB  | 39                  | 8             | `b2`                | 3                                  |

Values are 0-based preset indices; the dump omits zeros. A preset change sends type 29
`{3: 0, 4: index, 5..8: −1, 9: slot}` where 9 is the slot holding the preset, or 4 when none does (the trace
selects preset 7, held by IIA, with `9: 2` and preset 15, held by IIB, with `9: 3`).

**Assigning** is the same message with field 4 = −1 (no preset change), the target slot's field = the preset
index, the other three −1 and field 9 = 0. −1 is the 10-byte varint `FF FF FF FF FF FF FF FF FF 01`. Assign preset index 14 to IA:

```
36 C0 18 00 20 FF FF FF FF FF FF FF FF FF 01
      28 0E
      30 FF FF FF FF FF FF FF FF FF 01
      38 FF FF FF FF FF FF FF FF FF 01
      40 FF FF FF FF FF FF FF FF FF 01
      48 00 1D 00 00 00
```

Replies: type 31 `08 01`, then type 30 `08 01 20 01` (ack, 4 = 1 ok); once, a type 115 `08 01` came first. The app
then re-reads the state (type 1 `08 03 18 01 20 01 28 01`) and the next dump carries the new slot (assigning
index 0 to IB leaves field 15 absent). Footswitch presses on the pedal arrive as type 29 `{1: 1, 4: index,
5..8: the four slots}` and are acked with type 30 as before. **An assignment discards the current preset's unsaved edits**: at 649 s in the trace the preset was dirty, the pedal
then reported it clean and the state went back to the stored preset. The editor therefore asks first, like a preset
switch ("Save changes to …?", Cancel / Don't save / Save and assign). Implementation: `footswitchFrame` /
`assignFootswitch` in `pro/ui.js`. Also in this trace, not decoded: one preset change with field 10 = 0 in place
of field 9 (`… 40 FF FF FF FF FF FF FF FF FF 01 50 00 1D 00 00 00`).

## 9. Tempo (decoded from the phone app, 2026-10-09)

From a recorded phone-app session, not published (203–279 s; write-up in
`docs/TRACE-2026-10-09.md` §2.6). The preset's tempo is **state-dump (type 2) field 56, f32 BPM** (93 → 114 → 222 → 106
after four saves). **Type 145** sets it:

| Dir | Body | Meaning |
|---|---|---|
| tx | `{3:1 4:0 5:bpm 6:0}` | Running tempo: the pedal follows, the preset is **not** dirtied |
| tx | `{3:0 4:0 5:bpm 6:0}` | Into the preset: the pedal answers 115 `{3:1}` (dirty); a normal type-3 Save stores it in field 56 |
| tx | `{3:1 4:0 6:0}` (no 5) | Query: the echo carries the current value (not used by the editor) |
| rx | `{1:1 3:1 [4:1] 5:bpm}` | Echo after a live write; also unsolicited when the tempo changes on the pedal (hold footswitch I, tap) |

Live 120 BPM: `0F C0 18 01 20 00 2D 00 00 F0 42 30 00 91 00 00 00` → echo `0D C0 08 01 18 01 2D 00 00 F0 42 91 00 00 00`.
Preset 93 BPM: `0F C0 18 00 20 00 2D 00 00 BA 42 30 00 91 00 00 00`. The official app sends `3:1` while the knob moves and
one `3:0` with the final value right before saving; the editor does the same (commit after the change settles, and
at Save). **Unverified:** field 4 (`4:1` appeared with the app's tap pad; the pedal seems to keep a separate value for
it, maybe the global tempo of "Tempo Mode: Global vs Preset"), so the editor always sends `4:0` and reads an rx with
`4:1` like `4:0`; whether `3:0` alone changes what you hear; range (the editor clamps 30–300, the trace reached 222).

## 10. Expression assignments (phone-app trace 2026-10-09 + upstream, firmware 2.2.1)

Per preset. Field numbers and record layouts come from upstream's `EXP_RANGES` / `EXP_BYPASS` / `expSaveFrame`
(DrD85, `editor/index.html`); the phone-app trace (a recorded phone-app session, not published,
321.6–382.4 s, write-up in `docs/TRACE-2026-10-09.md` §2.8) confirms them byte for byte
for every record it exercised. Upstream and the trace do not disagree anywhere.

| Type | Dir | Body | Meaning |
|---|---|---|---|
| 60 | tx | `{1: 3, 3: presetIndex}` | Read the set (`08 03 18 3D` for preset 62). Answered by 64 then 61. |
| 64 | rx | `{1: 1, 3: 2}` | Arrives between 60 and 61. Meaning unknown (pedal / EXP-MIDI mode status?). Ignored. |
| 61 | rx | `{1: 1, <records at field − 1>}` | The set; `{1: 1}` alone = none. No preset index, so requests go one at a time. |
| 62 | tx | `{3: presetIndex, <records>}` | Replaces the **whole** set; `{3: presetIndex}` alone clears it. Records in ascending field order. |
| 63 | rx | `{1: 1, 3: 1}` | Ack (3 = ok). |
| 115 | rx | `{1: 1, 3: 1}` / `{1: 1}` | Preset dirty after a change; clean again when the set matches the saved one. |

Records in 62 (61 uses the same layout at field − 1):

| 62 field | Target | Kind | 62 field | Target | Kind |
|---|---|---|---|---|---|
| 4 | Gain | range | 14 | Capture on/off | bypass |
| 5 | Bass | range | 15 | Cab / IR on/off | bypass |
| 6 | Mid | range | 16 | Pre FX 1 on/off | bypass |
| 7 | Treble | range | 17 | Pre FX 2 on/off | bypass |
| 8 | Pre FX 1 amount | range | 18 | Post FX 1 on/off | bypass |
| 9 | Pre FX 2 amount | range | 19 | Post FX 2 on/off | bypass |
| 10 | Post FX 1 amount | range | 20 | Post FX 3 on/off | bypass |
| 11 | Post FX 2 amount | range | 21 | Gate reduction | range |
| 12 | Post FX 3 amount | range | 22 | Gate on/off | bypass |
| 13 | Capture volume | range | | | |

- **Range** `{1: inverted 0/1, 2: min, 3: max}`, raw 0–255 at heel (min) and toe (max), zeros sent explicitly:
  `22 07 08 00 10 00 18 FF 01` = Gain 0–255. The editors show amp knobs, FX amount and gate as % of 255 (like the
  amp knobs in the inspector) and capture volume in dB on the capture-volume curve (raw 0 = −24 dB, 128 = 0 dB,
  255 = +12 dB). What "amount" drives inside an effect is the pedal's choice (upstream: "Pre FX 1 Amount").
- **Bypass** = one of: `1` heel-toe `{1: inverted, 2: switch delay ms}` (`0A 05 08 00 10 D8 04` = 600 ms; the app's
  default, 693 seen after an edit), `2` switch `{1: inverted, 2: latch emulation 0/1}` (`12 04 08 00 10 01`), `3` stop
  `{1: switch delay ms}`. Upstream clamps the delay to 0–2000 ms.
- Exact 62 frames from the trace: gain `0F C0 18 3D 22 07 08 00 10 00 18 FF 01 3E 00 00 00`; gain + bass
  `… 22 07 08 00 10 00 18 FF 01 2A 07 08 00 10 00 18 FF 01 …`; capture heel-toe 600 ms `0F C0 18 3D 72 07 0A 05 08 00
  10 D8 04 3E 00 00 00`; Pre FX 2 switch latch on `0F C0 18 3D 8A 01 06 12 04 08 00 10 01 3E 00 00 00`; clear
  `06 C0 18 3D 3E 00 00 00`. `test/ux-test.js` asserts these.

Upstream only (not in the trace): fields 6–13, 15–16 and 18–22, the stop mode, inverted = 1, and the "field − 1"
layout of a non-empty 61 (the trace only saw empty replies). **Unverified**: whether the set persists without a
type-3 save (115 suggests it sits in the edit buffer, so the editors mark the preset dirty and let Save commit it),
whether a preset switch drops unsaved assignments (demo mode assumes so), the capture-volume dB mapping for
expression ranges, and calibration (not in the trace).

## 11. Device page: device info, global settings, capture details (decoded from the phone app, 2026-10-09)

Source: a PacketLogger trace (recorded phone-app session, not published; write-up
`docs/TRACE-2026-10-09.md` §2.1, §2.7, §2.9). Implemented in `pro/ui.js` ("device page + capture info"); not yet run
against the pedal from this app.

| Type | Dir | Body | Meaning |
|---|---|---|---|
| 46 | tx | `{1:3 3:unixTime}` | Device info request (the app sends the clock; its purpose is unverified) |
| 47 | rx | `{1:1 3:1 4:"" 5:"2.2.1" 6:serial 7:hash}` | 5 = firmware, 6 = serial, 7 = a 40-hex value that changes on every request (not an id) |
| 91 / 92 | tx / rx | `{1:3}` → `{1:3 3:1 5:"2.2.1+06d34443" 6:serial 7:"Neural DSP Nano Cortex"}` | Keep-alive; full firmware string and device name |
| 65 | tx | `{1:3}` | Read global settings |
| 66 | rx | `{1:1 3:1 5:name 6:153 7:1 8:1 11:0 12:1 13:129 14:1 17:-6.0}` | Settings (field table below) |
| 67 | tx | `{1:1 4:brightness 14:usbDb}` | Write; the app always sends 4 and 14 together, so we resend the unchanged one |
| 68 | rx | `{1:1 3:1}` | Ack, 3 = ok. No 115 (dirty) follows: these are global, no Save |
| 17 | tx | `{3:captureSlot−1 5:1}` | Capture details for an absolute capture slot (0-based); 5 = 1 unknown |
| 18 | rx | `{1:6 3:1 7:{1:author 2:author} 8:"" 9:hash 10:name 11:record}` | Details; 11 is byte-identical to state field 34 (1 hash, 2 name, 4 author, 6 device type, 7 tags…, 8 small int, 10 instrument, 12 "1") |

Exact frames: brightness 153 with USB −6.0 dB `0E C0 08 01 20 99 01 75 00 00 C0 C0 43 00 00 00` (body
`08 01 20 99 01 75 00 00 C0 C0`; field 14 is an f32, tag `75`); capture details for slot 1 `08 C0 18 00 28 01 11 00 00 00`.
The 18 reply (304 bytes) arrives in one notification with flags `C1`: bit 0 of the flags byte is the ninth bit of the
length, which the core's `frameType()` rejects, so `pro/ui.js` reads it before the core.

**Settings fields** (66 read / 67 write). Only the first two are exposed; the rest are shown read-only under
"Raw settings" until Anup's tap-by-tap trace maps them.

| 67 field | 66 field | Values seen | Meaning | Status |
|---|---|---|---|---|
| 4 (varint) | 6 | 113…176, 153 | LED brightness 0–255 (153 = 60 %, the manual's default) | exposed (strong match, not yet confirmed on the LEDs) |
| 14 (f32) | 17 | −13.92…−5.53, −6.0 | USB playback volume, dB (manual default −6.0) | exposed (strong match) |
| — | 5 | "Neural DSP Nano Cortex" | Device name | shown in About; rename not decoded |
| — | 8 | 1 | MIDI channel per upstream | read by the core (MC6 panel) |
| 9 | 12 (?) | 0 / 1 | 4-Preset / 2-Preset mode? The pedal re-sends its preset after a write | **unverified**, not exposed |
| 7 | ? | 1 / 0 | A boolean touching capture/cab routing (state dump follows) | **unverified** |
| 8 | ? | 1 / 0 | A boolean | **unverified** |
| 12 (varint, explicit 0/1) | 15 | 1 / 0 | Mute Guitar Input | **confirmed** |
| 13 (varint, explicit 0/1) | 16 | 1 / 0 | Mute Guitar Output (Outputs 1L/2R) | **confirmed** |
| 15 | ? | 0 / 1 / 2 | A 3-way choice (MIDI clock source?) | **unverified** |
| 16 | ? | 0…3 | A 4-way choice (IR bypass on outputs?) | **unverified** |
| 18 | ? | 1 / 0 | A boolean | **unverified** |
| — | 7, 11, 13, 14 | 1, 0, 129, 1 | Read-only so far (13 read 172 during capture mode) | **unverified** |

The two monitoring mappings are now confirmed by correlating the local trace's standalone 67.12/67.13 boolean writes
with the type-66 readback layout and the normal type-68 acknowledgement. Type 67 field 12 reads back as type 66
field 15, and type 67 field 13 reads back as type 66 field 16. Each setting is sent alone with an explicit varint 0
or 1. The official manual confirms the user-facing behavior: input mute affects the Guitar Input monitor path, while
output mute affects the processed signal at Outputs 1L/2R; USB audio is a separate path.

Normalized frames used by the editor and demo are:

- Mute Input on/off: `08 C0 08 01 60 01 43 00 00 00` / `08 C0 08 01 60 00 43 00 00 00`.
- Mute Outputs 1L/2R on/off: `08 C0 08 01 68 01 43 00 00 00` / `08 C0 08 01 68 00 43 00 00 00`.
- Successful type-68 ACK: `08 C0 08 01 18 01 44 00 00 00`.
- Type-66 readback uses protobuf tags `0x78` (field 15) and `0x80` (field 16); an omitted boolean is off.

The 66 ↔ 67 numbering is not a fixed offset (4 ↔ 6 but 14 ↔ 17), so the unexposed 66 fields cannot be matched to
their 67 field yet. Guesses in our code: a brightness of 0 is sent as an explicit `20 00` (the app never sent 0); the
USB range −20…0 dB in 0.5 dB steps is ours (the app's slider went at least −13.9…−5.5); type-18 field 8 is shown as
the description although it was empty in every reply. On a real pedal (2026-10-24) some captures carry their Cortex
Cloud product ID as the whole description (capture "Darkglass MT900V2 1"; the Cloud API knows the ID as a
`neural_capture`, and `https://cloud.neuraldsp.com/cloud/neural-capture/view/<id>` opens it); the editor offers
**Open in Cortex Cloud** for those instead of showing the ID (`pro/capture-text.js`).

The 2026-10-09 phone-app session (footswitch assignment, tempo, expression, global settings, capture mode) is decoded in `docs/TRACE-2026-10-09.md`.

## 12. Live reports, auditions and preset moves (contributed in #14, firmware 2.2.1)

Sources: a contributor's phone-app BLE captures (2026-10-14/15; not published) and their hardware tests. Frames below
use neutral values. Implementation: `pro/live-sync.js` (live reports), `pro/transfer.js` (streamed 150, 15) and
`pro/ui.js` (auditions, preset moves).

**Live reports (pedal → app, unsolicited).** Protobuf leaves zero values out, so a missing field means 0.

| Type | Body | Meaning | Editor |
|---|---|---|---|
| 26 | `{1:1 3:control 4:raw 6:1}` | A knob moved: control 0 gain, 1 level, 2 bass, 3 mid, 4 treble, 10 capture volume, 11 gate (raw − 108 = reduction %) | applied; other controls → one state read |
| 99 | `{1:1 3:FX slot 0–4 4:param index 5:raw 0–255 (f32)}` | An FX parameter moved; comes with a type-26 control 6 carrying the same raw value | applied by slot and index |
| 31 | `{1:1 3:enable slot 4:0 on / 1 off}` | An FX block switched (enable slots 4–8 = Pre FX 1 … Post FX 3) | applied, unless the user's own click is still unconfirmed |
| 31 | `{1:1}` | Something changed | one coalesced state read (FX models kept) |
| 64 | `{1:1 3:2 4:position 0–255}` | Expression pedal position (heel: field 4 left out). The pedal also answers an assignment read (60) with `{1:1 3:2}`, so 64 is ignored while that read is outstanding | amp knobs, capture level and gate follow the assigned ranges; an FX Amount only where the parameter is known (Mix / Amount, Transpose → Semitones); a throttled (250 ms) read-back of the assigned FX blocks shows the rest |
| 94 | — | A cab parameter changed | one state read |
| 115 | `{1:1 3:dirty}` | Preset dirty state (upstream) | the only source of the unsaved-changes mark |

**Capture audition (Cortex Cloud "Play").** Not the library upload (13): nothing is written to a slot or the library.

```
150 (streamed like 13) { 5: { 1: { 1: <.cns bytes>, 2: <hex MD5 of the .cns> }, 2: <CaptureRecord as in 13> }, 7: 2, 8: 1 }
151                    { 1: 6, 3: 1, 4: { 1: 2, 2: <name>, 3: <hash> } }          3 = 1: playing
148                    { 2: <transaction>, 3: 0 }                                   stop (capture)
149                    { 1: 1, 2: <same transaction>, 3: 1 }                        stopped
```

**IR audition (a library IR, without loading it into a slot).** Factory cabs and user IRs use different record
fields; the trace shows field 3 for a factory cab, field 4 for user IRs is the matching guess (unverified).

```
158 { 3: { 1: <factory index>, 2: <name> }, 8: 1 }   or   { 4: { 1: <user index>, 2: <name> }, 8: 1 }
159 { 1: 6, 3: 1, 4: { 2: <name> } }                  3 = 1: playing; a new 158 replaces the IR playing
148 { 2: <transaction>, 4: 0 }                         stop (IR)
149 { 1: 1, 2: <same transaction>, 3: 1 }
```

For example, factory cab 0 "412 V30": `13 C0 1A 0B 08 00 12 07 34 31 32 20 56 33 30 40 01 9E 00 00 00`.

The transaction is the app's millisecond clock (a varint past 2³²); the pedal echoes it in both 149s seen (capture and
IR), and the editor only takes a stop as confirmed when it does. While anything is auditioned, the app sends
**91** `{1: 3}` about every 20 s and the pedal answers **92** `{1: 3, 3: 1, …}`; without it the pedal ends the
audition after about a minute. After a stop the app reads the current state, and the pedal may then report the
preset dirty (115) even though nothing was edited. While a capture preview plays, a state read reports the previewed
capture as the current one (seen in the native edition on the pedal, 2026-10-24: the name stayed after the stop until
the next read), so the editor reads the state again after every confirmed stop.

**Preset move.** One message moves a preset by insertion (the presets in between shift by one); indices are 0-based:

```
143 { 1: 4, 3: <from>, 4: <to> }          e.g. 5 → 3: 0A C0 08 04 18 04 20 02 8F 00 00 00
144 { 1: 6, 3: <from>, 4: <to>, 5: 1 }    5 = 1: moved
```

The app then reads the preset list again (type 1 `{1: 3, 3: 0, 4: 1, 5: 1}`; the editor uses upstream's full metadata
read) and the state. The pedal sent 115 dirty then clean around one move; the editor ignores 115 while a move is
outstanding and takes the dirty state from the state read after it. Observed moves: 5 → 3 and 36 → 6. How footswitch
assignments and the current preset follow a move is read from the pedal afterwards, not assumed.

What the editor checks (from the contributor's spec): a 158 carries the exact index and name type 77 listed, in
field 3 or 4 by kind, and never comes with a 78, 80 or a save; the stop sends 148 and accepts only a 149 with the same
transaction and status 1; the keep-alive runs only between an accepted 151/159 and a confirmed 149 (or a disconnect);
a 143 uses absolute indices even when the list is filtered; a failed or unconfirmed move ends with the order read
from the pedal, never an assumed one.

