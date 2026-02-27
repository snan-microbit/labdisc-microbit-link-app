/**
 * parser.js — Labdisc packet parser
 * 
 * Handles incoming byte stream from the Labdisc, detects packet boundaries,
 * verifies checksums, and dispatches parsed data via callbacks.
 * 
 * Packet types supported:
 * - 0x82: Sensor ID list (21 bytes, fixed)
 * - 0x83: Device status / ACK (33 bytes, fixed)
 * - 0x81: Online data (41 bytes, all sensors, ~1Hz)
 * - 0x84: Experiment data (variable length, active sensors only)
 */

import { RSP, FIXED_LENGTHS, NO_DATA_0x8000, STATUS_SUB, verifyChecksum } from './protocol.js';
import { SENSORS, decodeGPSCoord } from './sensors.js';

export class LabdiscParser {
  constructor() {
    /** @type {number[]} Accumulation buffer for incoming bytes */
    this.buffer = [];

    /** @type {number[]} Sensor IDs in the order reported by the device */
    this.sensorIds = [];

    /** @type {number} Running count of data packets received */
    this.packetCount = 0;

    // ─── Callbacks (set by consumer) ───
    
    /** Called when sensor ID list is received. @type {function(number[])} */
    this.onSensorIds = null;

    /** Called when device status/ACK is received. @type {function(Object)} */
    this.onStatus = null;

    /** Called when sensor data is received (0x81 or 0x84). @type {function(Object)} */
    this.onData = null;

    /** Called for every parsed packet (for logging). @type {function(string, string)} */
    this.onLog = null;
  }

  /**
   * Feed raw bytes into the parser.
   * Call this with each chunk received from the serial port.
   * @param {Uint8Array} bytes 
   */
  feed(bytes) {
    for (const b of bytes) this.buffer.push(b);
    this._processBuffer();
  }

  /** Reset parser state */
  reset() {
    this.buffer = [];
    this.sensorIds = [];
    this.packetCount = 0;
  }

  // ─── Private: buffer processing ───

  _processBuffer() {
    const buf = this.buffer;
    let safety = 0;

    while (buf.length >= 4 && safety++ < 50) {
      // Find response header 0x2E 0x69
      let hdr = -1;
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x2E && buf[i + 1] === 0x69) { hdr = i; break; }
      }

      // No header found — keep last 2 bytes (might be partial header)
      if (hdr === -1) {
        if (buf.length > 200) buf.splice(0, buf.length - 2);
        break;
      }

      // Discard bytes before header
      if (hdr > 0) buf.splice(0, hdr);
      if (buf.length < 4) break;

      // Determine packet length
      const type = buf[2];
      let len = this._getPacketLength(type, buf);

      if (len === null) {
        // Unknown type — skip this byte and try again
        buf.splice(0, 1);
        continue;
      }

      if (len < 4 || len > 800) {
        buf.splice(0, 1);
        continue;
      }

      // Wait for complete packet
      if (buf.length < len) break;

      // Extract packet
      const pkt = buf.splice(0, len);

