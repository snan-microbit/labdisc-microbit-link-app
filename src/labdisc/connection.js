/**
 * connection.js — Labdisc Web Serial connection manager
 *
 * v5.0 — Fix disconnect deadlock
 *
 * BUGFIX: La versión anterior se trababa al desconectar porque:
 *
 *   1. _readLoop() estaba bloqueado en `await reader.read()`
 *   2. disconnect() llamaba reader.cancel() + port.close()
 *   3. Pero NO ESPERABA a que _readLoop() terminara antes de cerrar el port
 *   4. Mientras tanto, _sendPoll() seguía intentando escribir al port
 *   5. Resultado: deadlock — el port no se puede cerrar mientras hay
 *      un reader/writer lock activo, y la página se congela
 *
 * La solución tiene 3 partes:
 *
 *   A. Flag `_disconnecting`: se pone en true al iniciar disconnect().
 *      _sendPoll() lo chequea y no intenta escribir si está desconectando.
 *      Esto evita que lleguen escrituras nuevas durante el shutdown.
 *
 *   B. Promise `_readLoopDone`: _readLoop() crea una Promise que se
 *      resuelve cuando el loop termina. disconnect() hace await de esa
 *      Promise DESPUÉS de cancelar el reader, para asegurarse de que
 *      el lock del reader fue liberado antes de cerrar el port.
 *
 *   C. Secuencia estricta de disconnect():
 *      1. _disconnecting = true
 *      2. stopPolling() — para el timer, no llegan más _sendPoll()
 *      3. reader.cancel() — desbloquea el read() que estaba esperando
 *      4. await _readLoopDone — espera que el loop libere el reader lock
 *      5. port.close() — ahora sí se puede cerrar limpiamente
 *      6. Limpiar estado
 *
 * Basado en: https://web.dev/serial/#close-port
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

    /**
     * Flag de desconexión en curso.
     * Cuando es true, _sendPoll() y _sendRaw() no intentan escribir.
     * Esto previene que lleguen escrituras durante el shutdown que
     * podrían tomar el writer lock y causar un deadlock.
     */
    this._disconnecting = false;

    /**
     * Promise que se resuelve cuando _readLoop() termina.
     * disconnect() hace await de esto para asegurarse de que el
     * reader lock fue liberado antes de cerrar el port.
     */
    this._readLoopDone = null;

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

    this._disconnecting = false;

    try {
      this._setState(ConnectionState.CONNECTING);
      this._log('info', 'Solicitando puerto serial...');

      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: BAUD_RATE });

      this._setState(ConnectionState.CONNECTED);
      this._log('info', 'Puerto abierto a ' + BAUD_RATE + ' baud');

      // Iniciar el read loop. Guardamos la Promise para poder
      // esperarla en disconnect().
      this._readLoopDone = this._readLoop();

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

  /**
   * Disconnect from the Labdisc.
   *
   * La secuencia es crítica para evitar deadlocks:
   *
   *   Paso 1: Señalizar que estamos desconectando (_disconnecting = true)
   *           Esto hace que _sendPoll() deje de intentar escribir.
   *
   *   Paso 2: Parar el timer de polling (stopPolling)
   *           No llegan más ticks del Web Worker.
   *
   *   Paso 3: Cancelar el reader (reader.cancel())
   *           Esto hace que el await reader.read() que está bloqueado
   *           en _readLoop() resuelva con {done: true}.
   *
   *   Paso 4: Esperar que _readLoop() termine (await _readLoopDone)
   *           Esto garantiza que reader.releaseLock() ya se ejecutó.
   *           Sin este paso, port.close() falla porque el reader lock
   *           sigue activo.
   *
   *   Paso 5: Cerrar el port (port.close())
   *           Ahora sí es seguro, no hay locks activos.
   */
  async disconnect() {
    if (!this.isConnected) return;

    // Paso 1: señalizar
    this._disconnecting = true;
    this._log('info', 'Desconectando...');

    // Paso 2: parar polling
    this.stopPolling();

    // Paso 3: cancelar reader para desbloquear _readLoop()
    try {
      if (this.reader) {
        await this.reader.cancel();
        // No hacemos releaseLock() acá — lo hace _readLoop()
        // cuando detecta done=true o el catch del error.
      }
    } catch (e) {
      this._log('warn', 'reader.cancel: ' + e.message);
    }

    // Paso 4: esperar que _readLoop() termine y libere el lock
    if (this._readLoopDone) {
      try {
        await this._readLoopDone;
      } catch (e) {
        // _readLoop() ya maneja sus errores internamente
      }
    }

    // Paso 5: cerrar port
    try {
      if (this.port) {
        await this.port.close();
      }
    } catch (e) {
      this._log('warn', 'port.close: ' + e.message);
    }

    // Limpiar estado
    this.reader = null;
    this.port = null;
    this._readLoopDone = null;
    this.parser.reset();
    this.deviceStatus = null;
    this._statusResolver = null;
    this._disconnecting = false;
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

  /**
   * Envía un comando 0x55 de polling.
   *
   * IMPORTANTE: chequea _disconnecting antes de intentar escribir.
   * Si estamos en proceso de desconexión, no hace nada. Esto previene
   * que un tick del Web Worker llegue durante el shutdown y tome el
   * writer lock, causando un deadlock con port.close().
   */
  async _sendPoll() {
    // Guard: no escribir si estamos desconectando o ya desconectado
    if (this._disconnecting || !this.port || !this.isConnected) return;

    var writer = null;
    try {
      writer = this.port.writable.getWriter();
      await writer.write(CMD_POLL);
      this._pollSentCount++;
    } catch (e) {
      if (!this._disconnecting) {
        this._log('err', 'Poll TX error: ' + e.message);
        this.stopPolling();
      }
    } finally {
      // SIEMPRE liberar el writer lock, incluso si hubo error.
      // Sin esto, el lock queda tomado y port.close() nunca puede terminar.
      if (writer) {
        try { writer.releaseLock(); } catch (e) { /* ignore */ }
      }
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

  /**
   * Loop de lectura continua del puerto serial.
   *
   * Esta función retorna una Promise que se resuelve cuando el loop
   * termina. disconnect() hace await de esta Promise para saber cuándo
   * es seguro cerrar el port.
   *
   * El loop termina cuando:
   * - reader.read() devuelve {done: true} (por reader.cancel() en disconnect)
   * - Hay un error de lectura (puerto desconectado físicamente, etc.)
   * - _disconnecting es true (salida limpia)
   *
   * CRÍTICO: el reader.releaseLock() SIEMPRE se ejecuta en el finally,
   * garantizando que el lock se libera incluso si hay errores.
   */
  async _readLoop() {
    while (this.port && !this._disconnecting) {
      try {
        this.reader = this.port.readable.getReader();
        try {
          while (true) {
            var result = await this.reader.read();
            if (result.done) {
              // reader.cancel() fue llamado — salir limpiamente
              break;
            }
            if (result.value && result.value.length > 0) {
              this.parser.feed(result.value);
            }
          }
        } finally {
          // SIEMPRE liberar el reader lock.
          // Esto es lo que permite que port.close() funcione después.
          this.reader.releaseLock();
          this.reader = null;
        }
      } catch (e) {
        // Error de lectura — puede ser desconexión física del Labdisc
        if (!this._disconnecting) {
          this._log('err', 'Read error: ' + e.message);
        }
        // Intentar liberar por si el finally no corrió
        if (this.reader) {
          try { this.reader.releaseLock(); } catch (x) { /* ignore */ }
          this.reader = null;
        }
        break;
      }
    }

    this._log('info', 'Read loop terminado');
  }

  // ─── Private: send ───

  /**
   * Envía un paquete raw al Labdisc.
   * Igual que _sendPoll, chequea _disconnecting y usa try/finally
   * para garantizar que el writer lock siempre se libera.
   */
  async _sendRaw(pkt, name) {
    if (this._disconnecting || !this.port || !this.isConnected) return;

    var writer = null;
    try {
      writer = this.port.writable.getWriter();
      await writer.write(pkt);
      this._log('tx', fmtHex(pkt) + ' (' + name + ')');
    } catch (e) {
      if (!this._disconnecting) {
        this._log('err', 'TX error: ' + e.message);
      }
    } finally {
      if (writer) {
        try { writer.releaseLock(); } catch (e) { /* ignore */ }
      }
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