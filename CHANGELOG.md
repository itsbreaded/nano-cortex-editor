# Changelog

All notable changes to Nano Cortex Editor (Electron edition). Versions follow [Semantic Versioning](https://semver.org/).

## 1.2.1 — 2026-10-24

### Changed

- Capture **Info…**: a capture whose description is only its Cortex Cloud ID shows **Open in Cortex Cloud** instead
  of the ID; it opens the capture's page in the Cortex Cloud tab. The ID no longer shows up in library lists or
  searches either.

### Fixed

- Quitting during a Live Preview or an IR audition now stops it on the pedal first (waiting at most a second and a
  half for the pedal) instead of leaving the pedal to time out.
- After a Live Preview stops, the editor reads the preset again, so the chain shows the preset's own capture instead
  of the previewed one.
- The editor no longer leaves a Bluetooth link to the pedal open after a disconnect, a failed connect, sleep or a long
  idle spell, which could keep the pedal from showing up for **Connect** until the app quit. It disconnects before
  the computer sleeps and reconnects when it wakes if it was connected before.

## 1.2.0 — 2026-10-23

This edition and the native Mac edition now share version numbers, so there is no 1.1.0 here.

### Added

- Update notifications: install a new version from the app, skip it or be reminded later (Help → Check for Updates…).
- **Live sync with the pedal**: knobs, effect parameters, footswitch bypasses and the expression pedal update the
  editor as they change on the pedal; the unsaved-changes mark follows the pedal's own report.
- **Cortex Cloud IRs to the pedal**: **Send to Nano** on each IR in your Cloud profile's Impulse Responses list (and
  **IRs** in the toolbar). WAV files up to 1 MB, PCM or float, mono or stereo.
- **Auditions**: **Live Preview** plays a Cloud capture on the pedal without storing it (with **IR: On / Off**), and
  ▶ on a library IR in the Cab / IR inspector plays it without loading it into a slot. Saving or changing the preset
  stops an audition first; if the pedal doesn't confirm the stop, the action doesn't happen.
- **From the library** in the Cab / IR inspector: factory cabs and your IRs with search, audition and **Delete…** for
  your own IRs.
- **Reorder presets** by dragging a row onto another (works with the filter on); the order is read back from the pedal.
  The row under the mouse shows a ⋮⋮ grip at its right end; the hand cursor shows over the grip and while you drag
  (a row itself keeps the arrow). Escape cancels a drag; near the top or bottom of the list it scrolls.
- **Monitoring** in Settings → Device: Mute Input and Mute Outputs 1L/2R; a header **Mute** button for the input,
  read from the pedal at connect.
- Knob drags, the mouse wheel and arrow keys send while you turn, not only when you let go.
- **Your own metronome sounds**: the accent, the main beat and the subdivisions each play a built-in sound or a sample
  you choose (WAV, AIFF, MP3, M4A/AAC, FLAC or Ogg, up to 5 MB) in Settings → Metronome → Sounds.

### Changed

- Reverbs have their own colour in the signal chain (soft pink), so a delay next to a reverb no longer looks the same.

### Fixed

- Capture **Info…** showed the word "null" when a capture has no description; now it shows nothing there. A
  description of "null" is never sent to the pedal either.
