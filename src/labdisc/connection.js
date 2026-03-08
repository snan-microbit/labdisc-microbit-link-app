/**
 * connection.js — Labdisc Web Serial connection manager
 *
 * v4.0 — Polling architecture (0x55 → 0x81)
 *
 * Descubierto por sniffer (04/03/2026): GlobiLab X NO usa 0x22 (StartLogin)
 * para el modo Sensing. En su lugar, envía el comando 0x55 repetidamente
 * y el Labdisc responde con un paquete 0x81 (Online Data, 41 bytes) cada vez.
 *
 * Ventajas del polling sobre el streaming (0x11 + 0x22 + 0x84):
 * - Sin configuración de sensores (no 0x11)
 * - Sin StartLogin que fallaba con 0x24 (no 0x22)
 * - Sin bug de Presión
 * - Sin problemas de memoria llena
 * - Sin negociación de máscaras ni pares exclusivos en software
 * - Frecuencia configurable en caliente (1-25Hz probado)
 * - Todos los sensores siempre disponibles
 * - Los pares exclusivos se controlan con botones físicos del Labdisc
 *
 * Probado hasta 50Hz con <6% pérdida. Techo práctico: 25Hz.
 */

import { BAUD_RATE, CMD, buildCommand, fmtHex } from './protocol.js';
import { LabdiscParser } from './parser.js';
import { createPollTimer } from './poll-worker.js';

