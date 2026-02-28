/**
 * bridge.js — Data bridge orchestrator
 * 
 * Coordinates the flow: Labdisc → decode → convert → format → micro:bit
 * 
 * Responsibilities:
 * - Listens for Labdisc data events
 * - Converts values to UART CSV format
 * - Sends formatted data to the micro:bit
 * - Manages auto-start/stop based on connection state of both devices
 */

import { LabdiscConnection, ConnectionState } from '../labdisc/connection.js';
import { MicrobitBLE, BleState } from '../microbit/ble-uart.js';
import { formatForUART, formatForDisplay } from './formatter.js';

export class Bridge {
  constructor() {
    /** @type {LabdiscConnection} */
    this.labdisc = new LabdiscConnection();

    /** @type {MicrobitBLE} */
    this.microbit = new MicrobitBLE();

    /** @type {Object[]} Latest display values for UI */
    this.displayValues = [];

    /** @type {string} Latest UART line sent */
    this.lastUartLine = '';

    /** @type {number} Count of UART messages sent to micro:bit */
    this.uartSentCount = 0;

    /** @type {string} Streaming mode: 'normal' (0x81, 1Hz) or 'fast' (0x84, 25Hz) */
    this.mode = 'normal';

    // ─── Callbacks ───
    
    /** @type {function()} Called when any state changes (for UI refresh) */
    this.onUpdate = null;

    /** @type {function(string, string)} Log (type, message) */
    this.onLog = null;

    // ─── Wire internal events ───
    this._wireLabdisc();
    this._wireMicrobit();
  }

  // ─── Public API ───

  /** Connect to Labdisc */
  async connectLabdisc() {
    await this.labdisc.connect();
  }

  /** Disconnect from Labdisc */
  async disconnectLabdisc() {
    await this.labdisc.disconnect();
    this._update();
  }

  /** Connect to micro:bit */
  async connectMicrobit() {
    await this.microbit.connect();
  }

  /** Disconnect from micro:bit */
  async disconnectMicrobit() {
    await this.microbit.disconnect();
    this._update();
  }

  /** Set streaming mode */
  setMode(mode) {
    if (mode !== 'normal' && mode !== 'fast') return;
    this.mode = mode;
    this._update();
  }

  /** Get summary of current state */
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

  // ─── Private: wire Labdisc events ───

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

    this.labdisc.onStatus = (status) => {
      this._update();
    };

    this.labdisc.onData = (values, count) => {
      // Update display values
      this.displayValues = formatForDisplay(values);

      // If micro:bit is connected, send data
      if (this.microbit.isConnected) {
        const line = formatForUART(values);
        this.lastUartLine = line.trim();
        this.microbit.send(line);
        this.uartSentCount++;
      }

      this._update();
    };

    this.labdisc.onLog = (type, msg) => {
      this._log(type, `[Labdisc] ${msg}`);
    };
  }

  // ─── Private: wire micro:bit events ───

  _wireMicrobit() {
    this.microbit.onStateChange = (state) => {
      this._log('info', `micro:bit: ${state}`);
      this._checkAutoStream();
      this._update();
    };

    this.microbit.onReceive = (text) => {
      this._log('rx', `[micro:bit] ${text.trim()}`);
    };

    this.microbit.onLog = (type, msg) => {
      this._log(type, `[BLE] ${msg}`);
    };
  }

  // ─── Private: auto-start/stop streaming ───

  /**
   * Automatically start streaming when both devices are connected,
   * and stop when micro:bit disconnects.
   */
  _checkAutoStream() {
    const labReady = this.labdisc.state === ConnectionState.CONNECTED;
    const microReady = this.microbit.state === BleState.CONNECTED;
    const streaming = this.labdisc.isStreaming;

    // Both connected and not yet streaming → start
    if (labReady && microReady && !streaming && this.labdisc.sensorIds.length > 0) {
      this._log('info', 'Ambos dispositivos conectados — iniciando streaming');
      this._startStreaming();
    }

    // micro:bit disconnected while streaming → stop
    if (!microReady && streaming) {
      this._log('info', 'micro:bit desconectada — deteniendo streaming');
      this.labdisc.stopStreaming();
    }
  }

  async _startStreaming() {
    if (this.mode === 'fast') {
      await this.labdisc.startExperiment();
    } else {
      await this.labdisc.startOnline();
    }
    this.uartSentCount = 0;
  }

  // ─── Private: helpers ───

  _update() {
    if (this.onUpdate) this.onUpdate();
  }

  _log(type, msg) {
    if (this.onLog) this.onLog(type, msg);
  }
}
