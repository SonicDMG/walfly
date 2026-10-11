/**
 * beeProtocol.ts
 *
 * The verified Bee Pioneer BLE protocol, as reverse-engineered by the Omi
 * project (github.com/BasedHardware/omi — connectors/bee_connection.dart and
 * BeeDeviceConnection.swift) and cross-checked against this app's needs.
 *
 * There is no LE Audio here: the device is a plain GATT peripheral.
 *
 *   Service  03d5d5c4-a86c-11ee-9d89-8f2089a49e7e
 *     control  05e1f93c-d8d0-5ed8-dd88-379e4c1a3e3e  (write w/ response + notify)
 *     audio    b189a505-a86c-11ee-a5fb-8f2089a49e7e  (notify)
 *
 * The control channel carries little-endian 16-bit command IDs plus a payload;
 * the device answers on the same characteristic with a 16-bit response code,
 * where 0x8000 means "echoed command follows" (code then payload).
 *
 * Audio arrives as notify packets whose first two bytes are a per-packet
 * header to be discarded; the rest is a stream of ADTS-framed AAC. One
 * notification may contain several frames, a partial frame, or — after a
 * dropped packet — junk before the next sync word, so framing is done with a
 * resync-capable scanner (see AdtsFramer).
 *
 * This module is deliberately dependency-free so it can be unit-tested and
 * reused anywhere (app, scripts, a future desktop tool).
 */

// ─── BLE identifiers ─────────────────────────────────────────────────────────

export const BEE_SERVICE_UUID = '03d5d5c4-a86c-11ee-9d89-8f2089a49e7e';
export const BEE_CONTROL_CHARACTERISTIC_UUID = '05e1f93c-d8d0-5ed8-dd88-379e4c1a3e3e';
export const BEE_AUDIO_CHARACTERISTIC_UUID = 'b189a505-a86c-11ee-a5fb-8f2089a49e7e';

/** Lowercase forms for case-insensitive comparisons (CoreBluetooth normalizes to upper). */
export const BEE_UUIDS_LOWER = {
  service: BEE_SERVICE_UUID.toLowerCase(),
  control: BEE_CONTROL_CHARACTERISTIC_UUID.toLowerCase(),
  audio: BEE_AUDIO_CHARACTERISTIC_UUID.toLowerCase(),
} as const;

// ─── Command codes ───────────────────────────────────────────────────────────

export const BeeCommand = {
  /** Response payload: [patch, minor, major]. */
  GET_FIRMWARE_VERSION: 0xc005,
  /** Payload [0x01] starts audio, [0x00] stops it (mute). */
  MUTE: 0xc006,
  /** Response payload: [level, isCharging]. */
  BATTERY: 0xc00f,
} as const;

/** Builds a command packet: little-endian cmd ID followed by payload bytes. */
export function encodeBeeCommand(commandCode: number, payload: readonly number[] = []): Uint8Array {
  return Uint8Array.from([
    commandCode & 0xff,
    (commandCode >> 8) & 0xff,
    ...payload.map((b) => b & 0xff),
  ]);
}

export type BeeControlResponse =
  | { type: 'response'; code: number; payload: number[] }
  | { type: 'echo'; code: number; payload: number[] };

/**
 * Parses one control notification.
 *  - bytes[0..1]  little-endian response code
 *  - if that code is 0x8000, bytes[2..3] echo the command ID and the real
 *    payload follows; otherwise the code is the command ID and the payload
 *    follows immediately.
 */
export function parseBeeControlResponse(data: ArrayLike<number>): BeeControlResponse {
  if (data.length < 2) return { type: 'response', code: -1, payload: [] };

  const responseCode = (data[0] & 0xff) | ((data[1] & 0xff) << 8);
  const rest = Array.from(data).slice(2);

  if (responseCode === 0x8000 && rest.length >= 2) {
    const echoedCmd = (rest[0] & 0xff) | ((rest[1] & 0xff) << 8);
    return { type: 'response', code: echoedCmd, payload: rest.slice(2) };
  }

  return { type: 'response', code: responseCode, payload: rest };
}

export interface BeeFirmwareVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Decodes the GET_FIRMWARE_VERSION payload ([patch, minor, major]). */
export function parseFirmwareVersion(payload: ArrayLike<number>): BeeFirmwareVersion | null {
  if (payload.length < 3) return null;
  return { patch: payload[0] & 0xff, minor: payload[1] & 0xff, major: payload[2] & 0xff };
}

