/**
 * connection.js — Labdisc Web Serial connection manager
 * 
 * KEY FINDINGS:
 * 1. The Labdisc requires a full handshake (Stop → GetIDs → GetStatus)
 *    before StartExperiment (0x11). Without it, the command is ignored.
 * 2. StartLogin (0x22) always uses the LAST configured experiment.
 *    There is no separate "online" mode — 0x22 without 0x11 just runs
 *    whatever config is stored in memory (possibly from GlobiLab X).
 * 3. Therefore: BOTH modes must send 0x11 before 0x22.
 * 4. The Labdisc limits rate to the slowest active sensor.
 *    GPS maxes at 1Hz, so fast mode excludes it.
 */

import { BAUD_RATE, CMD, buildCommand, buildStartExperiment, fmtHex } from './protocol.js';
import { LabdiscParser } from './parser.js';
import { SENSORS, buildMaskForRate } from './sensors.js';

export const ConnectionState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
  STREAMING:    'streaming',
});

export class LabdiscConnection {
  constructor() {
    this.port = null;
    this.reader = null;
    this.state = ConnectionState.DISCONNECTED;
    this.parser = new LabdiscParser();
    this.streamMode = 'normal';
    this.deviceStatus = null;

    this.onStateChange = null;
    this.onSensorIds = null;
    this.onStatus = null;
    this.onData = null;
    this.onLog = null;

    // Wire parser
    this.parser.onSensorIds = (ids) => { if (this.onSensorIds) this.onSensorIds(ids); };
    this.parser.onStatus = (status) => {
      this.deviceStatus = status;
      if (status.subType === 0x33 && this.state === ConnectionState.STREAMING) {
        this._log('info', 'Experimento finalizado (muestras completadas)');
        this._handleExperimentEnd();
      }
      if (this.onStatus) this.onStatus(status);
    };
    this.parser.onData = (values, count) => { if (this.onData) this.onData(values, count); };
    this.parser.onLog = (type, msg) => this._log(type, msg);
  }

  // ─── Public API ───

  static isSupported() { return 'serial' in navigator; }
  get isConnected() { return this.state !== ConnectionState.DISCONNECTED; }
  get isStreaming() { return this.state === ConnectionState.STREAMING; }
  get sensorIds() { return this.parser.sensorIds; }

  async connect() {
    if (this.isConnected) return;

    try {
      this._setState(ConnectionState.CONNECTING);
      this._log('info', 'Solicitando puerto serial...');

      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: BAUD_RATE });

      this._setState(ConnectionState.CONNECTED);
      this._log('info', `Puerto abierto a ${BAUD_RATE} baud`);

      this._readLoop();

      // Initial handshake
      await this._sleep(300);
      await this.sendCommand(CMD.GET_SENSOR_IDS, 'GetSensorIDs');
      await this._sleep(500);
      await this.sendCommand(CMD.GET_SENSOR_STATUS, 'GetSensorStatus');

    } catch (e) {
      if (e.name !== 'NotFoundError') this._log('err', `Conexión: ${e.message}`);
      this._setState(ConnectionState.DISCONNECTED);
      this.port = null;
    }
  }

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
   * Start streaming — Normal mode (1Hz, all sensors).
   * 
   * Sends full handshake + 0x11 with all sensors at 1Hz + 0x22.
   * Uses 10000 samples (auto-restart when depleted).
   */
  async startNormal() {
    if (!this.isConnected || this.isStreaming) return;

    this.streamMode = 'normal';
    const ids = this.parser.sensorIds;
    if (ids.length === 0) { this._log('err', 'No hay sensores'); return; }

    // All sensors active
    const mask = (1 << ids.length) - 1;
    const maskHi = (mask >> 8) & 0xFF;
    const maskLo = mask & 0xFF;

    this._log('info', `Modo normal: ${ids.length} sensores a 1Hz`);

    // Full handshake (required by Labdisc)
    await this._handshake();

    // StartExperiment: 1Hz (0x02), 10000 samples (0x03)
    const pkt = buildStartExperiment(maskHi, maskLo, 0x02, 0x03);
    await this._sendRaw(pkt, `StartExperiment mask=0x${mask.toString(16)} rate=1Hz count=10000`);
    await this._sleep(500);

    await this.sendCommand(CMD.START_LOGIN, 'StartLogin (Normal 1Hz)');
    this._setState(ConnectionState.STREAMING);
    this.parser.packetCount = 0;
  }

  /**
   * Start streaming — Fast mode (10Hz, excluding slow sensors like GPS).
   * 
   * Sends full handshake + 0x11 with compatible sensors at 10Hz + 0x22.
   */
  async startFast() {
    if (!this.isConnected || this.isStreaming) return;

    this.streamMode = 'fast';
    const ids = this.parser.sensorIds;
    if (ids.length === 0) { this._log('err', 'No hay sensores'); return; }

    // Mask excluding sensors below 10Hz
    const mask = buildMaskForRate(ids, 10);
    const maskHi = (mask >> 8) & 0xFF;
    const maskLo = mask & 0xFF;

    // Log exclusions
    const excluded = ids.filter((id, i) => !((mask >> i) & 1));
    if (excluded.length > 0) {
      const names = excluded.map(id => SENSORS[id]?.name || `?${id}`).join(', ');
      this._log('info', `Excluidos (<10Hz): ${names}`);
    }

    const active = ids.filter((id, i) => (mask >> i) & 1);
    this._log('info', `Modo rápido: ${active.length} sensores a 10Hz`);

    // Full handshake
    await this._handshake();

    // StartExperiment: 10Hz (0x03), 10000 samples (0x03)
    const pkt = buildStartExperiment(maskHi, maskLo, 0x03, 0x03);
    await this._sendRaw(pkt, `StartExperiment mask=0x${mask.toString(16)} rate=10Hz count=10000`);
    await this._sleep(500);

    await this.sendCommand(CMD.START_LOGIN, 'StartLogin (Fast 10Hz)');
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

  async sendCommand(code, name) {
    const pkt = buildCommand(code);
    await this._sendRaw(pkt, name);
  }

  // ─── Private: handshake ───

  /**
   * Full handshake sequence required before StartExperiment.
   * Without this, the Labdisc ignores the 0x11 command.
   */
  async _handshake() {
    await this.sendCommand(CMD.STOP_LOGIN, 'StopLogin (handshake)');
    await this._sleep(500);
    await this.sendCommand(CMD.GET_SENSOR_IDS, 'GetSensorIDs (handshake)');
    await this._sleep(300);
    await this.sendCommand(CMD.GET_SENSOR_STATUS, 'GetStatus (handshake)');
    await this._sleep(300);
  }

  // ─── Private: read loop ───

  async _readLoop() {
    while (this.isConnected && this.port) {
      try {
        this.reader = this.port.readable.getReader();
        while (true) {
          const { done, value } = await this.reader.read();
          if (done) break;
          if (value && value.length > 0) this.parser.feed(value);
        }
        this.reader.releaseLock();
      } catch (e) {
        if (this.isConnected) this._log('err', `Read error: ${e.message}`);
        try { this.reader.releaseLock(); } catch (x) { /* ignore */ }
        break;
      }
    }
  }

  // ─── Private: experiment auto-restart ───

  async _handleExperimentEnd() {
    // Go back to CONNECTED to allow re-start
    this._setState(ConnectionState.CONNECTED);
    this._log('info', 'Reiniciando experimento...');
    await this._sleep(500);

    if (this.streamMode === 'fast') {
      await this.startFast();
    } else {
      await this.startNormal();
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

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  _log(type, msg) { if (this.onLog) this.onLog(type, msg); }
  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}