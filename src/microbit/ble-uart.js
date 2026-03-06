/**
 * ble-uart.js — micro:bit BLE UART connection
 * 
 * v4.0 — Basado en app de referencia que funciona.
 * 
 * Cambios clave vs versión anterior:
 * - Solo usa characteristic 0003 para escribir (writeValueWithoutResponse)
 * - NO pide characteristic 0002 ni hace startNotifications
 *   (eso causaba que la micro:bit no recibiera datos)
 * - Fragmenta mensajes largos en chunks de 20 bytes
 * - Keep-alive cada 2 minutos para mantener la conexión
 */

const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const KEEP_ALIVE_INTERVAL = 120000; // 2 minutos

export const BleState = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
});

export class MicrobitBLE {
  constructor() {
    /** @type {BluetoothDevice|null} */
    this.device = null;

    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this.txCharacteristic = null;

    /** @type {string} */
    this.state = BleState.DISCONNECTED;

    /** @type {number|null} Keep-alive timer */
    this._keepAliveTimer = null;

    // ─── Callbacks ───
    /** @type {function(string)} */
    this.onStateChange = null;

    /** @type {function(string)} Data received from micro:bit (not used currently) */
    this.onReceive = null;

    /** @type {function(string, string)} Log (type, message) */
    this.onLog = null;
  }

  // ─── Public API ───

  static isSupported() {
    return 'bluetooth' in navigator;
  }

  get isConnected() {
    return this.state === BleState.CONNECTED
      && this.txCharacteristic !== null
      && this.device !== null
      && this.device.gatt.connected;
  }

  /**
   * Connect to a micro:bit via BLE.
   */
  async connect() {
    if (this.isConnected) return;

    try {
      this._setState(BleState.CONNECTING);
      this._log('info', 'Buscando micro:bit...');

      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'BBC micro:bit' }],
        optionalServices: [UART_SERVICE_UUID],
      });

      this.device.addEventListener('gattserverdisconnected', () => {
        this._log('info', 'micro:bit desconectada');
        this._cleanup();
      });

      this._log('info', `Conectando a ${this.device.name}...`);
      const server = await this.device.gatt.connect();

      this._log('info', 'Obteniendo servicio UART...');
      const service = await server.getPrimaryService(UART_SERVICE_UUID);

      // Solo el characteristic para ESCRIBIR (0003)
      this.txCharacteristic = await service.getCharacteristic(UART_TX_UUID);

      this._setState(BleState.CONNECTED);
      this._log('info', `micro:bit conectada: ${this.device.name}`);

      this._startKeepAlive();

    } catch (e) {
      if (e.name !== 'NotFoundError') {
        this._log('err', `BLE: ${e.message}`);
      }
      this._cleanup();
    }
  }

  /**
   * Disconnect from the micro:bit.
   */
  async disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this._cleanup();
    this._log('info', 'micro:bit desconectada');
  }

  /**
   * Send a text string to the micro:bit via UART.
   * Fragments into 20-byte BLE packets using writeValueWithoutResponse.
   * 
   * @param {string} text - Text to send (e.g., "263,587,1136,...\n")
   */
  async send(text) {
    if (!this.txCharacteristic) return;

    const encoder = new TextEncoder();
    const data = encoder.encode(text);

    // Fragment into 20-byte chunks (BLE MTU)
    const chunkSize = 10;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      try {
        await this.txCharacteristic.writeValueWithoutResponse(chunk);
      } catch (e) {
        this._log('err', `BLE write: ${e.message}`);
        break;
      }
    }
  }

  // ─── Private ───

  _cleanup() {
    this.txCharacteristic = null;
    this._stopKeepAlive();
    this._setState(BleState.DISCONNECTED);
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    var self = this;
    this._keepAliveTimer = setInterval(function() {
      if (self.isConnected) {
        var encoder = new TextEncoder();
        self.txCharacteristic.writeValueWithoutResponse(encoder.encode('\n'))
          .catch(function(e) { self._log('warn', 'Keep-alive failed: ' + e.message); });
      } else {
        self._stopKeepAlive();
      }
    }, KEEP_ALIVE_INTERVAL);
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  _log(type, msg) {
    if (this.onLog) this.onLog(type, msg);
  }
} 