export interface BeeBatteryState {
  level: number;
  isCharging: boolean;
}

/** Decodes the BATTERY payload ([level, isCharging]). */
export function parseBatteryState(payload: ArrayLike<number>): BeeBatteryState | null {
  if (payload.length < 2) return null;
  return { level: payload[0] & 0xff, isCharging: (payload[1] & 0xff) !== 0 };
}

// ─── ADTS framing ────────────────────────────────────────────────────────────

const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025, 8000, 7350,
] as const;

/**
 * ADTS frame length in bytes, from the 7-byte header:
 *   (header[3] & 0x03) << 11 | header[4] << 3 | (header[5] & 0xE0) >> 5
 */
export function adtsFrameLength(header: ArrayLike<number>): number {
  return ((header[3] & 0x03) << 11) | (header[4] << 3) | ((header[5] & 0xe0) >> 5);
}

/** Sampling rate declared in an ADTS header. */
export function adtsSampleRate(header: ArrayLike<number>): number | null {
  const index = (header[2] & 0x3c) >> 2;
  return ADTS_SAMPLE_RATES[index] ?? null;
}

/** Channel configuration declared in an ADTS header (1 = mono, 2 = stereo). */
export function adtsChannelCount(header: ArrayLike<number>): number {
  return ((header[2] & 0x01) << 2) | ((header[3] & 0xc0) >> 6);
}

/**
 * Incremental ADTS/AAC frame scanner.
 *
 * Feed it every audio notification payload (after the 2-byte header is
 * stripped); it returns each complete frame it can now produce.
 *
 * Robustness rules (ported from Omi's tested Swift implementation):
 *  - bytes before a valid sync word are dropped one at a time (resync);
 *  - a sync word whose derived frame length is < 7 is a false positive
 *    (e.g. 0xFF 0xFx appearing inside AAC payload after a dropped packet),
 *    so exactly one byte is skipped and scanning continues — treating it as
 *    a frame would wedge the scanner and silence the stream permanently.
 */
export class AdtsFramer {
  private buffer: number[] = [];

  /** Push notification bytes and drain every complete frame. */
  push(bytes: ArrayLike<number>): Uint8Array[] {
    for (let i = 0; i < bytes.length; i++) this.buffer.push(bytes[i] & 0xff);

    const frames: Uint8Array[] = [];
    for (;;) {
      const frame = this.takeFrame();
      if (!frame) break;
      frames.push(frame);
    }
    return frames;
  }

  /** Bytes currently held back (a partial frame). */
  get bufferedBytes(): number {
    return this.buffer.length;
  }

  /** Drops all buffered bytes — call at recording-session boundaries. */
  reset(): void {
    this.buffer = [];
  }

  private takeFrame(): Uint8Array | null {
    while (this.buffer.length >= 7) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];

      // ADTS sync: 12 bits set (0xFF 0xF?).
      const hasSync = b0 === 0xff && (b1 & 0xf0) === 0xf0;
      if (!hasSync) {
        this.buffer.shift();
        continue;
      }

      const frameLength = adtsFrameLength(this.buffer);
      if (frameLength < 7) {
        // False sync inside payload — skip one byte and keep scanning.
        this.buffer.shift();
        continue;
      }

      if (this.buffer.length >= frameLength) {
        const frame = Uint8Array.from(this.buffer.slice(0, frameLength));
        this.buffer.splice(0, frameLength);
        return frame;
      }
      break; // header seen, body still arriving
    }
    return null;
  }
}

// ─── Byte helpers ────────────────────────────────────────────────────────────

/** Concatenates byte arrays into one Uint8Array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Decodes a base64 string (as delivered by react-native-ble-plx) to bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(256).fill(-1);
  for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i;

  const clean = base64.replace(/=+$/, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i++) {
    const value = lookup[clean.charCodeAt(i)];
    if (value < 0) continue; // whitespace/newlines
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex++] = (accumulator >> bits) & 0xff;
    }
  }
  return outIndex === out.length ? out : out.subarray(0, outIndex);
}

/** Encodes bytes as base64 (the wire format react-native-ble-plx expects). */
export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? alphabet[b2 & 0x3f] : '=';
  }
  return out;
}