# Bee Pioneer — verified BLE protocol (iOS-compatible)

**Status: verified against working production code.** The Bee Pioneer does
**not** use LE Audio. It is a plain GATT peripheral that streams
**ADTS-framed AAC** over a notify characteristic, which is why the iOS app
(and any CoreBluetooth/Android app) can consume it without ISO channels.

Everything below is ported from the Omi project's shipped implementations
(checked Oct 2026, `main` branch):

| Source | What it proves |
|---|---|
| `app/lib/services/devices/connectors/bee_connection.dart` | UUIDs, command codes, AAC/ADTS parsing, battery/firmware |
| `app/lib/services/devices/models.dart` | `beeServiceUuid`, `beeAudioCharacteristicUuid` values |
| `desktop/macos/.../Connections/BeeDeviceConnection.swift` | full command flow incl. start/stop audio, tested ADTS resync logic |
| `backend/utils/aac.py` | server-side AAC handling corroborates ADTS AAC |

## GATT surface

| Item | UUID | Properties |
|---|---|---|
| Service | `03d5d5c4-a86c-11ee-9d89-8f2089a49e7e` | — |
| Control characteristic | `05e1f93c-d8d0-5ed8-dd88-379e4c1a3e3e` | write-with-response + notify (responses) |
| Audio characteristic | `b189a505-a86c-11ee-a5fb-8f2089a49e7e` | notify |

## Control protocol

Commands are `[cmd_lo, cmd_hi, ...payload]` (little-endian 16-bit ID).

| Command | ID | Payload | Response payload |
|---|---|---|---|
| Firmware version | `0xC005` | — | `[patch, minor, major]` |
| Start/stop audio (mic) | `0xC006` | `[0x01]` start, `[0x00]` stop | echo/ack |
| Battery | `0xC00F` | — | `[level, isCharging]` |

Responses arrive on the **same control characteristic**:
`[code_lo, code_hi, payload...]`; when `code == 0x8000`, the next 2 bytes
echo the command ID and the real payload follows.

## Audio protocol

Each notification payload:

```
[2-byte per-packet header][ADTS AAC stream …]
```

- Strip the first 2 bytes; append the rest to a rolling buffer.
- Scan for the ADTS sync `0xFF 0xF?`; frame length =
  `(b3 & 0x03) << 11 | b4 << 3 | (b5 & 0xE0) >> 5`.
- One notification can contain several frames, a partial frame, or (after a
  dropped packet) garbage before the next sync word. A sync word that yields
  `frameLength < 7` must be treated as a false positive and skipped **one
  byte** at a time — treating it as a frame wedges the parser permanently
  (this bug is documented and fixed in Omi's Swift implementation and is
  carried over here).
- Concatenated ADTS frames form a valid `.aac` file; ffmpeg/whisper read it
  directly, so no decode is needed client-side.

## Firmware-version notes

The device reports versions like `1.0.0` / `1.0.2`. A community thread in the
Omi repo (issue #3539) claims 1.0.2+ adds AES-128-CCM encryption keyed from
the BLE LTK and changes the GATT surface; **that report is unverified** (parts
of it read as AI-generated, and it conflicts with Omi's shipped code, which
handles current firmware without crypto). If a unit with 1.0.2+ ever fails to
produce parseable ADTS frames, decrypt-on-notify is the first hypothesis to
test with a BLE sniffer.

## What earlier research got wrong

The first research pass inferred "LE Audio over ISO/CIS with LC3" from FCC
classification + Nordic SoC reasoning. That was wrong for this device: an
iOS-only companion app cannot use LE Audio (CoreBluetooth exposes no ISO
API), and Omi's shipped code shows plain GATT + AAC. See the superseded note
in `gatt_services.md`.

## Implementation in this repo

| Piece | File |
|---|---|
| Protocol constants, command codec, ADTS framer, base64 helpers | `apps/mobile/lib/beeProtocol.ts` |
| BLE client (scan/connect/subscribe/commands) | `apps/mobile/lib/beePioneer.ts` |
| Recording session → chunk upload → pipeline | `apps/mobile/hooks/useBeePioneerRecorder.ts` |
| ADTS recognized server-side (sniffer fix) | `packages/api/lib/docling.ts` (`sniffAudioContainer`) |
