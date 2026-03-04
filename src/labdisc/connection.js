/**
 * connection.js — Labdisc Web Serial connection manager
 *
 * v3.0 — Based on complete GlobiLab X reverse engineering (sniffer v3).
 *
 * Protocol rules (confirmed by sniffing GlobiLab X, March 2026):
 *
 * 1. Handshake commands (GetSensorIDs, GetSensorStatus) sent DUPLICATED
 *    with minimal gap (~50ms). Config (0x11) and Start (0x22) sent
 *    TRIPLICATED (~400ms apart). Labdisc responds with 1-2 ACKs.
 *
 * 2. Config (0x11) and Start (0x22) are SEPARATE operations.
 *    GlobiLab X sends 0x11 when the user changes a sensor in the UI.
 *    It sends 0x22 (Play button) minutes later. NEVER together.
 *
 * 3. Sending 0x11 right before 0x22 causes 0x23/0x24 (idle errors).
 *    Minimum gap between last 0x11 and 0x22: ~2 seconds.
 *
 * 4. Sensor restrictions (hardware):
 *    - Voltaje(27) and Corriente(28) are mutually exclusive.
 *      If both are in mask, Labdisc removes Voltaje.
 *    - Sonido(21) and Micrófono(33) are mutually exclusive.
 *      If both are in mask, Labdisc removes Micrófono.
 *
 * 5. Pressure bug: If Presión(26) appears in a 0x11 together with
 *    rate+count for the first time, firmware may reset rate/count to
 *    0x00 (manual, 10 samples). Workaround: configure rate/count
 *    first (without Presión), then add Presión in a second 0x11.
 *
 * 6. The Labdisc stores config persistently across sessions.
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

/**
 * Mutually exclusive sensor pairs (hardware limitation).
 * When both are in the mask, the Labdisc rejects one unpredictably.
 * We pre-filter to keep the more useful sensor.
 *
 * Confirmed pairs:
 * - Voltaje(27) / Corriente(28) — GlobiLab X drops Voltaje
 * - Sonido(21) / Micrófono(33) — GlobiLab X drops Micrófono
 * - Luz(20) / Ext Analog(32) — Labdisc alternates which it drops
 */
const EXCLUSIVE_PAIRS = [
  { keep: 28, drop: 27 },  // Keep Corriente, drop Voltaje
  { keep: 21, drop: 33 },  // Keep Sonido, drop Micrófono
  { keep: 20, drop: 32 },  // Keep Luz, drop Ext Analog
];

export class LabdiscConnection {
  constructor() {
    this.port = null;
    this.reader = null;
    this.state = ConnectionState.DISCONNECTED;
    this.parser = new LabdiscParser();
    this.streamMode = 'normal';
    this.deviceStatus = null;

    /** When true, don't auto-restart on experiment end */
    this._userStopped = false;

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

      // Auto-stop: Labdisc finished all configured samples
      if (status.subType === 0x33 && this.state === ConnectionState.STREAMING) {
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

  static isSupported() { return 'serial' in navigator; }
  get isConnected() { return this.state !== ConnectionState.DISCONNECTED; }
  get isStreaming() { return this.state === ConnectionState.STREAMING; }
  get sensorIds() { return this.parser.sensorIds; }

  /**
   * Connect to the Labdisc and read its current state.
   *
   * Sequence (matches GlobiLab X sniffer capture):
   * 1. GetSensorIDs (x2, ~50ms apart) — learn what sensors exist
   * 2. GetSensorStatus (x2, ~50ms apart) — read stored config
   *
   * GlobiLab X does NOT send StopLogin on connect.
   * Total: ~3 pitidos (vs 9 we had before).
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

      // Step 1: Get sensor IDs (duplicated, short gap — like GlobiLab X)
      await this._sleep(300);
      await this._sendDuplicated(CMD.GET_SENSOR_IDS, 'GetSensorIDs');

      // Step 2: Get current status (duplicated, short gap)
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

    try {
      if (this.isStreaming) {
        await this._sendDuplicated(CMD.STOP_LOGIN, 'StopLogin');
        await this._sleep(200);
      }
    } catch (e) { /* ignore */ }

    try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch (e) { /* ignore */ }

    this.reader = null;
    this.port = null;
    this.parser.reset();
    this.deviceStatus = null;
    this._statusResolver = null;
    this._userStopped = false;
    this._setState(ConnectionState.DISCONNECTED);
    this._log('info', 'Desconectado del Labdisc');
  }