      // Verify checksum
      if (verifyChecksum(pkt)) {
        this._handlePacket(type, pkt);
      } else {
        // Bad checksum — re-inject from byte 1 to retry sync
        this._log('warn', `Bad checksum, resync (type=0x${type.toString(16)}, ${pkt.length}b)`);
        for (let i = pkt.length - 1; i >= 1; i--) buf.unshift(pkt[i]);
        if (safety > 30) buf.splice(0, 10);
      }
    }
  }

  /**
   * Determine expected packet length for a given type.
   * @returns {number|null} Expected length, or null if unknown type
   */
  _getPacketLength(type, buf) {
    // Fixed-length types
    if (type in FIXED_LENGTHS) return FIXED_LENGTHS[type];

    // Variable-length types (length in byte 3)
    if (type === RSP.ONLINE_DATA || type === RSP.EXPERIMENT_DATA || type === RSP.CONFIG) {
      return buf.length >= 4 ? buf[3] : null;
    }

    // Unknown type
    return null;
  }

  // ─── Private: packet dispatch ───

  _handlePacket(type, pkt) {
    switch (type) {
      case RSP.SENSOR_IDS:     this._parseSensorIds(pkt); break;
      case RSP.DEVICE_STATUS:  this._parseStatus(pkt); break;
      case RSP.ONLINE_DATA:    this._parseOnlineData(pkt); break;
      case RSP.EXPERIMENT_DATA:this._parseExperimentData(pkt); break;
      default:
        this._log('rx', `Unknown type 0x${type.toString(16)} (${pkt.length}b)`);
    }
  }

  // ─── 0x82: Sensor ID List ───

  _parseSensorIds(pkt) {
    const ids = [];
    for (let i = 3; i < pkt.length - 1; i++) {
      if (pkt[i] !== 0) ids.push(pkt[i]);
    }
    this.sensorIds = ids;

    this._log('rx', `SensorIDs: [${ids.join(',')}] (${ids.length} sensores)`);

    const names = ids.map(id => {
      const s = SENSORS[id];
      return s ? `${s.name}(${id})` : `?(${id})`;
    }).join(', ');
    this._log('info', names);

    if (this.onSensorIds) this.onSensorIds(ids);
  }

  // ─── 0x83: Device Status / ACK ───

  _parseStatus(pkt) {
    const sub = pkt[3];
    const bcd = i => pkt[i].toString(16).padStart(2, '0');

    const status = {
      subType: sub,
      subName: STATUS_SUB[sub] || `Sub:0x${sub.toString(16)}`,
      model: pkt[4],
      firmware: `${pkt[5]}.${pkt[6].toString(16).padStart(2, '0')}`,
      active: pkt[7] === 0x01,
      sensorMask: (pkt[9] << 8) | pkt[10],
      rateIdx: pkt[11],
      countIdx: pkt[12],
      date: `${bcd(13)}/${bcd(14)}/20${bcd(15)}`,
      time: `${bcd(16)}:${bcd(17)}:${bcd(18)}`,
      sensorCount: pkt[29],
    };

    this._log('rx', `${status.subName}: ${status.date} ${status.time} | ${status.active ? 'ACTIVO' : 'idle'} | mask:0x${status.sensorMask.toString(16)}`);

    if (this.onStatus) this.onStatus(status);
  }

  // ─── 0x81: Online Data (fixed 41 bytes, all sensor slots) ───

  _parseOnlineData(pkt) {
    if (this.sensorIds.length === 0) return;

    let offset = 4;
    const values = {};

    for (const sid of this.sensorIds) {
      const sensor = SENSORS[sid];

      // GPS: 8 bytes (4 lat + 4 lon) — no vel/ang in 0x81
      if (sid === 7) {
        if (offset + 8 > pkt.length - 1) break;
        const lat = decodeGPSCoord(pkt[offset], pkt[offset + 1], pkt[offset + 2], pkt[offset + 3]);
        const lon = decodeGPSCoord(pkt[offset + 4], pkt[offset + 5], pkt[offset + 6], pkt[offset + 7]);
        offset += 8;
        values[7] = { raw: 0, value: 0, noData: false, lat, lon };
        continue;
      }

      if (offset + 2 > pkt.length - 1) break;
      const raw = (pkt[offset] << 8) | pkt[offset + 1];
      offset += 2;

      values[sid] = this._convertRaw(sid, raw, sensor);
    }

    this.packetCount++;
    this._emitData(values);
  }

  // ─── 0x84: Experiment Data (variable length, active sensors only) ───

  _parseExperimentData(pkt) {
    if (this.sensorIds.length === 0) return;

    const mask = (pkt[4] << 8) | pkt[5];
    const counter = pkt[7];

    let offset = 8; // Data starts at byte 8
    const values = {};

    for (let bitIdx = 0; bitIdx < this.sensorIds.length; bitIdx++) {
      const sid = this.sensorIds[bitIdx];
      const isActive = (mask >> bitIdx) & 1;
      const sensor = SENSORS[sid];

      if (!isActive) {
        values[sid] = { raw: 0xFFFF, value: null, noData: true };
        continue;
      }

      // GPS: 12 bytes (4 lat + 4 lon + 2 vel + 2 ang)
      if (sid === 7) {
        if (offset + 12 > pkt.length - 1) break;
        const lat = decodeGPSCoord(pkt[offset], pkt[offset + 1], pkt[offset + 2], pkt[offset + 3]);
        const lon = decodeGPSCoord(pkt[offset + 4], pkt[offset + 5], pkt[offset + 6], pkt[offset + 7]);
        const vel = (pkt[offset + 8] << 8) | pkt[offset + 9];
        const ang = (pkt[offset + 10] << 8) | pkt[offset + 11];
        offset += 12;
        values[7] = { raw: 0, value: 0, noData: false, lat, lon, vel: vel / 10, ang: ang / 10 };
        continue;
      }

      if (offset + 2 > pkt.length - 1) break;
      const raw = (pkt[offset] << 8) | pkt[offset + 1];
      offset += 2;

      values[sid] = this._convertRaw(sid, raw, sensor);
    }

    this.packetCount++;
    values._counter = counter;
    this._emitData(values);
  }

  // ─── Private helpers ───

  /**
   * Convert a raw uint16 to a physical value.
   * Returns { raw, value, noData } object.
   */
  _convertRaw(sid, raw, sensor) {
    const isNoData = (raw === 0xFFFF) || (raw === 0x8000 && NO_DATA_0x8000.has(sid));

    let value = null;
    if (!isNoData && sensor && sensor.convert) {
      try {
        value = sensor.convert(raw);
        if (!Number.isFinite(value)) value = null;
      } catch (e) {
        value = null;
      }
    }

    return { raw, value, noData: isNoData };
  }

  /**
   * Emit parsed sensor data through callback.
   */
  _emitData(values) {
    // Log summary periodically
    if (this.packetCount <= 3 || this.packetCount % 10 === 0) {
      const summary = this.sensorIds
        .filter(id => values[id] && values[id].value !== null && id !== 7)
        .map(id => {
          const s = SENSORS[id];
          return s ? `${s.name}:${values[id].value.toFixed(s.dec)}` : '';
        })
        .filter(Boolean)
        .join(' · ');
      this._log('rx', `#${this.packetCount} ${summary || '(sin datos)'}`);
    }

    if (this.onData) this.onData(values, this.packetCount);
  }

  _log(type, msg) {
    if (this.onLog) this.onLog(type, msg);
  }
}
