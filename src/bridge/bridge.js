/**
 * bridge.js — Data bridge orchestrator
 * 
 * v5.0 — Fix auto-stream re-start on manual stop
 * 
 * Coordinates the flow: Labdisc → decode → convert → format → micro:bit
 * 
 * Uses 0x55 polling (not 0x11/0x22 streaming). Frequency configurable 1-25Hz.
 * 
 * Auto-stream rules:
 * - Both devices connected → auto-start polling at current hz
 * - micro:bit disconnects during auto-stream → auto-stop
 * - Manual stream (button) → works without micro:bit, no auto-stop
 * - Manual stop → inhibits auto-start until micro:bit reconnects
 * 
 * BUGFIX v5.0:
 * El bug anterior: manualStopStream() paraba el polling, pero el cambio
 * de estado (STREAMING → CONNECTED) disparaba onStateChange en labdisc,
 * que llamaba _checkAutoStream(). Como ambos dispositivos seguían
 * conectados y el streaming ya no estaba activo, _checkAutoStream()
 * lo re-iniciaba inmediatamente. El usuario veía que el Stop "no hacía nada".
 * 
 * Solución: flag `_manualStop` que se enciende en manualStopStream().
 * _checkAutoStream() lo respeta y no re-inicia. Se resetea cuando:
 *   - La micro:bit se desconecta (ciclo limpio)
 *   - El usuario inicia manualmente de nuevo
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

    /** true if streaming was started by auto-stream (not manual button) */
    this._autoStarted = false;

    /**
     * true cuando el usuario explícitamente detuvo el stream.
     * Impide que _checkAutoStream() re-inicie automáticamente.
     * Se resetea cuando la micro:bit se desconecta o el usuario
     * inicia manualmente de nuevo.
     */
    this._manualStop = false;

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

  /**
   * Set polling frequency.
   * @param {number} hz - Frequency in Hz (1-25 recommended)
   */
  setHz(hz) {
    this.labdisc.setHz(hz);
    this._update();
  }

  /** Manual start — works without micro:bit */
  async manualStartStream() {
    if (!this.labdisc.isConnected || this.labdisc.isStreaming) return;
    this._autoStarted = false;
    this._manualStop = false;  // ← usuario quiere streaming, desbloquear auto-start
    this.labdisc.startPolling();
    this.uartSentCount = 0;
    this._update();
  }

  /** Manual stop */
  async manualStopStream() {
    if (!this.labdisc.isStreaming) return;
    this._autoStarted = false;
    this._manualStop = true;   // ← inhibir auto-start
    this.labdisc.stopPolling();
    this._log('info', 'Stream detenido manualmente');
    this._update();
  }

  getState() {
    return {
      labdisc: this.labdisc.state,
      microbit: this.microbit.state,
      pollHz: this.labdisc.pollHz,
      sensorIds: this.labdisc.sensorIds,
      deviceStatus: this.labdisc.deviceStatus,
      displayValues: this.displayValues,
      lastUartLine: this.lastUartLine,
      uartSentCount: this.uartSentCount,
      packetCount: this.labdisc.parser.packetCount,
      pollSentCount: this.labdisc._pollSentCount,
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

    this.labdisc.onData = async (values, count) => {
      this.displayValues = formatForDisplay(values);

      const lines = formatForUART(values);
      this.lastUartLine = lines[0].trim() + ' | ' + lines[1].trim();

      if (this.microbit.isConnected) {
        await this.microbit.send(lines[0]);
        await this.microbit.send(lines[1]);
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

  /**
   * Decide si iniciar/detener el polling automáticamente.
   * 
   * Reglas:
   *   1. Ambos conectados + no streaming + no inhibido → auto-start
   *   2. micro:bit perdida + auto-started → auto-stop + reset _manualStop
   * 
   * El flag _manualStop impide que la regla 1 se active después de que
   * el usuario detuvo explícitamente el stream. Esto evita el bug donde
   * Stop parecía no funcionar (se re-iniciaba inmediatamente).
   * 
   * _manualStop se resetea cuando:
   *   - La micro:bit se desconecta (regla 2) → próxima reconexión inicia limpio
   *   - El usuario hace manualStartStream() → explícitamente quiere streaming
   */
  _checkAutoStream() {
    const labReady = this.labdisc.state === ConnectionState.CONNECTED;
    const microReady = this.microbit.state === BleState.CONNECTED;
    const streaming = this.labdisc.isStreaming;

    // Regla 1: Both connected + not streaming + not inhibited → auto-start
    if (labReady && microReady && !streaming && !this._manualStop && this.labdisc.sensorIds.length > 0) {
      this._log('info', 'Ambos conectados — auto-start polling');
      this._autoStarted = true;
      this.labdisc.startPolling();
      this.uartSentCount = 0;
    }

    // Regla 2: micro:bit lost + was auto-started → auto-stop
    if (!microReady && streaming && this._autoStarted) {
      this._log('info', 'micro:bit perdida — auto-stop polling');
      this._autoStarted = false;
      this._manualStop = false;  // ← reset para que al reconectar funcione auto-start
      this.labdisc.stopPolling();
    }
  }

  _update() { if (this.onUpdate) this.onUpdate(); }
  _log(type, msg) { if (this.onLog) this.onLog(type, msg); }
}