  /**
   * Start streaming — Normal mode (1Hz, all compatible sensors).
   *
   * Uses incremental configuration to avoid the Pressure bug:
   * 1. Send 0x11 with all sensors EXCEPT Presión, with rate+count
   * 2. Send 0x11 adding Presión (rate+count already settled)
   * 3. Wait 2 seconds for config to settle
   * 4. Send 0x22 to start streaming
   */
  async startNormal() {
    if (!this.isConnected || this.isStreaming) return;
    this.streamMode = 'normal';
    this._userStopped = false;

    var ids = this.parser.sensorIds;
    if (ids.length === 0) { this._log('err', 'No hay sensores'); return; }

    // Build mask handling exclusions
    var fullMask = this._buildSafeMask(ids);
    var rateIdx = 0x02;  // 1Hz
    var countIdx = 0x03;  // 10000 samples

    this._log('info', 'Configurando: ' + this._countBits(fullMask) + ' sensores a 1Hz...');

    // Incremental config to avoid Pressure bug
    await this._configureIncremental(ids, fullMask, rateIdx, countIdx);

    // Gap between config and start (critical!)
    await this._sleep(2000);

    // Start streaming
    await this._startStreaming();
  }

  /**
   * Start streaming — Fast mode (10Hz, excluding slow sensors).
   */
  async startFast() {
    if (!this.isConnected || this.isStreaming) return;
    this.streamMode = 'fast';
    this._userStopped = false;

    var ids = this.parser.sensorIds;
    if (ids.length === 0) { this._log('err', 'No hay sensores'); return; }

    // Build mask: only sensors that support ≥10Hz, minus exclusions
    var rateMask = buildMaskForRate(ids, 10);
    var safeMask = this._applyExclusions(ids, rateMask);

    var excluded = ids.filter(function(id, i) { return !((safeMask >> i) & 1); });
    if (excluded.length > 0) {
      var names = excluded.map(function(id) {
        var s = SENSORS[id]; return s ? s.name : '?' + id;
      }).join(', ');
      this._log('info', 'Excluidos: ' + names);
    }

    var rateIdx = 0x03;  // 10Hz
    var countIdx = 0x03;  // 10000 samples

    this._log('info', 'Configurando: ' + this._countBits(safeMask) + ' sensores a 10Hz...');

    await this._configureIncremental(ids, safeMask, rateIdx, countIdx);
    await this._sleep(2000);
    await this._startStreaming();
  }

  /**
   * Stop streaming. Sets _userStopped so auto-restart doesn't trigger.
   */
  async stopStreaming() {
    if (!this.isStreaming) return;
    this._userStopped = true;
    await this._sendDuplicated(CMD.STOP_LOGIN, 'StopLogin');
    this._setState(ConnectionState.CONNECTED);
    this._log('info', 'Streaming detenido por usuario');
  }

  async sendCommand(code, name) {
    var pkt = buildCommand(code);
    await this._sendRaw(pkt, name);
  }

  // ─── Private: mask building ───

  /**
   * Build a mask with all sensors, handling mutual exclusions.
   * Keeps Corriente over Voltaje, Sonido over Micrófono.
   */
  _buildSafeMask(ids) {
    var mask = (1 << ids.length) - 1;  // Start with all sensors
    return this._applyExclusions(ids, mask);
  }

