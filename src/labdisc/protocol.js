/**
 * protocol.js — Labdisc protocol constants
 * 
 * Reverse-engineered from GlobiLab X + packet captures.
 * See: Labdisc Protocol Spec v3
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
  EXPERIMENT_LOG: 0x55,  // Respuesta a 0x45: log de experimentos almacenados, 18 bytes fijos c/u
  ONLINE_DATA:    0x81,
  SENSOR_IDS:     0x82,
  DEVICE_STATUS:  0x83,
  EXPERIMENT_DATA:0x84,
  CONFIG:         0x85,
});

/**
 * Fixed packet lengths for types that have them.
 * 
 * 0x55 (Experiment Log): confirmado 18 bytes fijos por captura del 04/03/2026.
 *   El Labdisc envía una ráfaga de N registros de 18 bytes cada uno,
 *   cada uno con header 2E 69 55 propio y checksum independiente.
 *   byte[3] es el número de registro (NO la longitud del paquete).
 * 
 * 0x85 (Config): longitud desconocida, tratamos como variable (lee byte[3]).
 */
export const FIXED_LENGTHS = Object.freeze({
  [RSP.EXPERIMENT_LOG]: 18,  // ← NUEVO: 18 bytes fijos confirmado
  [RSP.SENSOR_IDS]:     21,
  [RSP.DEVICE_STATUS]:  33,
});

/** Sub-types in 0x83 (Device Status / ACK) */
export const STATUS_SUB = Object.freeze({
  0x10: 'GetStatus',
  0x11: 'ExperimentACK',
  0x22: 'StartLoginACK',
  0x33: 'StopLoginACK',
  0x45: 'GetDeviceInfoACK',  // ← NUEVO: ACK del comando 0x45
});

/** Rate index → frequency (confirmed by testing) */
export const RATE_TABLE = Object.freeze({
  0x00: { hz: 0,  label: 'Manual' },  // ← NUEVO: visto en log de experimentos
  0x02: { hz: 1,  label: '1 Hz' },
  0x03: { hz: 10, label: '10 Hz' },
  0x04: { hz: 25, label: '25 Hz' },
  0x07: { hz: null, label: '? (0x07)' },  // ← NUEVO: visto en registro 0x5c, freq desconocida
});

/** Sample count index → count */
export const COUNT_TABLE = Object.freeze({
  0x00: 10,
  0x01: 100,
  0x02: null,  // ← NUEVO: visto en registro 0x5d, valor desconocido
  0x03: 10000,
});

/**
 * Sensors where raw value 0x8000 means "no data" (not a real measurement).
 */
export const NO_DATA_0x8000 = new Set([
  2, 4, 6, 14, 15, 16, 17, 21, 23, 25, 26, 30, 31, 40, 41, 42
]);

/**
 * Sensors where raw value 0x0000 means "no data" (inactive exclusive pair partner).
 */
export const NO_DATA_0x0000 = new Set([
  21,  // Sonido — inactivo cuando Micrófono está seleccionado
]);

// Nota sobre Voltaje(27) y Corriente(28):
// Son un par exclusivo controlado por botón físico del Labdisc.
// Cuando uno está inactivo, su raw flota cerca de 0x8000 (que convierte a ~0).
// NO los filtramos como noData porque no podemos distinguir "inactivo en ~0"
// de "activo midiendo ~0V/~0A". Ambos muestran su valor siempre.
// Cuando el usuario conecta algo al sensor activo, ese mostrará el valor
// real y el inactivo seguirá en ~0 — comportamiento correcto y no engañoso.

// ─── Checksum ───

export function calcChecksum(bytes) {
  let sum = 0;
  for (const b of bytes) sum += b;
  return (256 - (sum % 256)) % 256;
}

export function verifyChecksum(packet) {
  let sum = 0;
  for (const b of packet) sum += b;
  return (sum & 0xFF) === 0;
}

// ─── Command builders ───

export function buildCommand(code) {
  const bytes = [...CMD_HEADER, code];
  bytes.push(calcChecksum(bytes));
  return new Uint8Array(bytes);
}

export function buildCommandWithPayload(code, payload) {
  const bytes = [...CMD_HEADER, code, ...payload];
  bytes.push(calcChecksum(bytes));
  return new Uint8Array(bytes);
}

/**
 * Build StartExperiment command (0x11).
 * @param {number} maskHi - High byte of sensor mask
 * @param {number} maskLo - Low byte of sensor mask
 * @param {number} rateIdx - Rate index (0x02=1Hz, 0x03=10Hz, 0x04=25Hz)
 * @param {number} countIdx - Sample count index (0x00=10, 0x01=100, 0x03=10000)
 */
export function buildStartExperiment(maskHi, maskLo, rateIdx, countIdx) {
  const payload = [maskHi, maskLo, rateIdx, countIdx, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return buildCommandWithPayload(CMD.START_EXPERIMENT, payload);
}

/** Format bytes as hex string for logging */
export function fmtHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}