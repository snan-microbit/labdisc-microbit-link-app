/**
 * connection.js — Labdisc Web Serial connection manager
 * 
 * Handles the lifecycle of a Bluetooth Classic (SPP) connection to the Labdisc
 * through the Web Serial API. Manages port opening, reading loop, and command sending.
 * 
 * Events are dispatched through callbacks, not EventTarget, for simplicity.
 */

import { BAUD_RATE, CMD, buildCommand, buildStartExperiment, fmtHex } from './protocol.js';
import { LabdiscParser } from './parser.js';

/** Connection states */
export const ConnectionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
  STREAMING:    'streaming',
});

export class LabdiscConnection {
  constructor() {
    /** @type {SerialPort|null} */
    this.port = null;

    /** @type {ReadableStreamDefaultReader|null} */
    this.reader = null;

    /** @type {string} */
    this.state = ConnectionState.DISCONNECTED;

    /** @type {LabdiscParser} */
    this.parser = new LabdiscParser();

    /** @type {string} Current streaming mode: 'online' or 'experiment' */
    this.streamMode = 'online';

    /** @type {Object|null} Last device status received */
    this.deviceStatus = null;

    // ─── Callbacks ───
    
    /** @type {function(string)} State change */
    this.onStateChange = null;
    
    /** @type {function(number[])} Sensor IDs received */
    this.onSensorIds = null;
    
    /** @type {function(Object)} Device status received */
    this.onStatus = null;
    
    /** @type {function(Object, number)} Sensor data received */
    this.onData = null;
    
    /** @type {function(string, string)} Log message (type, message) */
    this.onLog = null;

    // Wire parser callbacks
    this.parser.onSensorIds = (ids) => {
      if (this.onSensorIds) this.onSensorIds(ids);
    };
    this.parser.onStatus = (status) => {
      this.deviceStatus = status;
      // Auto-detect streaming stop
      if (status.subType === 0x33 && this.state === ConnectionState.STREAMING) {
        this._log('info', 'Experimento finalizado automáticamente');
        this._handleExperimentEnd();
      }
      if (this.onStatus) this.onStatus(status);
    };
    this.parser.onData = (values, count) => {
      if (this.onData) this.onData(values, count);
    };
    this.parser.onLog = (type, msg) => this._log(type, msg);
  }

  // ─── Public API ───

  /** Check if Web Serial API is available */
  static isSupported() {
    return 'serial' in navigator;
  }

  /** @returns {boolean} */
  get isConnected() {
    return this.state !== ConnectionState.DISCONNECTED;
  }

  /** @returns {boolean} */
  get isStreaming() {
    return this.state === ConnectionState.STREAMING;
  }

  /** @returns {number[]} */
  get sensorIds() {
    return this.parser.sensorIds;
  }

  /**
   * Connect to the Labdisc.
   * Opens the serial port selector dialog, then initializes communication.
   */
  async connect() {
    if (this.isConnected) return;

    try {
      this._setState(ConnectionState.CONNECTING);
      this._log('info', 'Solicitando puerto serial...');

      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: BAUD_RATE });

      this._setState(ConnectionState.CONNECTED);
      this._log('info', `Puerto abierto a ${BAUD_RATE} baud`);

      // Start reading
      this._readLoop();