/** Comando 0x55: polling de Online Data. Checksum = 0x50. */
const CMD_POLL = new Uint8Array([0x47, 0x14, 0x55, 0x50]);

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
    this.deviceStatus = null;

    /** Polling frequency in Hz */
    this.pollHz = 1;

    /** Polling timer (Web Worker, not throttled in background) */
    this._pollTimer = createPollTimer();

    /** Stats */
    this._pollSentCount = 0;

    // ─── Callbacks ───
    this.onStateChange = null;
    this.onSensorIds = null;
    this.onStatus = null;
    this.onData = null;
    this.onLog = null;

    this._statusResolver = null;

    // Wire parser callbacks
    this.parser.onSensorIds = (ids) => {
      if (this.onSensorIds) this.onSensorIds(ids);
    };
    this.parser.onStatus = (status) => {
      this.deviceStatus = status;

      if (this._statusResolver) {
        var resolve = this._statusResolver;
        this._statusResolver = null;
        resolve(status);
      }

      if (this.onStatus) this.onStatus(status);
    };
    this.parser.onData = (values, count) => {
      if (this.onData) this.onData(values, count);
    };
    this.parser.onLog = (type, msg) => this._log(type, msg);
  }

  // ─── Public API ───

  static isSupported() { return 'serial' in navigator; }
  get isConnected() { return this.state !== ConnectionState.DISCONNECTED; }
  get isStreaming() { return this.state === ConnectionState.STREAMING; }
  get sensorIds() { return this.parser.sensorIds; }

  /**
   * Connect to the Labdisc.
   *
   * Sequence (matches GlobiLab X sniffer capture):
   * 1. Open serial port at 9600 baud
   * 2. GetSensorIDs (×2, ~50ms apart)
   * 3. GetSensorStatus (×2, ~50ms apart)
   */
  async connect() {
    if (this.isConnected) return;

    try {
      this._setState(ConnectionState.CONNECTING);
      this._log('info', 'Solicitando puerto serial...');

      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: BAUD_RATE });

      this._setState(ConnectionState.CONNECTED);
      this._log('info', 'Puerto abierto a ' + BAUD_RATE + ' baud');

      this._readLoop();

      // Step 1: Get sensor IDs (duplicated, like GlobiLab X)
      await this._sleep(300);
      await this._sendDuplicated(CMD.GET_SENSOR_IDS, 'GetSensorIDs');

      // Step 2: Get current status (duplicated)
      await this._sleep(800);
      await this._sendDuplicated(CMD.GET_SENSOR_STATUS, 'GetSensorStatus');

    } catch (e) {
      if (e.name !== 'NotFoundError') this._log('err', 'Conexion: ' + e.message);
      this._setState(ConnectionState.DISCONNECTED);
      this.port = null;
    }
  }

  async disconnect() {
    if (!this.isConnected) return;

    // Stop polling if active
    this.stopPolling();

    try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }

    this.reader = null;
    this.port = null;
    this.parser.reset();
    this.deviceStatus = null;
    this._statusResolver = null;
    this._setState(ConnectionState.DISCONNECTED);
    this._log('info', 'Desconectado del Labdisc');
  }

  /**
   * Start polling at the configured frequency.
   * Sends 0x55 at pollHz rate, receives 0x81 responses.
   *
   * @param {number} [hz] - Optional frequency override (1-25 recommended)
   */
  startPolling(hz) {
    if (!this.isConnected) return;
    if (this.isStreaming) this.stopPolling();

    if (hz !== undefined) this.pollHz = hz;

    var intervalMs = Math.round(1000 / this.pollHz);
    this._pollSentCount = 0;
    this.parser.packetCount = 0;

    this._log('info', 'Polling a ' + this.pollHz + ' Hz (cada ' + intervalMs + 'ms)');

    var self = this;
    this._pollTimer.start(intervalMs, function() {
      self._sendPoll();
    });

    this._setState(ConnectionState.STREAMING);
  }

  /**
   * Stop polling.
   */
  stopPolling() {
    this._pollTimer.stop();

    if (this.state === ConnectionState.STREAMING) {
      this._log('info', 'Polling detenido. ' +
        this._pollSentCount + ' enviados, ' +
        this.parser.packetCount + ' recibidos');
      this._setState(ConnectionState.CONNECTED);
    }
  }

  /**
   * Change polling frequency on the fly.
   * If currently streaming, restarts with the new frequency.
   */
  setHz(hz) {
    if (hz < 0.5 || hz > 50) return;
    this.pollHz = hz;

    if (this.isStreaming) {
      var intervalMs = Math.round(1000 / this.pollHz);
      this._pollTimer.setInterval(intervalMs);
      this._log('info', 'Frecuencia cambiada a ' + this.pollHz + ' Hz');
    }
  }

  // ─── Legacy API (for compatibility with bridge.js) ───

  async startNormal() { this.startPolling(1); }
  async startFast() { this.startPolling(10); }
  async stopStreaming() { this.stopPolling(); }

  async sendCommand(code, name) {
    var pkt = buildCommand(code);
    await this._sendRaw(pkt, name);
  }

  // ─── Private: polling ───

  async _sendPoll() {
    if (!this.port || !this.isConnected) return;
    try {
      var writer = this.port.writable.getWriter();
      await writer.write(CMD_POLL);
      writer.releaseLock();
      this._pollSentCount++;
    } catch (e) {
      this._log('err', 'Poll TX error: ' + e.message);
      this.stopPolling();
    }
  }

  // ─── Private: handshake commands ───

  /**
   * Send a command duplicated (~50ms apart) — for handshake commands.
   */
  async _sendDuplicated(code, name) {
    await this.sendCommand(code, name);
    await this._sleep(50);
    await this.sendCommand(code, name + ' [dup]');
  }

  // ─── Private: read loop ───

  async _readLoop() {
    while (this.isConnected && this.port) {
      try {
        this.reader = this.port.readable.getReader();
        while (true) {
          var result = await this.reader.read();
          if (result.done) break;
          if (result.value && result.value.length > 0) this.parser.feed(result.value);
        }
        this.reader.releaseLock();
      } catch (e) {
        if (this.isConnected) this._log('err', 'Read error: ' + e.message);
        try { this.reader.releaseLock(); } catch (x) { /* ignore */ }
        break;
      }
    }
  }

  // ─── Private: send ───

  async _sendRaw(pkt, name) {
    if (!this.port || !this.isConnected) return;
    try {
      var writer = this.port.writable.getWriter();
      await writer.write(pkt);
      writer.releaseLock();
      this._log('tx', fmtHex(pkt) + ' (' + name + ')');
    } catch (e) {
      this._log('err', 'TX error: ' + e.message);
    }
  }

  // ─── Private: helpers ───

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  _log(type, msg) { if (this.onLog) this.onLog(type, msg); }
  _sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
}