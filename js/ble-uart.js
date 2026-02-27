/**
 * ble-uart.js — micro:bit BLE UART connection (Nordic UART Service)
 * 
 * Handles Web Bluetooth connection to the micro:bit's UART service.
 * Sends data as text lines over the RX characteristic.
 * 
 * Service: 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
 * TX (micro:bit → App): 6E400002... (notify)
 * RX (App → micro:bit): 6E400003... (write)
 * 
 * STATUS: Phase 2 — Stub with interface defined.
 * TODO: Implement full Web Bluetooth connection.
 */

const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX_UUID      = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_UUID      = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

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
    this.rxCharacteristic = null;

    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this.txCharacteristic = null;

    /** @type {string} */
    this.state = BleState.DISCONNECTED;

    // ─── Callbacks ───
    /** @type {function(string)} */
    this.onStateChange = null;

    /** @type {function(string)} Data received from micro:bit */
    this.onReceive = null;

    /** @type {function(string, string)} Log (type, message) */
    this.onLog = null;
  }

  // ─── Public API ───

  /** Check if Web Bluetooth is available */
  static isSupported() {
    return 'bluetooth' in navigator;
  }

  get isConnected() {
    return this.state === BleState.CONNECTED;
  }

  /**
   * Connect to a micro:bit via BLE.
   * Opens the Bluetooth device picker dialog.
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

      // Handle disconnection
      this.device.addEventListener('gattserverdisconnected', () => {
        this._log('info', 'micro:bit desconectada');
        this._setState(BleState.DISCONNECTED);
        this.rxCharacteristic = null;
        this.txCharacteristic = null;
      });

      this._log('info', `Conectando a ${this.device.name}...`);
      const server = await this.device.gatt.connect();

      this._log('info', 'Obteniendo servicio UART...');
      const service = await server.getPrimaryService(UART_SERVICE_UUID);

      // RX: App → micro:bit (we write to this)
      this.rxCharacteristic = await service.getCharacteristic(UART_RX_UUID);

      // TX: micro:bit → App (we listen to this)
      this.txCharacteristic = await service.getCharacteristic(UART_TX_UUID);
      await this.txCharacteristic.startNotifications();
      this.txCharacteristic.addEventListener('characteristicvaluechanged', (event) => {
        const decoder = new TextDecoder();
        const text = decoder.decode(event.target.value);
        if (this.onReceive) this.onReceive(text);
      });

      this._setState(BleState.CONNECTED);
      this._log('info', `micro:bit conectada: ${this.device.name}`);

    } catch (e) {
      if (e.name !== 'NotFoundError') {
        this._log('err', `BLE: ${e.message}`);
      }
      this._setState(BleState.DISCONNECTED);
    }
  }

  /**
   * Disconnect from the micro:bit.
   */
  async disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.rxCharacteristic = null;
    this.txCharacteristic = null;
    this._setState(BleState.DISCONNECTED);
    this._log('info', 'micro:bit desconectada');
  }

  /**
   * Send a text string to the micro:bit via UART.
   * Automatically fragments into 20-byte BLE packets.
   * 
   * @param {string} text - Text to send (e.g., "263,587,1136,...\n")
   */
  async send(text) {
    if (!this.rxCharacteristic) return;

    const encoder = new TextEncoder();
    const data = encoder.encode(text);

    // Fragment into 20-byte chunks (BLE MTU)
    const chunkSize = 20;
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      try {
        await this.rxCharacteristic.writeValue(chunk);
      } catch (e) {
        this._log('err', `BLE write: ${e.message}`);
        break;
      }
    }
  }

  // ─── Private ───

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    if (this.onStateChange) this.onStateChange(newState);
  }

  _log(type, msg) {
    if (this.onLog) this.onLog(type, msg);
  }
}
