/**
 * protocol.js — Labdisc protocol constants
 * 
 * Reverse-engineered from GlobiLab X + packet captures.
 * See: Labdisc Protocol Spec v2
 */

export const BAUD_RATE = 9600;

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

/** Command header (Host → Labdisc) */
export const CMD_HEADER = [0x47, 0x14];

/** Response header (Labdisc → Host) */
export const RSP_HEADER = [0x2E, 0x69];

/** Command codes */
export const CMD = Object.freeze({
  GET_SENSOR_STATUS: 0x10,
  START_EXPERIMENT:  0x11,
  START_LOGIN:       0x22,
  STOP_LOGIN:        0x33,
  GET_DEVICE_INFO:   0x45,
  RESET_CLEAR:       0x48,
  GET_CONFIG:        0x55,
  GET_SENSOR_IDS:    0xAA,
  SET_DATETIME:      0xCC,
});

/** Response types */
export const RSP = Object.freeze({
  ONLINE_DATA:    0x81,
  SENSOR_IDS:     0x82,
  DEVICE_STATUS:  0x83,
  EXPERIMENT_DATA:0x84,
  CONFIG:         0x85,
});

/** Fixed packet lengths for types that have them */
export const FIXED_LENGTHS = Object.freeze({
  [RSP.SENSOR_IDS]:    21,
  [RSP.DEVICE_STATUS]: 33,
});

/** Sub-types in 0x83 (Device Status / ACK) */
export const STATUS_SUB = Object.freeze({
  0x10: 'GetStatus',
  0x11: 'ExperimentACK',
  0x22: 'StartLoginACK',
  0x33: 'StopLoginACK',
});

/** Rate index → description */
export const RATE_TABLE = Object.freeze({
  0x02: { hz: 1,  label: '1 Hz (1 muestra/seg)' },
  0x04: { hz: 25, label: '25 Hz (25 muestras/seg)' },
});

/** Sample count index → count */
export const COUNT_TABLE = Object.freeze({
  0x00: 10,
  0x01: 100,
  0x03: 10000,
});

/**
 * Sensors where raw value 0x8000 means "no data" (not a real measurement).
 * For other sensors, 0x8000 is a valid midpoint value.
 */
export const NO_DATA_0x8000 = new Set([
  2, 4, 6, 14, 15, 16, 17, 21, 23, 25, 26, 30, 31, 40, 41, 42
]);

// ─── Checksum ───

/**
 * Calculate two's complement checksum.
 * Sum of all bytes in the packet (including checksum) must be 0x00 mod 256.
 */
export function calcChecksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return (256 - (sum % 256)) % 256;
}

/**
 * Verify packet checksum.
 * @returns {boolean} true if valid
 */
export function verifyChecksum(packet) {
  let sum = 0;
  for (const b of packet) sum += b;
  return (sum & 0xFF) === 0;
}

// ─── Command builders ───

/**
 * Build a simple command (header + code + checksum).
 */
export function buildCommand(code) {
  const bytes = [...CMD_HEADER, code];
  bytes.push(calcChecksum(bytes));
  return new Uint8Array(bytes);
}

/**
 * Build a command with payload (header + code + payload + checksum).
 */
export function buildCommandWithPayload(code, payload) {
  const bytes = [...CMD_HEADER, code, ...payload];
  bytes.push(calcChecksum(bytes));
  return new Uint8Array(bytes);
}

/**
 * Build StartExperiment command (0x11).
 * @param {number} maskHi - High byte of sensor mask
 * @param {number} maskLo - Low byte of sensor mask
 * @param {number} rateIdx - Rate index (0x02=1Hz, 0x04=25Hz)
 * @param {number} countIdx - Sample count index (0x00=10, 0x01=100, 0x03=10000)
 */
export function buildStartExperiment(maskHi, maskLo, rateIdx, countIdx) {
  const payload = [maskHi, maskLo, rateIdx, countIdx, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return buildCommandWithPayload(CMD.START_EXPERIMENT, payload);
}

// ─── Utilities ───

/** Format bytes as hex string for logging */
export function fmtHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
