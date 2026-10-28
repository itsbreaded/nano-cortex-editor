# Documentation

## For users

- [MANUAL.md](MANUAL.md): the user manual (install, connecting, every feature, shortcuts, troubleshooting, FAQ).

## For developers

- [HANDOFF.md](HANDOFF.md): the working plan and session log; how the features were built and what is still open.
- [INVESTIGATION.md](INVESTIGATION.md): the Bluetooth protocol as decoded so far (message types, frame layout,
  capture transfer, Cloud IRs, presets, footswitches, tempo, expression, device settings, live reports, auditions and
  preset moves) and the background research.
- [TRACE-2026-10-09.md](TRACE-2026-10-09.md): a message-by-message write-up of one recorded phone-app session.
- [OFFICIAL-APP-GAP.md](OFFICIAL-APP-GAP.md): what the official app can do that the editors can't yet, and how to
  trace the rest.
- [`../editor/README.md`](../editor/README.md): the vendored upstream community editor and how to update it.
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md): branches, tests and the hardware rules.

Screenshots in [`images/`](images/) are generated in demo mode by `npm run docs:screenshots`
(`scripts/docs-screenshots.js`, then `scripts/docs-images.py`, which needs Python with Pillow).

Recordings of real pedal or phone sessions are never committed (they can carry serial numbers, device addresses and
personal preset names); the protocol docs quote only short example frames with nothing identifying in them.
