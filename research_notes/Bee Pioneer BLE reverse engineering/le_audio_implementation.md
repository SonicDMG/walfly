# Bee Pioneer BLE LE Audio Implementation Research

## Research Objective
Provide a complete technical guide for connecting to a LE Audio microphone device (Bee Pioneer), setting up the Audio Stream Control Service (ASCS), configuring the ISO data path, and decoding LC3 audio frames.

---

## 1. ASCS ASE State Machine Flow for a Sink (Receiver)

### Takeaway
The ASCS (Audio Stream Control Service) uses ASE (Audio Stream Endpoint) state machines to manage the lifecycle of audio streams. For a sink (receiver), the ASE transitions through specific states from Idle to Streaming, with the client initiating configuration and the server (Pioneer) confirming capabilities. **Critical distinction**: Sink ASEs (receiving audio) transition directly from Enabling to Streaming without Receiver Start Ready; only Source ASEs (sending audio) require Receiver Start Ready.

### Cited Findings
- ASCS defines the Audio Stream Endpoint (ASE) state machine with states: Idle, Codec Configured, QoS Configured, Enabling, Streaming, Disabling, Releasing — [Bluetooth Core Spec v5.3 Vol 3 Part G, Section 6.1](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- For a sink (receiver), the client writes to the ASE Control Point characteristic to trigger state transitions; the server responds with ASE State characteristic notifications — [Bluetooth Core Spec v5.3 Vol 3 Part G, Section 6.2](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- ASE Control Point opcodes: Config Codec (0x01), Config QoS (0x02), Enable (0x03), Receiver Start Ready (0x04), Disable (0x05), Receiver Stop Ready (0x06), Update Metadata (0x07), Release (0x08) — [BlueZ btmon-le-audio.rst](https://raw.githubusercontent.com/bluez/bluez/master/doc/btmon-le-audio.rst)
- **Sink ASE flow**: Config Codec → Codec Configured → Config QoS → QoS Configured → Enable → Enabling → Streaming (immediate, no Receiver Start Ready) — [BlueZ btmon-le-audio.rst](https://raw.githubusercontent.com/bluez/bluez/master/doc/btmon-le-audio.rst)
- **Source ASE flow**: Config Codec → Codec Configured → Config QoS → QoS Configured → Enable → Enabling → CIS Established → Setup ISO Data Path Output → Receiver Start Ready → Streaming — [BlueZ btmon-le-audio.rst](https://raw.githubusercontent.com/bluez/bluez/master/doc/btmon-le-audio.rst)
- PACS (Published Audio Capabilities Service) must be read first to discover supported codec capabilities (LC3 configurations) before ASE Config Codec — [Bluetooth Core Spec v5.3 Vol 3 Part G, Section 5](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- The ASE State characteristic exposes: ASE_ID, ASE_State, Codec Configuration, QoS Configuration, Metadata — [Bluetooth Core Spec v5.3 Vol 3 Part G, Section 6.2](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)

### Inferences
- The typical sink flow: Discover PACS → Read Sink PAC → Discover ASCS → Read ASE State → Write Config Codec (with LC3 params) → Write Config QoS (with CIG/CIS params) → Write Enable → Streaming begins
- Each write to ASE Control Point requires a response and triggers an ASE State notification
- The Metro (PACS) record for the Pioneer will reveal its supported LC3 configurations (sampling rates, frame durations, octets per frame)
- For Pioneer (microphone = Source ASE on Pioneer), the Pioneer acts as Unicast Server with Source ASEs; our client acts as Unicast Client with Sink ASEs
- We send Config Codec/QoS/Enable to Pioneer's ASE Control Point; Pioneer notifies ASE State changes
- Pioneer (as Source ASE) will send Receiver Start Ready when ready to transmit

### Gaps
- Exact LC3 codec configuration parameter values used by Bee Pioneer (need to read its PACS record)
- Whether Pioneer implements any vendor-specific ASE Control Point extensions
- Exact ASE IDs used by Pioneer for its Source endpoints

---

## 2. ISO Data Path Configuration for CIS (Connected Isochronous Stream)

### Takeaway
CIS (Connected Isochronous Stream) establishment requires creating a CIG (Connected Isochronous Group) via HCI LE Set CIG Parameters, then creating CISes via HCI LE Create CIS, followed by configuring the ISO Data Path via HCI LE Setup ISO Data Path to route audio data to/from the controller. On BlueZ, this is exposed via D-Bus `org.bluez.MediaTransport1` API with file descriptor acquisition.

### Cited Findings
- HCI LE Set CIG Parameters (0x2046) creates a CIG with parameters: CIG ID, SDU intervals, transport latency, PHYs, packing, framing, max SDU size — [Bluetooth Core Spec v5.3 Vol 4 Part E, Section 7.8.90](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- HCI LE Create CIS (0x2047) establishes individual CIS connections within a CIG, linking ACL connection to CIS — [Bluetooth Core Spec v5.3 Vol 4 Part E, Section 7.8.91](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- HCI LE Setup ISO Data Path (0x2049) configures the data path between host and controller for ISO channels (input/output/off) — [Bluetooth Core Spec v5.3 Vol 4 Part E, Section 7.8.93](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- ISOAL (ISO Adaptation Layer) handles framing: unframed (single SDU per ISO interval) vs framed (multiple SDUs) — [Bluetooth Core Spec v5.3 Vol 3 Part K, Section 3.2](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- For LE Audio, unframed mode is typical with one LC3 frame per SDU — [Bluetooth Core Spec v5.3 Vol 3 Part K, Section 4](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- BlueZ `org.bluez.MediaTransport1` API: `Acquire()` returns (fd, mtu_read, mtu_write), `Release()` releases fd, properties include `State` (idle/pending/active), `Codec`, `Configuration`, `Delay`, `Volume`, `Links` (for bidirectional) — [BlueZ MediaTransport1 man page](https://manpages.debian.org/testing/bluez/org.bluez.MediaTransport.5.en.html)
- BlueZ `org.bluez.Profile1` API: `NewConnection(device, fd, fd_properties)` called when CIS established, `RequestDisconnection(device)` for cleanup — [BlueZ Profile API](https://github.com/bluez/bluez/blob/master/doc/org.bluez.Profile.rst)
- `bluetoothctl` LE Audio commands: `menu leaudio`, `register`, `cis`, `metadata`, `transport acquire/release/select/unselect` — [BlueZ bluetoothctl source](https://git.kernel.org/pub/scm/bluetooth/bluez.git/tree/client/leaudio.c)

### Inferences
- On Linux/BlueZ, CIG/CIS management is handled by BlueZ internally when ASCS profile is registered; we don't call HCI commands directly
- The ASE QoS Configuration step in ASCS provides the CIG/CIS parameters (CIG ID, CIS ID, SDU interval, PHY, etc.) that BlueZ uses internally
- ISO Data Path setup: After CIS establishment, BlueZ creates `MediaTransport1` object; we call `Acquire()` to get FD, then read ISO frames from FD
- For Source ASE (Pioneer sending to us): ISO Data Path direction is **Output** (Controller→Host), we read from FD
- `MediaTransport1` properties: `Interval` (ISO interval in µs), `Latency` (ms), `SDU` (max SDU size), `PHY` (bitmask), `Retransmissions`, `Links` (linked transports for bidirectional)

### Gaps
- Exact sequence of D-Bus calls for ASCS profile registration and MediaTransport handling
- How to correlate ASE ID with MediaTransport object path
- BlueZ D-Bus API specifics for ISO Data Path configuration in recent versions (5.64+)

---

## 3. LC3 Configuration Parameters for LE Audio Microphones

### Takeaway
LE Audio microphones (like Bee Pioneer) typically use LC3 with 16kHz or 48kHz sampling rate, 10ms frame duration, and variable octets per frame depending on bitrate. The exact configuration is advertised via PACS Sink PAC record (since Pioneer is a Source, it advertises Source PAC on Pioneer, but we read its capabilities as a client).

### Cited Findings
- LC3 mandatory sampling rates: 8, 16, 24, 32, 48 kHz; mandatory frame durations: 7.5ms, 10ms — [ETSI TS 103 634 V1.3.1, Section 4.2](https://www.etsi.org/deliver/etsi_ts/103600_103699/103634/01.03.01_60/ts_103634v010301p.pdf)
- LC3 bitrate range: 24-320 kbps per channel; octets per frame = bitrate * frame_duration / 8 — [ETSI TS 103 634 V1.3.1, Section 5](https://www.etsi.org/deliver/etsi_ts/103600_103699/103634/01.03.01_60/ts_103634v010301p.pdf)
- PACS Source PAC record contains Codec Specific Capabilities: sampling frequency bitmask, frame duration bitmask, min/max octets per frame, max frame blocks per SDU — [Bluetooth Core Spec v5.3 Vol 3 Part G, Section 5.2.2](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- Typical LE Audio microphone configurations: 16kHz/10ms (voice) or 48kHz/10ms (music), 10-40 octets/frame — [Nordic nRF Connect SDK LE Audio samples](https://github.com/nrfconnect/sdk-nrf/tree/main/subsys/bluetooth/audio)
- NXP MCUXpresso SDK example shows: 44.1kHz, 10ms, 130 octets/frame, mono (channel allocation 0x1) — [NXP unicast_media_receiver](https://mcuxpresso.nxp.com/mcuxsdk/25.03.00/html/examples/edgefast_bluetooth_examples/unicast_media_receiver/readme.html)
- LC3 Codec ID: 0x06 (assigned number) — [BlueZ btmon-le-audio.rst](https://raw.githubusercontent.com/bluez/bluez/master/doc/btmon-le-audio.rst)
- LC3 Codec Configuration LTV structure: Type 0x01=Sampling Frequency, 0x02=Frame Duration, 0x03=Channel Allocation, 0x04=Octets Per Frame, 0x05=Frame Blocks Per SDU — [Bluetooth Core Spec v5.3 Vol 3 Part G, Section 6.12.5](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)

### Inferences
- Bee Pioneer as a microphone device will advertise Source PAC (since it sends audio as a source)
- Most likely configuration: 16kHz or 48kHz, 10ms, ~20-40 octets/frame (32-64 kbps mono) or higher for music
- The ASE Config Codec opcode must include matching LC3 Codec Configuration LTVs: sampling frequency, frame duration, channel allocation, octets per frame
- Channel allocation: mono=0x1, stereo=0x3 (left|right)
- Frame blocks per SDU: typically 1 for LE Audio unframed mode

### Gaps
- Exact PACS record values for Bee Pioneer (requires BLE scan/connection to read)
- Whether Pioneer supports multiple LC3 configurations or only one fixed profile

---

## 4. Parsing LC3 Frames from ISOAL PDU Payload

### Takeaway
ISOAL PDU carries LC3 frames in unframed mode (one LC3 frame per SDU). The payload is the raw LC3 frame data which must be decoded using an LC3 decoder library to produce PCM output. In unframed mode: [Time Offset (2 octets)] + [ISOAL Payload = LC3 Frame].

### Cited Findings
- ISOAL PDU format in unframed mode: [Time Offset (2 octets, little-endian)] + [ISOAL Payload = LC3 Frame] — [Bluetooth Core Spec v5.3 Vol 3 Part K, Section 3.2.2](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- Time Offset indicates presentation time relative to CIS anchor point; can be used for synchronization — [Bluetooth Core Spec v5.3 Vol 3 Part K, Section 3.2.2](https://www.bluetooth.com/specifications/specs/core-specification-5-3/)
- LC3 frame structure: header (1-2 bytes) + encoded spectral data; exact format per ETSI TS 103 634 — [ETSI TS 103 634 V1.3.1, Section 6](https://www.etsi.org/deliver/etsi_ts/103600_103699/103634/01.03.01_60/ts_103634v010301p.pdf)
- Linux kernel LC3 decoder: `CONFIG_BT_LC3` module in BlueZ 5.64+ provides in-kernel decoding — [BlueZ 5.64 release notes](https://git.kernel.org/pub/scm/bluetooth/bluez.git/log/?h=5.64)
- Google `liblc3` provides Python wrapper in `python/` directory, installable via `pip install .` — [liblc3 GitHub](https://github.com/google/liblc3)
- `liblc3` Python tools: `encoder.py` and `decoder.py` in `python/tools/` show usage — [liblc3 GitHub](https://github.com/google/liblc3/tree/main/python/tools)
- `liblc3` C API: `lc3_decode_init()`, `lc3_decode_process()`, `lc3_decode_destroy()` — [liblc3 include/lc3.h](https://github.com/google/liblc3/blob/main/include/lc3.h)

### Inferences
- On Linux with BlueZ 5.64+, the kernel can handle LC3 decode via ISO Data Path with `BT_ISO_DATAPATH_HCI` and proper codec setup (but userspace decode gives more control)
- For userspace implementation (Python), need to: read from MediaTransport FD → parse ISOAL PDU (skip 2-byte Time Offset) → feed raw LC3 frames to `liblc3` decoder → output PCM
- LC3 decoder requires initialization with same parameters: sampling rate, frame duration, channel count, octets per frame
- `liblc3` Python wrapper is the most practical for Python implementation

### Gaps
- Exact ISOAL PDU parsing code for BlueZ D-Bus MediaTransport1 FileDescriptor data stream
- Whether Pioneer uses Time Offset field or sets it to 0
- PCM output format from liblc3 (interleaved? sample format?)

---

## 5. Libraries/SDKs Supporting LE Audio Client on Linux/macOS/Node.js/Python

### Takeaway
Linux/BlueZ is the most mature platform for LE Audio client development. Node.js (noble/bleno) and Python (bleak/bluezero) have limited/no native LE Audio support; native BlueZ D-Bus API or C/C++ with libbluetooth is recommended. Python with `dbus-next` is the most practical path.

### Cited Findings
- BlueZ 5.64+ (2023) added full LE Audio support: ASCS, PACS, MICS, AICS, BAS, ISO/CIS, LC3 kernel module — [BlueZ 5.64 announcement](https://www.bluez.org/bluez-5-64/)
- BlueZ D-Bus API for LE Audio: `org.bluez.Profile1` (ASCS), `org.bluez.MediaTransport1` (ISO data), `org.bluez.Device1` (PACS) — [BlueZ API documentation](https://git.kernel.org/pub/scm/bluetooth/bluez.git/tree/doc)
- pipewire 0.3.70+ with wireplumber 0.4.11+ provides LE Audio sink/source support via `libspa-bluez5` — [PipeWire LE Audio merge request](https://gitlab.freedesktop.org/pipewire/pipewire/-/merge_requests/3721)
- noble (Node.js) has no LE Audio/ISO support; only standard GATT — [noble GitHub issues](https://github.com/abandonware/noble/issues)
- bleak (Python) has no LE Audio/ISO support; only standard GATT — [bleak GitHub issues](https://github.com/bleak-dev/bleak/issues)
- python-bluezero: abandoned, no LE Audio support — [python-bluezero GitHub](https://github.com/ukbaz/python-bluezero)
- Nordic nRF Connect SDK (Zephyr) has complete LE Audio reference implementation for both client/server — [Nordic LE Audio docs](https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/samples/bluetooth/le_audio/README.html)
- Zephyr BAP API: `bt_bap_stream_config()`, `bt_bap_stream_qos()`, `bt_bap_stream_enable()`, `bt_bap_stream_start()` — [Zephyr BAP API](https://docs.zephyrproject.org/3.5.0/connectivity/bluetooth/api/bap.html)
- `dbus-next` (Python) is modern asyncio-based D-Bus library with examples — [dbus-next GitHub](https://github.com/altdesktop/python-dbus-next)

### Inferences
- For Linux: Best approach is using BlueZ D-Bus API directly (Python with `dbus-next` or C with GLib)
- For macOS: No native LE Audio support in CoreBluetooth; would need Linux VM or external dongle with BlueZ
- For Node.js: No viable option; would need native addon binding to BlueZ or external process
- Practical path: Python + `dbus-next` + BlueZ 5.64+ on Linux, or use PipeWire as audio backend (but PipeWire abstracts everything)
- If using PipeWire: it handles ASCS, CIS, ISO, LC3 decode automatically; we just get audio via PipeWire API

### Gaps
- Working Python example using `dbus-next` for full ASCS → CIS → ISO → LC3 flow
- macOS CoreBluetooth LE Audio support status (Apple has not announced support)

---

## 6. Example Code: Service Discovery → ASCS Config → CIS Establishment → ISO Data Receive → LC3 Decode → PCM Output

### Takeaway
Complete working examples are scarce. BlueZ test tools (`btmgmt`, `bluetoothctl`) and PipeWire source code provide the best reference implementations. A custom Python implementation requires ~500 lines of D-Bus code. The Nordic Zephyr `le_audio_rx.c` provides the clearest algorithmic reference.

### Cited Findings
- BlueZ `btmgmt` commands for LE Audio: `le-audio-register`, `cis-create`, `cis-remove`, `iso-data-path` — [BlueZ btmgmt documentation](https://git.kernel.org/pub/scm/bluetooth/bluez.git/tree/tools/btmgmt.c)
- BlueZ `bluetoothctl` LE Audio commands: `menu leaudio`, `register`, `cis`, `metadata` — [BlueZ bluetoothctl source](https://git.kernel.org/pub/scm/bluetooth/bluez.git/tree/client/leaudio.c)
- PipeWire `spa-bluez5` implementation: `media-session.c`, `bluez5-device.c`, `bluez5-transport.c` — [PipeWire source](https://gitlab.freedesktop.org/pipewire/pipewire/-/tree/master/src/modules/bluez5)
- Nordic nRF Connect SDK `le_audio` sample: `le_audio_rx.c` shows complete sink implementation on Zephyr — [Nordic SDK sample](https://github.com/nrfconnect/sdk-nrf/tree/main/samples/bluetooth/le_audio)
- Google `liblc3` example: `lc3_decoder.c` shows frame decoding API — [liblc3 examples](https://github.com/google/liblc3/tree/main/examples)
- NXP MCUXpresso SDK `unicast_media_receiver` shows full flow with logs: Codec Config → QoS → Enable → CIS Established → ISO Data Path → Streaming — [NXP example](https://mcuxpresso.nxp.com/mcuxsdk/25.03.00/html/examples/edgefast_bluetooth_examples/unicast_media_receiver/readme.html)

### Inferences
- Minimal Python implementation outline:
  1. `dbus-next` to connect to system bus, discover device, read PACS (Source PAC on Pioneer)
  2. Register ASCS profile via `org.bluez.ProfileManager1.RegisterProfile` with UUID `00001852-0000-1000-8000-00805f9b34fb` (ASCS)
  3. Implement `org.bluez.Profile1` with `NewConnection(device, fd, fd_properties)` for CIS establishment
  4. Discover ASCS on Pioneer, read ASE State characteristics, subscribe to notifications
  5. Write ASE Control Point: Config Codec (with LC3 params from PACS) → wait for Codec Configured notification
  6. Write ASE Control Point: Config QoS (with CIG/CIS params) → wait for QoS Configured notification
  7. Write ASE Control Point: Enable → wait for Enabling notification
  8. BlueZ internally creates CIS, calls `Profile1.NewConnection` with FD for ISO data
  9. Call `MediaTransport1.Acquire()` to get FD and MTU
  10. Read ISO frames from FD in loop: parse ISOAL (skip 2-byte Time Offset) → decode LC3 via `liblc3` → output PCM
  11. For Source ASE on Pioneer: Pioneer sends Receiver Start Ready → Streaming notification
  12. On Disable/Release: call `MediaTransport1.Release()`, clean up

### Gaps
- No complete, copy-pasteable Python example exists in public repos
- BlueZ D-Bus API for ISO Data Path (`MediaTransport1`) is complex and poorly documented
- Need to verify Pioneer's exact ASE IDs and CIS parameter values
- Exact D-Bus object paths for ASCS characteristics and ASE Control Point/State

---

## Summary of Actionable Next Steps

1. **Scan Pioneer PACS record** — Use `bluetoothctl` or `btmgmt` to connect and read Source PAC for exact LC3 params
2. **Set up Linux dev environment** — BlueZ 5.64+, `dbus-next`, `liblc3` Python bindings (`pip install .` in liblc3/python)
3. **Implement ASCS client** — D-Bus profile registration, ASE state machine handling
4. **Implement CIS/ISO path** — Use BlueZ `MediaTransport1` API for FD-based ISO data
5. **Integrate LC3 decoder** — `liblc3` Python wrapper for frame decoding
6. **Audio output** — PipeWire/ALSA for PCM playback

---

## Key References

| Source | URL |
|--------|-----|
| Bluetooth Core Spec v5.3 | https://www.bluetooth.com/specifications/specs/core-specification-5-3/ |
| ETSI TS 103 634 (LC3) | https://www.etsi.org/deliver/etsi_ts/103600_103699/103634/01.03.01_60/ts_103634v010301p.pdf |
| BlueZ Git Repository | https://git.kernel.org/pub/scm/bluetooth/bluez.git/ |
| BlueZ btmon-le-audio.rst | https://raw.githubusercontent.com/bluez/bluez/master/doc/btmon-le-audio.rst |
| Nordic nRF Connect SDK LE Audio | https://developer.nordicsemi.com/nRF_Connect_SDK/doc/latest/nrf/samples/bluetooth/le_audio/README.html |
| PipeWire BlueZ5 Module | https://gitlab.freedesktop.org/pipewire/pipewire/-/tree/master/src/modules/bluez5 |
| Google liblc3 | https://github.com/google/liblc3 |
| BlueZ 5.64 Release Notes | https://www.bluez.org/bluez-5-64/ |
| Zephyr BAP API | https://docs.zephyrproject.org/3.5.0/connectivity/bluetooth/api/bap.html |
| NXP MCUXpresso LE Audio Example | https://mcuxpresso.nxp.com/mcuxsdk/25.03.00/html/examples/edgefast_bluetooth_examples/unicast_media_receiver/readme.html |
| dbus-next Python Library | https://github.com/altdesktop/python-dbus-next |

---

## Appendix: ASCS ASE State Machine Detail (from BlueZ btmon-le-audio.rst)

```
ASE State Machine:
Idle ──► Codec Configured ──► QoS Configured ──► Enabling ──► Streaming
│
Idle ◄── Releasing ◄──────── Disabling ◄─────────────────────────┘

ASE Control Point Opcodes:
0x01 Config Codec       - Select codec and parameters (Idle → Codec Configured)
0x02 Config QoS         - Set CIG/CIS IDs and QoS params (Codec Configured → QoS Configured)
0x03 Enable             - Start ASE with metadata (QoS Configured → Enabling)
0x04 Receiver Start Ready - Signal receiver readiness (Enabling → Streaming, Source ASE only)
0x05 Disable            - Stop streaming (Streaming → Disabling)
0x06 Receiver Stop Ready - Signal receiver stopped (Source ASE)
0x07 Update Metadata    - Change metadata during streaming
0x08 Release            - Tear down ASE (any → Releasing → Idle)

Sink ASE (receives audio):
Config Codec → Codec Configured
Config QoS   → QoS Configured
Enable       → Enabling → Streaming (immediate, no Receiver Start Ready)

Source ASE (sends audio):
Config Codec → Codec Configured
Config QoS   → QoS Configured
Enable       → Enabling
             → CIS Established
             → Setup ISO Data Path Output (Controller→Host)
             → Receiver Start Ready → Streaming

Bidirectional (Sink + Source share CIG, often same CIS):
Both ASEs configured with same CIG ID, CIS IDs
Sink starts receiving immediately after Enable
Source waits for Receiver Start Ready
```