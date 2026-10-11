# Bee Pioneer BLE GATT Services Research

> **SUPERSEDED (Oct 2026).** This document inferred a standard LE Audio stack
> (ASCS/PACS/LC3 over ISO). The device was later confirmed to use plain GATT
> with ADTS-framed AAC — see `verified_protocol.md` in this folder for the
> verified protocol and sources (Omi project's shipped implementations).
> Kept for the record of the (incorrect) inference chain.

## Research Objective
Find all documented or discovered BLE service UUIDs, characteristic UUIDs, and their properties (read/write/notify) for the Bee Pioneer device. This includes both standard Bluetooth SIG services and any custom/vendor-specific services.

---

## Key Question 1: What GATT services does the Bee Pioneer expose? (Service UUIDs, 16-bit or 128-bit)

### Takeaway
Based on FCC certification (FCC ID: 2BN4DPIONEERAUDIOV1) classifying the device as a "Wireless Bluetooth LE Microphone" and its function as an always-listening AI wearable with dual microphones that streams audio to a phone for transcription, the Bee Pioneer almost certainly implements standard **Bluetooth LE Audio** GATT services. No custom/vendor-specific service UUIDs have been publicly documented or reverse-engineered.

### Cited Findings
- **FCC Certification**: The Bee Pioneer (model PIONEERAUDIOV1) is certified as a "Wireless Bluetooth LE Microphone" under FCC ID 2BN4DPIONEERAUDIOV1 by Bluush Inc. — [FCC ID 2BN4DPIONEERAUDIOV1](https://fccid.io/2BN4DPIONEERAUDIOV1)
- **Device Architecture**: The device uses "Nordic nRF52/nRF53" SoCs per industry analysis of ambient AI hardware category — [The Ambient-AI Hardware Category](https://medium.com/@chierhu/the-ambient-ai-hardware-category-240eefae10f6)
- **Bluetooth LE Audio Services**: As a Bluetooth LE microphone/headset device, it must implement the standard LE Audio GATT services defined by Bluetooth SIG:
  - **Generic Access Profile (GAP)** — Service UUID: `0x1800` (16-bit)
  - **Generic Attribute Profile (GATT)** — Service UUID: `0x1801` (16-bit)
  - **Microphone Control Service (MICS)** — Service UUID: `0x184D` (16-bit) — [Bluetooth SIG MICS Spec](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/22708-MICS-html5/out/en/index-en.html)
  - **Audio Input Control Service (AICS)** — Service UUID: `0x1843` (16-bit) — [Zephyr AICS UUID](https://docs.zephyrproject.org/latest/doxygen/html/group__bt__uuid.html)
  - **Audio Stream Control Service (ASCS)** — Service UUID: `0x184E` (16-bit) — [Zephyr ASCS UUID](https://docs.zephyrproject.org/latest/doxygen/html/bluetooth_2uuid_8h.html)
  - **Published Audio Capabilities Service (PACS)** — Service UUID: `0x1850` (16-bit) — [Bluetooth SIG PACS Spec](https://www.bluetooth.com/specifications/specs/published-audio-capabilities-service-1-0-1/)
  - **Broadcast Audio Scan Service (BASS)** — Service UUID: `0x184F` (16-bit)
  - **Basic Audio Announcement Service (BAAS)** — Service UUID: `0x1851` (16-bit)
  - **Battery Service (BAS)** — Service UUID: `0x180F` (16-bit) — standard for battery level reporting
  - **Device Information Service (DIS)** — Service UUID: `0x180A` (16-bit) — standard for firmware/hardware revision

### Inferences
- The Bee Pioneer uses **standard 16-bit Bluetooth SIG-assigned UUIDs** for all LE Audio services, not custom 128-bit UUIDs
- The device operates as a **LE Audio Unicast Server** (audio source) with the phone as Unicast Client
- Audio streaming uses **LC3 codec** over ISOchronous channels (CIS), not GATT characteristics
- GATT services are used for **control and configuration** (mute, gain, stream setup, capabilities exchange), not audio payload transport

### Gaps
- No public nRF Connect / BLE scanner dumps showing the exact service list on a real Bee Pioneer device
- No confirmation of which optional LE Audio services are implemented (e.g., Hearing Access Service 0x1854, Coordinated Set Identification Service 0x1855)
- Unknown if any proprietary/vendor-specific 128-bit service exists for device-specific features (firmware update, button events, LED control, sensor data)

---

## Key Question 2: What characteristics exist under each service? (Characteristic UUIDs, properties: read, write, notify, indicate)

### Takeaway
All characteristics are defined by Bluetooth SIG specifications for the standard LE Audio services. The Bee Pioneer, as a microphone device, implements the mandatory characteristics for each service.

### Cited Findings

#### Microphone Control Service (MICS) — UUID: 0x184D
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Mute | 0x2B70 | Read, Write, Notify | Mute state: 0x00=Not Muted, 0x01=Muted, 0x02=Disabled — [Bluetooth SIG MICS Spec](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/22708-MICS-html5/out/en/index-en.html) |

#### Audio Input Control Service (AICS) — UUID: 0x1843
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Gain Setting Properties | 0x2B71 | Read | Describes gain range, step, units |
| Gain Setting | 0x2B72 | Read, Write, Notify | Current gain value |
| Input Type | 0x2B73 | Read | Type of audio input (microphone, etc.) |
| Input Status | 0x2B74 | Read, Notify | Active/inactive status |
| Input Description | 0x2B75 | Read, Write | User-friendly name |
| Gain Mode | 0x2B76 | Read, Write, Notify | Manual/Automatic gain control |

#### Audio Stream Control Service (ASCS) — UUID: 0x184E
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| ASE Control Point | 0x2B77 | Write, Notify | Commands to configure/control Audio Stream Endpoints (ASE) |
| ASE State | 0x2B78 | Read, Notify | Current state of each ASE (Idle, Configuring, QoS Configuring, Enabling, Streaming, Disabling, Releasing) |

#### Published Audio Capabilities Service (PACS) — UUID: 0x1850
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Sink PAC | 0x2B79 | Read, Notify | Audio capabilities for sink (receiver) role |
| Source PAC | 0x2B7A | Read, Notify | Audio capabilities for source (transmitter) role — **Bee Pioneer uses this** |
| Available Audio Contexts | 0x2B7B | Read, Notify | Currently available contexts |
| Supported Audio Contexts | 0x2B7C | Read | All supported contexts |

#### Broadcast Audio Scan Service (BASS) — UUID: 0x184F
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Broadcast Audio Scan Control Point | 0x2B7D | Write, Notify | Control scanning for broadcast audio |
| Broadcast Receive State | 0x2B7E | Read, Notify | State of broadcast audio reception |

#### Battery Service (BAS) — UUID: 0x180F
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Battery Level | 0x2A19 | Read, Notify | 0-100% battery level |

#### Device Information Service (DIS) — UUID: 0x180A
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Manufacturer Name String | 0x2A29 | Read | "Bluush Inc" or "Bee" |
| Model Number String | 0x2A24 | Read | "PIONEERAUDIOV1" |
| Firmware Revision String | 0x2A26 | Read | Firmware version |
| Hardware Revision String | 0x2A27 | Read | Hardware revision |
| Serial Number String | 0x2A25 | Read | Device serial number |

#### Generic Access Profile (GAP) — UUID: 0x1800
| Characteristic | UUID | Properties | Description |
|---|---|---|---|
| Device Name | 0x2A00 | Read | Advertising name (likely "Bee Pioneer" or "Bee") |
| Appearance | 0x2A01 | Read | Category: Microphone (0x0400) or Generic Wearable |
| Peripheral Preferred Connection Parameters | 0x2A04 | Read | Connection interval, latency, timeout |

### Inferences
- All characteristics use standard 16-bit Bluetooth SIG-assigned UUIDs
- The **Mute characteristic (0x2B70)** in MICS maps directly to the Bee Pioneer's physical action button (short press = mute/unmute)
- **ASE Control Point (0x2B77)** and **ASE State (0x2B78)** in ASCS handle the audio stream lifecycle (setup, start, stop)
- **Source PAC (0x2B7A)** in PACS advertises the device's LC3 codec capabilities, sample rates, frame durations, and supported audio contexts (likely "Conversation" context 0x02)

### Gaps
- Exact characteristic UUID values for some services (many are newly assigned 16-bit values in 0x2B7x range)
- Whether Audio Input Control Service (AICS) is included in MICS topology (device has dual mics, may have 2 AICS instances)
- No confirmation of optional characteristics like Input Description (0x2B75) or Gain Mode (0x2B76)
- Unknown if any custom/vendor-specific characteristics exist for: button press events (double-press, long-press), LED control, motion sensor data, firmware update trigger

---

## Key Question 3: Are there any known custom service UUIDs specific to Bee/Bee Pioneer?

### Takeaway
**No custom/vendor-specific service UUIDs have been publicly documented or discovered.** The device appears to use only standard Bluetooth SIG LE Audio services based on its FCC classification and Nordic nRF52/nRF53 architecture.

### Cited Findings
- **No GitHub repositories** contain Bee Pioneer BLE reverse engineering with custom UUIDs — search of GitHub for "Bee Pioneer BLE", "bee.computer BLE", "PIONEERAUDIOV1 GATT" returns no results
- **No Reddit/forum posts** with nRF Connect screenshots showing custom services — [r/Bee_computer "Can't connect" thread](https://www.reddit.com/r/Bee_computer/comments/1k9os3y/cant_connect/) mentions BLE Scanner app but no GATT details
- **Bee CLI and Developer API** are cloud-based (HTTPS/MCP), not local BLE — [Bee CLI GitHub](https://github.com/bee-computer/bee-cli), [Bee Developer Docs](https://docs.bee.computer/)
- **Bluetooth SIG Assigned Numbers** show no 16-bit UUID assigned to Bluush Inc or Bee Computer — [Bluetooth SIG Assigned Numbers](https://www.bluetooth.com/specifications/assigned-numbers/)

### Inferences
- Bee Pioneer likely uses **pure standard LE Audio** implementation from Nordic SDK (nRF Connect SDK)
- Any device-specific features (button actions, LED patterns, sensor data) may be:
  - Handled entirely on-device (no BLE exposure)
  - Communicated via standard HID or battery services
  - Tunnelled through a vendor-specific characteristic in a standard service (unlikely per SIG conformance)
- Firmware updates likely use **Nordic Semiconductor's proprietary DFU service** (UUID: `FE59` 16-bit or Nordic's 128-bit DFU UUID) or standard LE Audio firmware update mechanisms

### Gaps
- **Critical**: No actual BLE packet captures or nRF Connect service discovery logs from a real Bee Pioneer device
- Unknown if a **custom 128-bit service** exists for: OTA firmware update (Nordic DFU), device configuration, button event notifications, sensor data (accelerometer for tap detection), LED control
- Nordic DFU service UUIDs (if used): Legacy DFU `00001530-1212-EFDE-1523-785FEABCD123`, Secure DFU `FE59` (16-bit) or `8EC90001-F315-4F60-9FB8-838830DAEA50` (128-bit)

---

## Key Question 4: What is the device name / advertising name it broadcasts?

### Takeaway
The advertising name is likely **"Bee Pioneer"** or **"Bee"**, but this has not been confirmed via BLE scanner logs.

### Cited Findings
- **FCC E-Label Information** shows the device has an electronic label — [FCC E-Label](https://fccid.io/2BN4DPIONEERAUDIOV1/Label/E-Label-Information-8346511)
- **Reddit user reports** "multiple 'Bee' devices" in Bluetooth settings — [r/OmiAI thread](https://www.reddit.com/r/OmiAI/comments/1pirvyl/bee_wearable_ai_link_up_with_omi/)
- **Bee Pioneer product page** shows the device name as "Bee Pioneer" — [Bee Pioneer Product](https://bee.computer/bee-pioneer)
- **GAP Device Name characteristic (0x2A00)** in service 0x1800 contains the advertising name

### Inferences
- Advertising name likely: `"Bee Pioneer"` or `"Bee"` (possibly with serial number suffix for disambiguation)
- Advertising data likely includes:
  - **Service UUIDs**: 0x184D (MICS), 0x184E (ASCS), 0x1850 (PACS) — per LE Audio advertising requirements
  - **Appearance**: 0x0400 (Microphone) or 0x0480 (Generic Wearable)
  - **LE Audio Broadcast ID** if supporting Auracast (unlikely for microphone-only device)

### Gaps
- **No captured advertising packets** from a real device
- Unknown if name changes based on state (pairing mode, connected, muted, firmware update mode)
- Unknown manufacturer data content in advertising packets (may contain battery level, firmware version, device state)

---

## Key Question 5: Any known firmware update service (DFU) UUIDs?

### Takeaway
**No Bee-specific DFU service documented.** As a Nordic nRF52/nRF53-based device, it likely uses **Nordic Semiconductor's DFU services** (proprietary but well-known).

### Cited Findings
- **Nordic nRF52/nRF53 SoC** used in Bee Pioneer — [The Ambient-AI Hardware Category](https://medium.com/@chierhu/the-ambient-ai-hardware-category-240eefae10f6)
- **Nordic Legacy DFU Service** — 128-bit UUID: `00001530-1212-EFDE-1523-785FEABCD123` (service), `00001531-1212-EFDE-1523-785FEABCD123` (control point), `00001532-1212-EFDE-1523-785FEABCD123` (packet) — [Nordic Legacy DFU](https://docs.nordicsemi.com/r/bundle/nrf5_sdk_v15.3.0/page/group_nrf_dfu_ble.html)
- **Nordic Secure DFU (Buttonless)** — 16-bit UUID: `0xFE59` (service), with characteristics for control point and packet — [Nordic Secure DFU](https://novelbits.io/ota-device-firmware-update-part-2/)
- **Reddit reports** firmware updates via Bee Android app — [r/Bee_computer "firmware update" thread](https://www.reddit.com/r/Bee_computer/comments/1rw93ai/bee_for_android_firmware_update/)
- **r/OmiAI thread** mentions "active Github issue around OTA" for Bee Pioneer — [r/OmiAI](https://www.reddit.com/r/OmiAI/comments/1pjombo/updating_bee_firmware_for_omi/)

### Inferences
- Firmware updates delivered via **Bee mobile app** → BLE → Device (Nordic DFU)
- Device likely enters **DFU mode** via: button combination (5x rapid press per FAQ), or app command
- **Nordic DFU services** are well-documented and supported by `nRF Connect for Mobile` app
- If using **Secure DFU (buttonless)**, the service UUID `0xFE59` appears in advertising when in DFU mode

### Gaps
- **Critical**: No confirmation of which DFU variant (Legacy vs Secure vs Buttonless) Bee Pioneer uses
- Unknown if Bee uses **custom 128-bit DFU UUID** (some vendors customize)
- No captured DFU service advertisement or connection sequence
- Unknown if DFU requires **bonding/authentication** (likely yes for security)

---

## Summary of Known vs Unknown

| Category | Known (Standard SIG) | Unknown / Needs Verification |
|---|---|---|
| **Services** | GAP (0x1800), GATT (0x1801), MICS (0x184D), AICS (0x1843), ASCS (0x184E), PACS (0x1850), BASS (0x184F), BAS (0x180F), DIS (0x180A) | Custom 128-bit services for: DFU, button events, LED, sensors, device config |
| **Characteristics** | All standard LE Audio + BAS + DIS + GAP characteristics | Vendor-specific characteristics in standard services; custom service characteristics |
| **Advertising** | Likely includes MICS, ASCS, PACS UUIDs; name "Bee Pioneer" | Exact name, manufacturer data, appearance value, TX power |
| **DFU** | Nordic Legacy/Secure DFU patterns | Which variant, exact UUIDs, trigger method, auth requirements |
| **Audio Transport** | LC3 over CIS (ISOchronous), not GATT | Codec config (sample rate, frame duration, octets per frame) |

---

## Recommended Next Steps for Complete Discovery

1. **Capture advertising packets** using nRF Connect for Mobile / nRF Sniffer / Wireshark + nRF52840 dongle
2. **Connect and enumerate GATT services** on a real Bee Pioneer device
3. **Document exact service/characteristic handles, UUIDs, and properties**
4. **Test DFU mode entry** (5x button press per FAQ: "rapidly pressing the action button five times until the light flashes blue-green")
5. **Monitor BLE traffic** during: pairing, audio streaming start/stop, mute toggle, firmware update
6. **Check for HID service** (0x1812) if button events exposed as HID input reports

---

## Sources Summary

| Source | Type | Relevance |
|---|---|---|
| FCC ID 2BN4DPIONEERAUDIOV1 | Primary (regulatory) | Device classification, model, manufacturer |
| Bluetooth SIG MICS/PACS/ASCS/AICS Specs | Primary (standards) | Service/characteristic UUIDs, properties, behavior |
| Nordic Semiconductor SDK/DFU docs | Primary (vendor) | Likely SoC, DFU implementation patterns |
| Bee CLI / Developer Docs | Primary (vendor) | Confirms cloud API architecture, no local BLE API |
| Reddit r/Bee_computer / r/OmiAI | Secondary (community) | User reports on pairing, firmware updates, issues |
| Medium "Ambient-AI Hardware Category" | Secondary (analysis) | Confirms Nordic nRF52/nRF53 SoC usage |

---

## Research Limitations
- **No direct BLE captures** from a physical Bee Pioneer device were available
- All service/characteristic data is **inferred from Bluetooth SIG specifications** for LE Audio microphone devices
- **Custom/vendor-specific extensions** (if any) remain completely undocumented
- Findings should be **validated against real device** before relying for development