      // Initialize: get sensor list and status
      await this._sleep(300);
      await this.sendCommand(CMD.GET_SENSOR_IDS, 'GetSensorIDs');
      await this._sleep(500);
      await this.sendCommand(CMD.GET_SENSOR_STATUS, 'GetSensorStatus');

    } catch (e) {
      if (e.name !== 'NotFoundError') {
        this._log('err', `Conexión: ${e.message}`);
      }
      this._setState(ConnectionState.DISCONNECTED);
      this.port = null;
    }
  }

  /**
   * Disconnect from the Labdisc.
   * Stops streaming if active, closes the port.
   */
  async disconnect() {
    if (!this.isConnected) return;

    try {
      if (this.isStreaming) {
        await this.sendCommand(CMD.STOP_LOGIN, 'StopLogin');
        await this._sleep(200);
      }
    } catch (e) { /* ignore */ }

    try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }

    this.reader = null;
    this.port = null;
    this.parser.reset();
    this.deviceStatus = null;
    this._setState(ConnectionState.DISCONNECTED);
    this._log('info', 'Desconectado del Labdisc');
  }

  /**
   * Start streaming in Online mode (0x81, ~1Hz, indefinite).
   * Just sends StartLogin — no experiment configuration needed.
   */
  async startOnline() {
    if (!this.isConnected || this.isStreaming) return;

    this.streamMode = 'online';
    await this.sendCommand(CMD.START_LOGIN, 'StartLogin (Online)');
    this._setState(ConnectionState.STREAMING);
    this.parser.packetCount = 0;
  }

  /**
   * Start streaming in Experiment mode (0x84, 25Hz, 10000 samples).
   * Sends StartExperiment with all sensors, then StartLogin.
   */
  async startExperiment() {
    if (!this.isConnected || this.isStreaming) return;

    this.streamMode = 'experiment';
    const numSensors = this.parser.sensorIds.length;
    if (numSensors === 0) {
      this._log('err', 'No hay sensores detectados');
      return;
    }

    // Mask with all sensors active
    const mask = (1 << numSensors) - 1;
    const maskHi = (mask >> 8) & 0xFF;
    const maskLo = mask & 0xFF;

    const pkt = buildStartExperiment(maskHi, maskLo, 0x04, 0x03); // 25Hz, 10000 samples
    await this._sendRaw(pkt, `StartExperiment mask=0x${mask.toString(16)} rate=25Hz count=10000`);

    await this._sleep(300);
    await this.sendCommand(CMD.START_LOGIN, 'StartLogin (Experiment)');
    this._setState(ConnectionState.STREAMING);
    this.parser.packetCount = 0;
  }

  /**
   * Stop streaming (any mode).
   */
  async stopStreaming() {
    if (!this.isStreaming) return;

    await this.sendCommand(CMD.STOP_LOGIN, 'StopLogin');
    this._setState(ConnectionState.CONNECTED);
  }

  /**
   * Send a simple command (no payload).
   */
  async sendCommand(code, name) {
    const pkt = buildCommand(code);
    await this._sendRaw(pkt, name);
  }

  // ─── Private: read loop ───

  async _readLoop() {
    while (this.isConnected && this.port) {
      try {
        this.reader = this.port.readable.getReader();
        while (true) {
          const { done, value } = await this.reader.read();
          if (done) break;
          if (value && value.length > 0) {
            this.parser.feed(value);
          }
        }
        this.reader.releaseLock();
      } catch (e) {
        if (this.isConnected) {
          this._log('err', `Read error: ${e.message}`);
        }
        try { this.reader.releaseLock(); } catch (x) { /* ignore */ }
        break;
      }
    }
  }

  // ─── Private: experiment auto-restart ───

  async _handleExperimentEnd() {
    if (this.streamMode === 'experiment') {
      // Auto-restart: re-send 0x11 + 0x22
      this._log('info', 'Reiniciando experimento automáticamente...');
      await this._sleep(500);
      await this.startExperiment();
    } else {
      this._setState(ConnectionState.CONNECTED);
    }
  }

  // ─── Private: send ───

  async _sendRaw(pkt, name) {
    if (!this.port || !this.isConnected) return;

    try {
      const writer = this.port.writable.getWriter();
      await writer.write(pkt);
      writer.releaseLock();
      this._log('tx', `${fmtHex(pkt)} (${name})`);
    } catch (e) {
      this._log('err', `TX error: ${e.message}`);
    }
  }

  // ─── Private: state ───

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  _log(type, msg) {
    if (this.onLog) this.onLog(type, msg);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
