# TypeScript/Node.js Libraries for BLE LE Audio Client Implementation

## Overview
This research identifies TypeScript/Node.js paths for connecting to a LE Audio microphone device (e.g., Bee Pioneer), handling ASCS/ASE state machine, establishing CIS via ISO data path, and decoding LC3 frames. Target: Node.js/TypeScript on Linux (primary), macOS (secondary). Requires BlueZ 5.60+, kernel 5.5+ (6.0+ for stable ISO sockets).

---

## 1. TypeScript/Node.js BLE Libraries: noble Equivalents & Capabilities

### Takeaway
**@abandonware/noble** (actively maintained fork of noble) and **@stoprocent/noble** are the primary TypeScript-native BLE central libraries. They support GATT notifications, write-with-response, and write-without-response. However, **neither supports ISO/L2CAP channels or LE Audio** — they operate purely at the GATT/ATT layer over ACL. For LE Audio, you must use BlueZ D-Bus (via `node-ble` or `dbus-next`) for control path, and a separate mechanism (kernel ISO sockets or PipeWire) for the data path.

### Cited Findings
- **@abandonware/noble**: "A Node.js BLE (Bluetooth Low Energy) central library... supports GATT notifications, write-with-response, write-without-response" — [npm @abandonware/noble](https://www.npmjs.com/package/@abandonware/noble)
- **@stoprocent/noble v2.8.0**: "Enables flexible selection of Bluetooth drivers through the new `withBindings()` API. Use native platform bindings (Mac, Windows) or HCI bindings with UART/serial support" — [npm @stoprocent/noble](https://www.npmjs.com/package/@stoprocent/noble)
- **noble Web Bluetooth shim**: "A Web Bluetooth API shim is available in noble... allows you to webpack/browserify noble without the need for a WebSocket server" — [Chrome for Developers](https://developer.chrome.com/docs/capabilities/bluetooth)
- **@capacitor-community/bluetooth-le**: Capacitor plugin for mobile/web; **not usable in Node.js** (targets Android/iOS/web via Web Bluetooth API) — [npm @capacitor-community/bluetooth-le](https://www.npmjs.com/package/@capacitor-community/bluetooth-le)
- **react-native-ble-plx**: React Native only; wraps native iOS/Android BLE APIs; **not usable in Node.js** — [GitHub dotintent/react-native-ble-plx](https://github.com/dotintent/react-native-ble-plx)

### Inferences
- Use **@abandonware/noble** or **@stoprocent/noble** for pure GATT-only devices (e.g., Bee Pioneer configuration service if exposed over GATT).
- For LE Audio, noble **cannot** handle ASCS/ASE (those are GATT-based but require BlueZ MediaTransport1 for data path) nor ISO channels.
- The `withBindings('dbus')` option in @stoprocent/noble uses system BlueZ — but still only exposes GATT, not MediaTransport1 or ISO sockets.

### Gaps
- No noble variant exposes BlueZ `MediaTransport1` or `Profile1` interfaces needed for LE Audio data path.

---

## 2. BlueZ D-Bus Libraries for LE Audio Control Path

### Takeaway
**node-ble** (by chrvadala) is the most mature TypeScript/Node.js library built on `dbus-next` that wraps BlueZ D-Bus APIs. It provides GATT client operations (discover, read, write, notifications) with TypeScript definitions. **It does not yet expose `MediaTransport1` (Acquire/Release FD) or ISO socket APIs** — these must be added or accessed via raw `dbus-next` calls. For LE Audio, you need `org.bluez.MediaTransport1` to acquire the file descriptor for the ISO data path, then use kernel `AF_BLUETOOTH/BTPROTO_ISO` sockets.

### Cited Findings
- **node-ble**: "Bluetooth Low Energy (BLE) library written with pure Node.js (no bindings) - baked by Bluez via DBus... method signatures follow, when possible, WebBluetooth standards" — [GitHub chrvadala/node-ble](https://github.com/chrvadala/node-ble)
- **node-ble API**: Supports `writeValueWithResponse()`, `writeValueWithoutResponse()`, `startNotifications()`, `stopNotifications()` — [node-ble README](https://github.com/chrvadala/node-ble#step-4b-subscribe-to-a-characteristic)
- **node-ble limitations**: "Windows and Mac OS are not supported... leverages the `bluez` driver" — [node-ble README](https://github.com/chrvadala/node-ble#pre-requisites)
- **dbus-next**: "Fully featured high level library for DBus... supports negotiating Unix file descriptors (DBus type `h`), set `negotiateUnixFd` to `true`" — [GitHub dbusjs/node-dbus-next](https://github.com/dbusjs/node-dbus-next)
- **BlueZ MediaTransport1**: `Acquire()` returns `(fd, uint16, uint16)` — file descriptor + MTU for read/write; `Release()` releases FD — [Ubuntu manpage org.bluez.MediaTransport](https://manpages.ubuntu.com/manpages/noble/man5/org.bluez.MediaTransport.5.html)
- **BlueZ LE Audio support**: "From release 5.66, initial support for BAP... depends on ISO socket... considered experimental" — [BlueZ LE Audio Support](https://bluez.github.io/news/2022/le-audio-support)

### Inferences
- **node-ble** is the best starting point for GATT/ASCS control (PACS discovery, ASE state machine via ASE Control Point characteristic).
- You must **extend node-ble or use dbus-next directly** to call `MediaTransport1.Acquire()` and obtain the ISO socket FD.
- The returned FD is a **kernel ISO socket** (`AF_BLUETOOTH`, `SOCK_SEQPACKET`, `BTPROTO_ISO`) — read/write LC3 frames via `recvmsg`/`sendmsg` with CMSG timestamps.

### Gaps
- No existing TypeScript wrapper for `MediaTransport1.Acquire()` / ISO socket handling in node-ble.
- No documented example of Node.js reading ISO socket FD from BlueZ and decoding LC3.

---

## 3. Web Bluetooth API in Node.js

### Takeaway
**webbluetooth** (thegecko/webbluetooth) and **node-web-bluetooth** implement the Web Bluetooth API spec in Node.js using SimpleBLE (native bindings). **They only expose GATT** — no ISO channels, no MediaTransport1, no LE Audio data path. Suitable only for GATT-only devices. Licensing of SimpleBLE is problematic (BUSL-1.1 for latest versions).

### Cited Findings
- **webbluetooth**: "Node.js implementation of the Web Bluetooth Specification... uses SimpleBLE" — [GitHub thegecko/webbluetooth](https://github.com/thegecko/webbluetooth)
- **SimpleBLE licensing**: "v6.x.x... latest SimpleBLE (BUSL-1.1 licensed)" — commercial license required — [webbluetooth README](https://github.com/thegecko/webbluetooth)
- **node-web-bluetooth**: "Web Bluetooth API and interactive device picker for node.js" — [npm node-web-bluetooth](https://www.jsdelivr.com/package/npm/node-web-bluetooth)
- **Blu framework**: "Node.js support... utilizes the `webbluetooth` library... must be installed manually" — [blu.js.org](http://blu.js.org)

### Inferences
- Web Bluetooth API polyfills **cannot** be used for LE Audio — the spec only covers GATT.
- If your device exposes a proprietary GATT service for configuration (not ASCS), these could work; but for standard LE Audio, you need BlueZ D-Bus.

### Gaps
- No Web Bluetooth API extension for ISO data path or LE Audio profiles.

---

## 4. LC3 Decoding in TypeScript/Node.js

### Takeaway
**No published npm package provides LC3 decoding for Node.js**. Options:
1. **Build liblc3 to WASM** using Emscripten (Google's liblc3 supports WASM via `clang --target=wasm32`).
2. **Use Python helper** (`lc3py` — official Python wrapper for liblc3) via stdio/IPC.
3. **Write native Node addon** (N-API / napi-rs) binding to liblc3.
4. **PipeWire/SPA plugin** — but requires running PipeWire daemon, not a library.

### Cited Findings
- **google/liblc3**: "Web assembly compilation is supported using LLVM WebAssembly backend... `clang --target=wasm32`" — [GitHub google/liblc3](https://github.com/google/liblc3)
- **lc3py**: "LC3 Codec library wrapper... requires Python >=3.10... built via meson-python" — [PyPI lc3py](https://pypi.org/project/lc3py), [liblc3 pyproject.toml](https://github.com/google/liblc3/blob/main/pyproject.toml)
- **liblc3 Python test dir**: "A python implementation of the encoder is provided in `test` directory" — [liblc3 README](https://github.com/google/liblc3)
- **Emscripten for audio codecs**: `@wasm-audio-decoders/flac`, `@wasm-audio-decoders/opus` exist as WASM ports; **no LC3 equivalent published** — [npm @wasm-audio-decoders](https://www.npmjs.com/package/@wasm-audio-decoders/flac)
- **napi-rs**: "Framework for building compiled Node.js add-ons in Rust via Node-API... generates TypeScript type definitions" — [napi-rs](https://napi.rs)

### Inferences
- **Fastest path**: Build liblc3 to WASM with Emscripten, publish as `@yourorg/liblc3-wasm` or use inline.
- **Most practical hybrid**: Spawn Python process using `lc3py`, pipe LC3 frames via stdin, receive PCM via stdout (or use `multiprocessing` for low latency).
- **Native addon**: napi-rs + Rust wrapper around liblc3 gives best performance; but adds build complexity.

### Gaps
- No ready-to-use `npm install liblc3-wasm` or `npm install lc3-decoder`.
- WASM build of liblc3 not published; must be built from source.
- `lc3py` API details (frame size, sample rate config) need verification.

---

## 5. ISO Data Path: Kernel Sockets vs. Helper Process

### Takeaway
The ISO data path uses **Linux kernel sockets** (`AF_BLUETOOTH`, `SOCK_SEQPACKET`, `BTPROTO_ISO`). BlueZ `MediaTransport1.Acquire()` returns an FD for this socket. In Node.js, you can:
- **Option A**: Use `dbus-next` with `negotiateUnixFd: true` to receive the FD, then use a **native addon** (or `node-ffi`) to `recvmsg`/`sendmsg` on it.
- **Option B**: **Proxy via Python** — Python's `socket` module natively supports `AF_BLUETOOTH`/`BTPROTO_ISO`; receive LC3 frames, decode via `lc3py`, forward PCM to Node.js via stdout/Unix socket.
- **Option C**: Let **PipeWire** handle the data path (it implements BAP sink/source), and your Node.js app consumes audio via PipeWire/PulseAudio API (e.g., `node-gstreamer` or `pipewire-node`). But this means you don't control the ISO path directly.

### Cited Findings
- **BlueZ ISO protocol**: `iso_socket = socket(PF_BLUETOOTH, SOCK_SEQPACKET, BTPROTO_ISO)` — [BlueZ iso-protocol.rst](https://github.com/bluez/bluez/blob/master/doc/iso-protocol.rst)
- **ISO socket address**: `struct sockaddr_iso` with `iso_family = AF_BLUETOOTH` — [openSUSE iso(7)](https://manpages.opensuse.org/Tumbleweed/bluez/iso.7.en.html)
- **Kernel requirement**: "Linux kernel — exposes ISO sockets (`AF_BLUETOOTH / BTPROTO_ISO`) from kernel 6.0 onwards" — [Embedded Pathashala](https://embeddedpathashala.com/ble-iso-channels-the-generic-audio-framework)
- **dbus-next Unix FD**: "Set `negotiateUnixFd` to `true`... value of any type `h` in messages sent or received should be the file descriptor itself" — [dbus-next README](https://github.com/dbusjs/node-dbus-next)
- **PipeWire LE Audio**: "PipeWire supports BAP in all roles (unicast sink/source and broadcast sink/source)... uses liblc3 from Google" — [Collabora blog](https://www.collabora.com/news-and-blog/blog/2025/11/24/implementing-bluetooth-le-audio-and-auracast-on-linux-systems)

### Inferences
- **Option B (Python helper)** is the most pragmatic for rapid prototyping: Python has native `socket.AF_BLUETOOTH`, `socket.BTPROTO_ISO`, `lc3py`, and easy IPC.
- **Option A (native Node)** requires writing a small N-API addon for `recvmsg`/`sendmsg` with CMSG handling — doable with napi-rs.
- **Option C (PipeWire)** is best for production apps that want system audio integration, but adds dependency on PipeWire/WirePlumber and less control over the ISO path.

### Gaps
- No existing Node.js library for `AF_BLUETOOTH` ISO sockets.
- No example of `dbus-next` receiving `MediaTransport1.Acquire()` FD and passing to Node.js socket handling.

---

## 6. ASCS/ASE State Machine Implementation

### Takeaway
ASCS/ASE is **pure GATT** — the Audio Stream Control Service exposes ASE Control Point characteristics (UUID `0x2B9E` for ASE Control Point, `0x2B9D` for ASE). The state machine (Idle → Codec Configured → QoS Configured → Enabling → Streaming → Disabling → Releasing) is driven by writing opcodes (Config Codec, Config QoS, Enable, Disable, Release) and reading notifications. This **can be fully implemented in TypeScript** using node-ble or noble.

### Cited Findings
- **ASCS ASE states**: "Idle, Codec Configured, QoS Configured, Enabling, Streaming, Disabling, Releasing... client drives transitions by writing operations to the ASE Control Point characteristic" — [FreeCodeCamp LE Audio Handbook](https://www.freecodecamp.org/news/the-bluetooth-le-audio-handbook)
- **ASE Control Point opcode**: Config Codec (0x01), Config QoS (0x02), Enable (0x03), Disable (0x04), Release (0x05), Receiver Start Ready (0x06) — [STM32 MCU Wiki](https://wiki.st.com/stm32mcu/wiki/Connectivity:Bluetooth_LE_Audio_-_Stream_Management)
- **PACS/ASCS UUIDs**: PACS `0x1850`, ASCS `0x184F`, ASE `0x2B9E` (Control Point), ASE `0x2B9D` (Status) — [Bluetooth SIG Assigned Numbers](https://www.bluetooth.com/specifications/assigned-numbers/)
- **node-ble GATT**: Full GATT client support (discover services, read/write characteristics, notifications) — [node-ble README](https://github.com/chrvadala/node-ble)

### Inferences
- Implement ASE state machine as a TypeScript class using node-ble's `GattCharacteristic` events (`valuechanged` for notifications, `writeValueWithResponse` for control points).
- After `Enable` → `Streaming` state, BlueZ creates `MediaTransport1` object; you must call `Acquire()` to get ISO FD.
- The **codec configuration** (LC3 parameters: sampling freq, frame duration, octets per frame, channel allocation) is sent in Config Codec opcode.

### Gaps
- No TypeScript reference implementation of ASCS/ASE state machine.
- Bee Pioneer's specific PACS/ASCS endpoint layout unknown (may need reverse engineering).

---

## 7. Recommended Architecture (Hybrid Approach)

### For Prototyping (Fastest to Audio)
```
TypeScript (node-ble + dbus-next)
  ├─ GATT: Scan, connect, PACS/ASCS discovery
  ├─ ASE State Machine: Config Codec → Config QoS → Enable
  ├─ MediaTransport1.Acquire() → get ISO socket FD
  └─ Spawn Python helper (pass FD via Unix socket SCM_RIGHTS)
       Python (lc3py + AF_BLUETOOTH socket)
         ├─ recvmsg() LC3 frames from ISO socket
         ├─ lc3py.decode() → PCM frames
         └─ stdout / Unix socket → TypeScript consumer
```

### For Production (Native Performance)
```
TypeScript (node-ble + dbus-next + napi-rs addon)
  ├─ GATT + ASE state machine (same)
  ├─ MediaTransport1.Acquire() → FD
  └─ napi-rs addon: recvmsg() on FD → liblc3 decode → callback PCM to TS
```

### For System Integration (PipeWire)
```
TypeScript → PipeWire API (GStreamer/SPA)
  ├─ PipeWire handles BlueZ MediaTransport1 + ISO + LC3
  └─ Your app gets PCM via PipeWire node (e.g., pipewire-node, gst-node)
```

---

## 8. Key Dependencies & Versions

| Component | Minimum Version | Notes |
|-----------|----------------|-------|
| BlueZ | 5.66+ | LE Audio/BAP experimental; 5.70+ recommended |
| Linux Kernel | 5.5+ (6.0+ for stable ISO) | `CONFIG_BT_ISO=y` |
| liblc3 | Latest (Google) | Build from source for WASM/native |
| dbus-next | Latest | `negotiateUnixFd: true` for FD passing |
| node-ble | 1.13+ | TypeScript defs included |
| Python | 3.10+ | For `lc3py` helper |
| Node.js | 18+ | N-API stability |

---

## 9. Summary: Best Path Forward

| Goal | Recommended Approach |
|------|---------------------|
| **GATT/ASCS control** | `node-ble` (TypeScript, BlueZ D-Bus) |
| **ISO socket FD acquisition** | Extend node-ble with `dbus-next` call to `MediaTransport1.Acquire()` |
| **LC3 decode** | **Short-term**: Python `lc3py` helper via IPC. **Long-term**: WASM build of liblc3 or napi-rs native addon. |
| **ISO data read** | **Short-term**: Python `socket.AF_BLUETOOTH` + `recvmsg`. **Long-term**: Node.js native addon for `recvmsg` on FD. |
| **macOS support** | Not feasible for LE Audio (no BlueZ, no ISO sockets). Use Linux VM or target Linux only. |

---

## 10. Open Questions / Gaps

1. **Bee Pioneer specifics**: Does it expose standard PACS/ASCS (UUIDs 0x1850/0x184F) or a proprietary GATT service for configuration?
2. **ASE endpoint count**: How many ASEs (source/sink) does Bee Pioneer expose? Unicast client needs to discover and select.
3. **Codec configuration**: What LC3 parameters does Bee Pioneer support? (Sampling rate, frame duration, bitrate, channel count)
4. **MediaTransport1 FD passing**: Verified working with `dbus-next` `negotiateUnixFd`? Need test case.
5. **ISO socket `recvmsg` in Node.js**: No existing binding; napi-rs addon needed for zero-copy.
6. **PipeWire node binding**: Is `pipewire-node` or `gst-node` maintained and usable for custom LE Audio sink?
7. **LC3 PLC (Packet Loss Concealment)**: `lc3py` / liblc3 supports PLC per spec Annex B — confirm API exposes it.

---

## References

- [node-ble GitHub](https://github.com/chrvadala/node-ble)
- [dbus-next GitHub](https://github.com/dbusjs/node-dbus-next)
- [google/liblc3 GitHub](https://github.com/google/liblc3)
- [lc3py PyPI](https://pypi.org/project/lc3py)
- [BlueZ LE Audio Support](https://bluez.github.io/news/2022/le-audio-support)
- [BlueZ MediaTransport1 manpage](https://manpages.ubuntu.com/manpages/noble/man5/org.bluez.MediaTransport.5.html)
- [BlueZ ISO Protocol doc](https://github.com/bluez/bluez/blob/master/doc/iso-protocol.rst)
- [Collabora: Implementing LE Audio on Linux](https://www.collabora.com/news-and-blog/blog/2025/11/24/implementing-bluetooth-le-audio-and-auracast-on-linux-systems)
- [Embedded Pathashala: BLE ISO Channels](https://embeddedpathashala.com/ble-iso-channels-the-generic-audio-framework)
- [FreeCodeCamp: LE Audio Handbook](https://www.freecodecamp.org/news/the-bluetooth-le-audio-handbook)
- [napi-rs](https://napi.rs)
- [@stoprocent/noble npm](https://www.npmjs.com/package/@stoprocent/noble)
- [@abandonware/noble npm](https://www.npmjs.com/package/@abandonware/noble)