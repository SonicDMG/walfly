/**
 * beePioneer.ts
 *
 * BLE client for the Bee Pioneer wearable, built on react-native-ble-plx
 * (CoreBluetooth on iOS, BluetoothGatt on Android — both plain GATT; the
 * device does not use LE Audio).
 *
 * Lifecycle:
 *   const bee = new BeePioneerConnection(manager);
 *   await bee.connect();               // scans, connects, subscribes
 *   const battery = await bee.queryBattery();
 *   bee.onAudioFrame = (frame) => ...; // ADTS/AAC frames while unmuted
 *   await bee.startAudio();            // writes the 0xC006 [0x01] command
 *   ...
 *   await bee.stopAudio();             // writes the 0xC006 [0x00] command
 *   await bee.disconnect();
 *
 * Protocol details live in beeProtocol.ts (ported from the Omi project's
 * verified implementation).
 */

import { Platform } from 'react-native';
import { BleManager, Device, Subscription } from 'react-native-ble-plx';
import {
  BEE_AUDIO_CHARACTERISTIC_UUID,
  BEE_CONTROL_CHARACTERISTIC_UUID,
  BEE_SERVICE_UUID,
  BeeBatteryState,
  BeeCommand,
  BeeFirmwareVersion,
  AdtsFramer,
  base64ToBytes,
  bytesToBase64,
  encodeBeeCommand,
  parseBatteryState,
  parseBeeControlResponse,
  parseFirmwareVersion,
} from './beeProtocol';

const CONTROL_TIMEOUT_MS = 5000;
const SCAN_TIMEOUT_MS = 20000;

interface PendingCommand {
  code: number;
  resolve: (payload: number[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BeePioneerConnection {
  private device: Device | null = null;
  private controlSubscription: Subscription | null = null;
  private audioSubscription: Subscription | null = null;
  private pendingCommands: PendingCommand[] = [];
  private framer = new AdtsFramer();

  /** Called for every complete ADTS/AAC frame received from the device. */
  onAudioFrame: ((frame: Uint8Array) => void) | null = null;

  /** Called once if the link drops unexpectedly. */
  onDisconnect: ((error: Error | null) => void) | null = null;

  /** Diagnostic log sink (wire to console when debugging). */
  onLog: ((message: string) => void) | null = null;

  constructor(private manager: BleManager) {}

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Connects to a Bee Pioneer. If `preferredDeviceId` is given (from a prior
   * session) it is tried first, falling back to a scan filtered by the Bee
   * service UUID.
   */
  async connect(preferredDeviceId?: string): Promise<Device> {
    let device = await this.connectById(preferredDeviceId).catch(() => null);
    if (!device) device = await this.scanAndConnect();
    return device;
  }

  private async connectById(deviceId?: string): Promise<Device> {
    if (!deviceId) throw new Error('no remembered device id');
    const device = await this.manager.connectToDevice(deviceId, { timeout: 10000 });
    return this.finishConnection(device);
  }

  private async scanAndConnect(): Promise<Device> {
    const found = await new Promise<Device>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.manager.stopDeviceScan();
        reject(new Error('No Bee Pioneer found nearby. Make sure the device is on and not connected to the Bee app.'));
      }, SCAN_TIMEOUT_MS);

      this.manager.startDeviceScan([BEE_SERVICE_UUID], null, (error, device) => {
        if (error) {
          clearTimeout(timer);
          this.manager.stopDeviceScan();
          reject(error);
          return;
        }
        if (device) {
          clearTimeout(timer);
          this.manager.stopDeviceScan();
          resolve(device);
        }
      });
    });