- Combo captures from the pedal (reported as "amp_combo") had no kind icon; they show the combo icon now.
- Connecting on a computer with many Bluetooth devices ([#15](https://github.com/AJs-Creations/nano-cortex-editor/issues/15)).
  Connect now looks only for devices that offer the Nano Cortex's Bluetooth service and takes the pedal as soon as it
  appears, with or without a name. While it looks, a window repeats how to put the pedal in pairing mode. **Show all
  Bluetooth devices** lists every device nearby (no longer only the first eight), live while it scans, with names that
  look like the pedal first and unnamed devices next; **Scan again** restarts the scan.
- The app remembers a device only after it has found the Nano Cortex's editor service on it. Before, any device picked
  in the list was remembered and then tried on every Connect, so one wrong pick (a headset, say) blocked connecting.
  A remembered device that turns out not to be a Nano Cortex is now forgotten, and the list opens again.
- Closing the tuner keeps the guitar input muted if it was (the pedal needs the mute re-applied).
- A click or right-click on the signal chain is no longer lost when the pedal's report redraws it at that moment.
- Context menus stay inside small windows.
- The window's footer is laid out when the content area settles after the window opens (Windows).
- `npm start` and the other scripts run on Windows too (a Node launcher clears `ELECTRON_RUN_AS_NODE`).

The live sync, Cloud IR, audition, reorder and monitoring entries were contributed by @itsbreaded in #14 and integrated with maintainer changes. They are verified on a Nano Cortex (firmware 2.2.1), except Live Preview of a Cloud capture, which is not yet.

## 1.0.0 — 2026-10-10

First public release.

### Added after release (same version)

- Linux builds: AppImage and deb, for x64 and arm64 (Raspberry Pi 4/5 with a 64-bit OS). Not yet tested with a pedal.
- Keyboard shortcut labels show Ctrl (and Shift, Alt) on Windows and Linux instead of ⌘ (⇧, ⌥): tooltips, the Save
  button and the shortcuts sheet.
- macOS: signed with a Developer ID and notarised by Apple, so the download opens without security workarounds.
- The keyboard shortcuts sheet no longer lists Settings twice.

### Help, About and support links

- Settings → About (version, links to the repository, the manual and the native macOS edition), a Help menu (Manual,
  GitHub Repository, Report an Issue, Support the Project…), links to the manual on the connect screen, in the
  shortcuts sheet and in connection errors, and a quiet "♥ Support" link in the status bar. Every link opens in
  your browser.
- Settings → General → Advanced → **Developer tools** (off by default). It shows the Activity log, session recording
  and protocol details: Record and Activity in the status bar, ⌘L, the "Sent: …" status text, Activity at launch,
  Raw settings and the device and capture hashes, and View → Classic Editor, Reload Current and Developer Tools.
  Everything appears and disappears at once when you flip it; turning it off stops a recording in progress (saving
  it to the recordings folder) and closes the Activity drawer.
- **Help → Show Log File**, for everyone: the Activity log is also written to `nano-cortex-editor.log` in the app's logs folder
  (the last ~2 MB plus one older file). The bug report template asks for it.

### Features

- Bluetooth connection to the Nano Cortex with automatic pedal selection, reconnect at launch and a demo mode that
  runs everything on sample data.
- Preset browser for all 64 presets: filter, keyboard navigation, right-click menus, and a prompt before switching
  away from unsaved edits.
- Save, Save as… (into any slot), Rename, Delete and Discard.
- Editing of every block: gate, Pre FX 1–2, capture (amp knobs and capture volume), Cab / IR (level, filters,
  microphone and position) and Post FX 1–3, with a searchable effect picker and keyboard shortcuts.
- Captures and IRs from the pedal's library into any slot, with capture-kind and instrument icons, capture Info…
  and a slot usage scan; presets that play a capture or cab straight from the library are shown as such.
- Footswitch assignment (IA, IB, IIA, IIB) from the Footswitches strip or the preset menu.
- Expression pedal assignments per preset: sweeps and block switches with all their options.
- Preset tempo with − / +, typing, scrubbing and Tap.
- Tuner with reference pitch and mute.
- Metronome with Simple and Advanced modes: patterns, accents, subdivisions and swing, count-in, tempo trainer, gap
  trainer, Levels, five click sounds, output selection, and an option to follow the preset tempo.
- Settings: accent colour (the app icon follows), metronome defaults, connection options, and a Device page with the
  pedal's details, LED brightness and USB playback volume.
- Cortex Cloud tab with your own login and Send to Nano Cortex for captures.
- Activity log and session recording of all Bluetooth traffic.
- The original community editor by DrD85 as View → Classic Editor.
- Unsigned builds for macOS (Apple Silicon and Intel, .dmg and .zip) and Windows (installer and portable).

### Known limitations

- The Windows and Linux builds have not been tested with a pedal yet.
- Some features have been verified only against recorded phone-app traffic and in demo mode, not yet end to end on a
  pedal from this app: footswitch assignment, expression assignments (including whether Save keeps them), preset
  tempo, the Device settings page, reconnect at launch and the slot usage scan.
- IRs and presets from Cortex Cloud still need the official app; only captures can be sent.
- Preset reordering and copying (other than Save as…) are not supported yet.
- Cab tone knobs for a cab played straight from the library are not read back.
- Tested with firmware 2.2.1 only.
