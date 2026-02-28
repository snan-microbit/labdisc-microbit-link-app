/**
 * bridge.js — Data bridge orchestrator
 * 
 * Coordinates the flow: Labdisc → decode → convert → format → micro:bit
 * 
 * Auto-stream rules:
 * - Both devices connected → auto-start streaming
 * - micro:bit disconnects during auto-stream → auto-stop
 * - Manual stream (button) → works without micro:bit, no auto-stop
 */

import { LabdiscConnection, ConnectionState } from '../labdisc/connection.js';
import { MicrobitBLE, BleState } from '../microbit/ble-uart.js';
import { formatForUART, formatForDisplay } from './formatter.js';

export class Bridge {
  constructor() {
    this.labdisc = new LabdiscConnection();
    this.microbit = new MicrobitBLE();

    this.displayValues = [];
    this.lastUartLine = '';
    this.uartSentCount = 0;
    this.mode = 'normal'; // 'normal' (0x81, 1Hz) or 'fast' (0x84, 25Hz)

    /** true if streaming was started by auto-stream (not manual button) */
    this._autoStarted = false;

    this.onUpdate = null;
    this.onLog = null;

    this._wireLabdisc();
    this._wireMicrobit();
  }

  // ─── Public API ───

  async connectLabdisc() { await this.labdisc.connect(); }
  async disconnectLabdisc() { await this.labdisc.disconnect(); this._update(); }
  async connectMicrobit() { await this.microbit.connect(); }
  async disconnectMicrobit() { await this.microbit.disconnect(); this._update(); }

  setMode(mode) {
    if (mode !== 'normal' && mode !== 'fast') return;
    this.mode = mode;
    this._update();
  }

  /** Manual start — works without micro:bit */
  async manualStartStream() {
    if (!this.labdisc.isConnected || this.labdisc.isStreaming) return;
    this._autoStarted = false;
    await this._startStreaming();
  }

  /** Manual stop */
  async manualStopStream() {
    if (!this.labdisc.isStreaming) return;
    this._autoStarted = false;
    await this.labdisc.stopStreaming();
    this._update();
  }

  getState() {
    return {
      labdisc: this.labdisc.state,
      microbit: this.microbit.state,
      mode: this.mode,
      sensorIds: this.labdisc.sensorIds,
      deviceStatus: this.labdisc.deviceStatus,
      displayValues: this.displayValues,
      lastUartLine: this.lastUartLine,
      uartSentCount: this.uartSentCount,
      packetCount: this.labdisc.parser.packetCount,
    };
  }

  // ─── Private: wire events ───

  _wireLabdisc() {
    this.labdisc.onStateChange = (state) => {
      this._log('info', `Labdisc: ${state}`);
      this._checkAutoStream();
      this._update();
    };

    this.labdisc.onSensorIds = (ids) => {
      this._log('info', `Labdisc: ${ids.length} sensores detectados`);
      this._update();
    };

    this.labdisc.onStatus = () => this._update();

    this.labdisc.onData = (values, count) => {
      this.displayValues = formatForDisplay(values);

      const line = formatForUART(values);
      this.lastUartLine = line.trim();

      if (this.microbit.isConnected) {
        this.microbit.send(line);
        this.uartSentCount++;
      }

      this._update();
    };

    this.labdisc.onLog = (type, msg) => this._log(type, `[Labdisc] ${msg}`);
  }

  _wireMicrobit() {
    this.microbit.onStateChange = (state) => {
      this._log('info', `micro:bit: ${state}`);
      this._checkAutoStream();
      this._update();
    };
    this.microbit.onReceive = (text) => this._log('rx', `[micro:bit] ${text.trim()}`);
    this.microbit.onLog = (type, msg) => this._log(type, `[BLE] ${msg}`);
  }

  // ─── Auto-stream logic ───

  _checkAutoStream() {
    const labReady = this.labdisc.state === ConnectionState.CONNECTED;
    const microReady = this.microbit.state === BleState.CONNECTED;
    const streaming = this.labdisc.isStreaming;

    // Both connected + not streaming → auto-start
    if (labReady && microReady && !streaming && this.labdisc.sensorIds.length > 0) {
      this._log('info', 'Ambos conectados — auto-start streaming');
      this._autoStarted = true;
      this._startStreaming();
    }

    // micro:bit lost + was auto-started → auto-stop (save battery)
    // Manual streams are NOT stopped — user controls them
    if (!microReady && streaming && this._autoStarted) {
      this._log('info', 'micro:bit perdida — auto-stop streaming');
      this._autoStarted = false;
      this.labdisc.stopStreaming();
    }
  }

async _startStreaming() {
    if (this.mode === 'fast') {
      await this.labdisc.startFast();
    } else {
      await this.labdisc.startNormal();
    }
    this.uartSentCount = 0;
  }

  _update() { if (this.onUpdate) this.onUpdate(); }
  _log(type, msg) { if (this.onLog) this.onLog(type, msg); }
}