    const connected = await found.connect({ timeout: 10000 });
    return this.finishConnection(connected);
  }

  private async finishConnection(device: Device): Promise<Device> {
    await device.discoverAllServicesAndCharacteristics();

    // Larger MTU on Android carries more AAC bytes per notification; iOS
    // negotiates automatically. Failures are non-fatal — framing handles
    // fragments either way.
    if (Platform.OS === 'android') {
      await device.requestMTU(517).catch(() => undefined);
    }

    this.device = device;
    this.startControlMonitor(device);
    this.startAudioMonitor(device);

    const lost = device.onDisconnected((error) => {
      lost.remove();
      this.cleanupSubscriptions();
      this.device = null;
      this.onDisconnect?.(error ?? null);
    });

    this.log(`connected to ${device.name ?? device.id}`);
    return device;
  }

  private startControlMonitor(device: Device): void {
    this.controlSubscription = device.monitorCharacteristicForService(
      BEE_SERVICE_UUID,
      BEE_CONTROL_CHARACTERISTIC_UUID,
      (error, characteristic) => {
        if (error) {
          this.log(`control monitor error: ${error.message}`);
          return;
        }
        if (!characteristic?.value) return;
        const response = parseBeeControlResponse(base64ToBytes(characteristic.value));
        this.resolvePending(response.code, response.payload);
      },
    );
  }

  private startAudioMonitor(device: Device): void {
    this.audioSubscription = device.monitorCharacteristicForService(
      BEE_SERVICE_UUID,
      BEE_AUDIO_CHARACTERISTIC_UUID,
      (error, characteristic) => {
        if (error) {
          this.log(`audio monitor error: ${error.message}`);
          return;
        }
        if (!characteristic?.value) return;

        const bytes = base64ToBytes(characteristic.value);
        if (bytes.length <= 2) return; // header-only notification

        // Bytes 0..1 are a per-notification header; the rest is ADTS AAC.
        const frames = this.framer.push(bytes.subarray(2));
        for (const frame of frames) this.onAudioFrame?.(frame);
      },
    );
  }

  private resolvePending(code: number, payload: number[]): void {
    const index = this.pendingCommands.findIndex((p) => p.code === code);
    if (index < 0) return;
    const pending = this.pendingCommands.splice(index, 1)[0];
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  /**
   * Writes a command to the control characteristic and resolves with the
   * device's response payload, or null on timeout (matching Omi's behavior:
   * a missing ack is treated as "no answer", not an error).
   */
  private async sendCommand(commandCode: number, payload: number[] = []): Promise<number[] | null> {
    const device = this.requireDevice();

    return new Promise<number[] | null>((resolve) => {
      const pending: PendingCommand = {
        code: commandCode,
        resolve,
        timer: setTimeout(() => {
          const index = this.pendingCommands.indexOf(pending);
          if (index >= 0) this.pendingCommands.splice(index, 1);
          resolve(null);
        }, CONTROL_TIMEOUT_MS),
      };
      this.pendingCommands.push(pending);

      const bytes = encodeBeeCommand(commandCode, payload);
      device
        .writeCharacteristicWithResponseForService(
          BEE_SERVICE_UUID,
          BEE_CONTROL_CHARACTERISTIC_UUID,
          bytesToBase64(bytes),
        )
        .catch((error) => {
          const index = this.pendingCommands.indexOf(pending);
          if (index >= 0) this.pendingCommands.splice(index, 1);
          clearTimeout(pending.timer);
          this.log(`command 0x${commandCode.toString(16)} write failed: ${String(error)}`);
          resolve(null);
        });
    });
  }

  async queryFirmware(): Promise<BeeFirmwareVersion | null> {
    const payload = await this.sendCommand(BeeCommand.GET_FIRMWARE_VERSION);
    return payload ? parseFirmwareVersion(payload) : null;
  }

  async queryBattery(): Promise<BeeBatteryState | null> {
    const payload = await this.sendCommand(BeeCommand.BATTERY);
    return payload ? parseBatteryState(payload) : null;
  }

  /** Starts the mic stream (device unmutes and begins audio notifications). */
  async startAudio(): Promise<boolean> {
    this.framer.reset();
    const payload = await this.sendCommand(BeeCommand.MUTE, [0x01]);
    this.log(payload ? 'audio start acknowledged' : 'audio start: no ack (continuing)');
    return payload !== null;
  }

  /** Stops the mic stream. */
  async stopAudio(): Promise<void> {
    await this.sendCommand(BeeCommand.MUTE, [0x00]);
    this.framer.reset();
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  async disconnect(): Promise<void> {
    const device = this.device;
    this.cleanupSubscriptions();
    this.device = null;
    if (device) {
      await device.cancelConnection().catch(() => undefined);
    }
  }

  private cleanupSubscriptions(): void {
    this.controlSubscription?.remove();
    this.controlSubscription = null;
    this.audioSubscription?.remove();
    this.audioSubscription = null;
    for (const pending of this.pendingCommands) clearTimeout(pending.timer);
    this.pendingCommands = [];
  }

  private requireDevice(): Device {
    if (!this.device) throw new Error('Bee Pioneer is not connected');
    return this.device;
  }

  get isConnected(): boolean {
    return this.device !== null;
  }

  get connectedDeviceId(): string | null {
    return this.device?.id ?? null;
  }

  private log(message: string): void {
    this.onLog?.(`[BeePioneer] ${message}`);
  }
}