  /**
   * Remove excluded sensors from a mask based on EXCLUSIVE_PAIRS.
   */
  _applyExclusions(ids, mask) {
    for (var p = 0; p < EXCLUSIVE_PAIRS.length; p++) {
      var pair = EXCLUSIVE_PAIRS[p];
      var keepIdx = ids.indexOf(pair.keep);
      var dropIdx = ids.indexOf(pair.drop);

      // If both are in the mask, remove the "drop" one
      if (keepIdx !== -1 && dropIdx !== -1) {
        var keepBit = (mask >> keepIdx) & 1;
        var dropBit = (mask >> dropIdx) & 1;
        if (keepBit && dropBit) {
          mask &= ~(1 << dropIdx);
          var keepName = SENSORS[pair.keep] ? SENSORS[pair.keep].name : '?' + pair.keep;
          var dropName = SENSORS[pair.drop] ? SENSORS[pair.drop].name : '?' + pair.drop;
          this._log('info', 'Exclusion: ' + keepName + ' activo, ' + dropName + ' excluido');
        }
      }
    }
    return mask;
  }

  // ─── Private: incremental configuration ───

  /**
   * Configure the Labdisc.
   *
   * With correct exclusive pairs pre-filtered, the Labdisc should
   * accept the mask on the first try. Presión is still added in a
   * separate step to avoid the rate/count reset bug.
   */
  async _configureIncremental(ids, targetMask, rateIdx, countIdx) {
    var presionBitIdx = ids.indexOf(26);
    var hasPresion = presionBitIdx !== -1 && ((targetMask >> presionBitIdx) & 1);

    // Step 1: Configure without Presión (to set rate/count safely)
    var maskStep1 = hasPresion ? (targetMask & ~(1 << presionBitIdx)) : targetMask;

    if (this._countBits(maskStep1) > 0) {
      this._log('info', 'Config sensores (mask=0x' + maskStep1.toString(16) + ')');
      var ack1 = await this._sendConfigOnce(maskStep1, rateIdx, countIdx);
      this._logConfigResult(maskStep1, rateIdx, countIdx, ack1);
    }

    // Step 2: Add Presión (rate/count already settled)
    if (hasPresion) {
      await this._sleep(500);
      this._log('info', 'Config +Presión (mask=0x' + targetMask.toString(16) + ')');
      var ack2 = await this._sendConfigOnce(targetMask, rateIdx, countIdx);
      this._logConfigResult(targetMask, rateIdx, countIdx, ack2);
    }
  }

  /**
   * Log the result of a config attempt.
   */
  _logConfigResult(mask, rateIdx, countIdx, ack) {
    if (!ack) {
      this._log('warn', 'Config sin respuesta');
      return;
    }
    if (ack.rateIdx !== rateIdx || ack.countIdx !== countIdx) {
      this._log('warn', 'Rate/count modificado: rate=0x' + ack.rateIdx.toString(16) +
        ' count=0x' + ack.countIdx.toString(16));
    }
    if (ack.sensorMask !== mask) {
      var ids = this.parser.sensorIds;
      var diff = mask ^ ack.sensorMask;
      var rejected = ids.filter(function(_, i) { return (diff >> i) & 1; });
      var names = rejected.map(function(id) {
        var s = SENSORS[id]; return s ? s.name : '?' + id;
      }).join(', ');
      this._log('warn', 'Mascara: 0x' + mask.toString(16) +
        ' -> 0x' + ack.sensorMask.toString(16) + ' (' + names + ')');
    } else {
      this._log('info', 'Config aceptada: mask=0x' + ack.sensorMask.toString(16) +
        ' rate=0x' + ack.rateIdx.toString(16) + ' count=0x' + ack.countIdx.toString(16));
    }
  }

  /**
   * Send a single 0x11 config (triplicated), return the best ACK.
   *
   * CRITICAL TIMING: GlobiLab X sends all 3 copies back-to-back
   * WITHOUT waiting between them. The Labdisc treats the burst as
   * one logical command and pits only once. If we add delays between
   * sends, each one is treated as a separate command → 3 pits.
   */
  async _sendConfigOnce(mask, rateIdx, countIdx) {
    var maskHi = (mask >> 8) & 0xFF;
    var maskLo = mask & 0xFF;
    var pkt = buildStartExperiment(maskHi, maskLo, rateIdx, countIdx);

    // Send all 3 back-to-back (no sleep!) — like GlobiLab X
    await this._sendRaw(pkt, 'StartExperiment mask=0x' + mask.toString(16));
    await this._sendRaw(pkt, 'StartExperiment mask=0x' + mask.toString(16) + ' [dup]');
    await this._sendRaw(pkt, 'StartExperiment mask=0x' + mask.toString(16) + ' [trip]');

    // Now wait for ACKs (Labdisc responds with 1-2)
    var bestAck = null;
    for (var i = 0; i < 3; i++) {
      var ack = await this._waitForStatus(1000);
      if (!ack) break;
      // Prefer the ACK whose mask matches our request
      if (!bestAck || ack.sensorMask === mask) {
        bestAck = ack;
      }
    }

    return bestAck;
  }

  // ─── Private: streaming ───

  /**
   * Send 0x22 triplicated to start streaming.
   * All 3 sent back-to-back (no delay) → 1 pit.
   */
  async _startStreaming() {
    await this.sendCommand(CMD.START_LOGIN, 'StartLogin');
    await this.sendCommand(CMD.START_LOGIN, 'StartLogin [dup]');
    await this.sendCommand(CMD.START_LOGIN, 'StartLogin [trip]');

    var started = await this._waitForActiveStatus(3000);
    if (started) {
      this._setState(ConnectionState.STREAMING);
      this.parser.packetCount = 0;
      this._log('info', 'Streaming activo');
    } else {
      this._log('err', 'Labdisc no arranco');
    }
  }

  /**
   * Send a command triplicated back-to-back (no delay between sends).
   * The Labdisc treats the burst as one command → 1 pit.
   */
  async _sendTriplicated(code, name) {
    await this.sendCommand(code, name);
    await this.sendCommand(code, name + ' [dup]');
    await this.sendCommand(code, name + ' [trip]');
  }

  /**
   * Send a command duplicated (~50ms apart) — for handshake commands.
   * GlobiLab X sends GetSensorIDs and GetSensorStatus this way.
   */
  async _sendDuplicated(code, name) {
    await this.sendCommand(code, name);
    await this._sleep(50);
    await this.sendCommand(code, name + ' [dup]');
  }

  // ─── Private: experiment end ───

  async _handleExperimentEnd() {
    this._setState(ConnectionState.CONNECTED);

    // If user pressed Stop, don't auto-restart
    if (this._userStopped) {
      this._userStopped = false;
      return;
    }

    // Auto-restart: config is still in memory, just send 0x22 again
    this._log('info', 'Muestras agotadas. Reiniciando...');
    await this._sleep(500);
    await this._startStreaming();
  }

  // ─── Private: wait for ACK ───

  _waitForStatus(timeoutMs) {
    if (timeoutMs === undefined) timeoutMs = 2000;
    var self = this;
    return new Promise(function(resolve) {
      var settled = false;
      var timer = setTimeout(function() {
        if (!settled) { settled = true; self._statusResolver = null; resolve(null); }
      }, timeoutMs);
      self._statusResolver = function(status) {
        if (!settled) { settled = true; clearTimeout(timer); resolve(status); }
      };
    });
  }

  /**
   * Consume 0x83 packets until one has active=true, or timeout.
   */
  async _waitForActiveStatus(timeoutMs) {
    var deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      var remaining = deadline - Date.now();
      if (remaining <= 0) break;
      var ack = await this._waitForStatus(remaining);
      if (!ack) break;
      if (ack.active) return true;
      this._log('info', 'sub=0x' + ack.subType.toString(16) + ' idle, esperando...');
    }
    return false;
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

  _countBits(n) {
    var count = 0;
    while (n) { count += n & 1; n >>= 1; }
    return count;
  }

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  _log(type, msg) { if (this.onLog) this.onLog(type, msg); }
  _sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
}