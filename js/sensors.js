/**
 * sensors.js — Labdisc sensor catalog and conversion formulas
 * 
 * Extracted from GlobiLab X function A.f9() (line 82471) and auxiliary functions.
 * Verified against real packet captures from a Labdisc GenSci.
 */

// ─── Helper functions ───

/** Linear interpolation between two ranges */
function mb(r, rMin, rMax, vMin, vMax) {
  return (r - rMin) / (rMax - rMin) * (vMax - vMin) + vMin;
}

/** Light sensor — segmented interpolation table c8v() */
function convertLight(raw) {
  if (raw === 0 || raw === 65535) return 0;
  const table = [
    0, 0, 0.00054,
    3714, 2, 0.00215,
    7427, 10, 0.00269,
    11141, 20, 0.02154,
    14855, 100, 0.02693,
    18568, 200, 0.21542,
    22282, 1000, 0.26928,
    25996, 2000, 2.154,
    29709, 1e4, 2.693,
    33423, 2e4, 18.849,
    35280 // upper limit sentinel
  ];
  let i = 0;
  while (raw > table[i]) i += 3;
  if (i !== 0) i -= 3;
  return (raw - table[i]) * table[i + 2] + table[i + 1];
}

/** External temperature — thermistor table c8w() */
function convertExtTemp(raw) {
  const t = [
    62587, -40, 0.0056201, 61698, -35, 0.0046082, 60613, -30, 0.0038338,
    59309, -25, 0.0032394, 57765, -20, 0.0027826, 55968, -15, 0.0024331,
    53913, -10, 0.002168,  51607, -5, 0.0019704,  49069, 0, 0.0018274,
    46333, 5, 0.001731,    43445, 10, 0.0016739,  40458, 15, 0.0016514,
    37430, 20, 0.0016621,  34422, 25, 0.0017029,  31486, 30, 0.0017738,
    28667, 35, 0.0018773,  26003, 40, 0.0020116,  23518, 45, 0.0021819,
    21226, 50, 0.0023894,  19134, 55, 0.0026435,  17242, 60, 0.0029314,
    15537, 65, 0.0032898,  14017, 70, 0.0036839,  12659, 75, 0.0041677,
    11460, 80, 0.0046932,  10394, 85, 0.0053328,  9457, 90, 0.0060505,
    8630, 95, 0.0068394,   7899, 100, 0.0078301,  7261, 105, 0.0088086,
    6693, 110, 0.0101603,  6201, 115, 0.0114695,  5765, 120, 0.0128549,
    5376 // lower limit sentinel
  ];
  if (raw > t[0]) return t[1];
  if (raw < t[t.length - 1]) return t[t.length - 4];
  let i = 0;
  while (t[i * 3] > raw) i++;
  const idx = (i - 1) * 3;
  return t[idx + 1] + (t[idx] - raw) * t[idx + 2];
}

/** Signed int16 conversion */
function signed16(r) {
  return r > 32767 ? r - 65536 : r;
}

/** GPS coordinate decoder — function bHL() from GlobiLab X */
export function decodeGPSCoord(b0, b1, b2, b3) {
  const hex = [b0, b1, b2, b3].map(b => b.toString(16).padStart(2, '0')).join('');
  const deg = parseInt(hex.slice(0, 2), 16);
  const minRaw = parseInt(hex.slice(2, 6), 16);
  const minutes = minRaw / 1000;
  const dirHex = hex.slice(6, 8);
  const isPositive = (dirHex === '4e' || dirHex === '45' || dirHex === '00'); // N, E, null
  const decDeg = deg + minutes / 60;
  return {
    decimal: isPositive ? decDeg : -decDeg,
    dms: `${deg}°${minutes.toFixed(3)}'${
      dirHex === '4e' ? 'N' : dirHex === '53' ? 'S' :
      dirHex === '45' ? 'E' : dirHex === '57' ? 'W' : '?'
    }`,
  };
}


// ─── Sensor catalog ───

/**
 * Complete sensor definitions.
 * 
 * Each sensor has:
 * - name: Human-readable name
 * - unit: Unit of measurement
 * - dec: Decimal places for display
 * - bytes: Bytes occupied in packet (2 for most, 12 for GPS)
 * - convert: Function(raw_uint16) → physical value
 * - factor: Multiplier for UART transmission (value × factor = integer)
 */
export const SENSORS = Object.freeze({
  1:  { name: 'UV',           unit: 'idx',  dec: 2, bytes: 2, factor: 100,  convert: r => Math.max(0, (r - 21845) * 458 * 150 / 1e6 / 100) },
  2:  { name: 'pH',           unit: 'pH',   dec: 2, bytes: 2, factor: 100,  convert: r => r / 1000 },
  4:  { name: 'Barómetro',    unit: 'hPa',  dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 5000, 11500, 500, 1150) },
  5:  { name: 'Temp IR',      unit: '°C',   dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 5157, 32657, -170, 380) },
  6:  { name: 'Humedad',      unit: '%',    dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 0, 1000, 0, 100) },
  7:  { name: 'GPS',          unit: '',     dec: 0, bytes: 12, factor: 1,   convert: null }, // Special: 8 coord + 2 vel + 2 ang
  10: { name: 'GPS Vel',      unit: 'km/h', dec: 1, bytes: 2, factor: 10,   convert: r => r / 10 },
  11: { name: 'GPS Áng',      unit: '°',    dec: 1, bytes: 2, factor: 10,   convert: r => r / 10 },
  13: { name: 'Temp Ext',     unit: '°C',   dec: 1, bytes: 2, factor: 10,   convert: r => convertExtTemp(r) },
  15: { name: 'Color R',      unit: '',     dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 0, 1000, 0, 100) / 10 },
  16: { name: 'Color G',      unit: '',     dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 0, 1000, 0, 100) / 10 },
  17: { name: 'Color B',      unit: '',     dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 0, 1000, 0, 100) / 10 },
  20: { name: 'Luz',          unit: 'lux',  dec: 0, bytes: 2, factor: 1,    convert: r => convertLight(r) },
  21: { name: 'Sonido',       unit: 'dB',   dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 540, 960, 54, 96) },
  22: { name: 'Pulso',        unit: 'bpm',  dec: 0, bytes: 2, factor: 1,    convert: r => r > 240 ? 0 : r },
  23: { name: 'HeartRate',    unit: 'bpm',  dec: 0, bytes: 2, factor: 1,    convert: r => r > 240 ? 0 : r },
  24: { name: 'Onda Pulso',   unit: 'V',    dec: 5, bytes: 2, factor: 10000,convert: r => r * 0.00004578754578754579 },
  25: { name: 'Distancia',    unit: 'm',    dec: 3, bytes: 2, factor: 1000, convert: r => mb(r, 400, 10000, 0.4, 10) },
  26: { name: 'Presión',      unit: 'kPa',  dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 0, 3000, 0, 300) },
  27: { name: 'Voltaje',      unit: 'V',    dec: 3, bytes: 2, factor: 1000, convert: r => mb(r, 15527, 50009, -5, 5) },
  28: { name: 'Corriente',    unit: 'A',    dec: 3, bytes: 2, factor: 1000, convert: r => mb(r, 14318, 51218, -1, 1) },
  29: { name: 'Humedad Ext',  unit: '%',    dec: 1, bytes: 2, factor: 10,   convert: r => (Math.min(56848, Math.max(12288, r)) - 12288) * 224 / 1e4 / 10 },
  30: { name: 'Temp Amb',     unit: '°C',   dec: 1, bytes: 2, factor: 10,   convert: r => signed16(r) / 10 },
  31: { name: 'Turbidez',     unit: 'NTU',  dec: 1, bytes: 2, factor: 10,   convert: r => r / 10 },
  32: { name: 'Ext Analog',   unit: 'V',    dec: 3, bytes: 2, factor: 1000, convert: r => r * 92 / 1e4 / 100 },
  33: { name: 'Micrófono',    unit: 'V',    dec: 3, bytes: 2, factor: 1000, convert: r => mb(r, 0, 65535, 0, 3.3) },
  34: { name: 'Voltaje Bajo', unit: 'mV',   dec: 0, bytes: 2, factor: 1,    convert: r => mb(r, 15163, 50373, -500, 500) },
  36: { name: 'Acel X',       unit: 'g',    dec: 3, bytes: 2, factor: 1000, convert: r => r * 0.0002442 },
  37: { name: 'Acel Y',       unit: 'g',    dec: 3, bytes: 2, factor: 1000, convert: r => r * 0.0002442 },
  38: { name: 'Acel Z',       unit: 'g',    dec: 3, bytes: 2, factor: 1000, convert: r => r * 0.0002442 },
  39: { name: 'Ext Analog 2', unit: 'V',    dec: 3, bytes: 2, factor: 1000, convert: r => r * 92 / 1e4 / 100 },
  40: { name: 'O₂ Disuelto',  unit: 'mg/L', dec: 2, bytes: 2, factor: 100,  convert: r => mb(r, 0, 1400, 0, 14) },
  41: { name: 'Respiración',  unit: '',     dec: 1, bytes: 2, factor: 10,   convert: r => mb(r, 0, 2000, 0, 20) },
  42: { name: 'Temp (2)',     unit: '°C',   dec: 1, bytes: 2, factor: 10,   convert: r => signed16(r) / 10 },
  47: { name: 'Baróm kPa',   unit: 'kPa',  dec: 2, bytes: 2, factor: 100,  convert: r => r / 100 },
  49: { name: 'Voltaje Alt',  unit: 'V',    dec: 3, bytes: 2, factor: 1000, convert: r => (r - 32768) * 1084 / 1e4 / 100 },
  50: { name: 'Corriente Alt',unit: 'A',    dec: 4, bytes: 2, factor: 10000,convert: r => r * 0.5 / 28558 },
});


// ─── Standardized order for UART transmission ───

/**
 * Fixed order of sensors for UART CSV output.
 * This order is always the same regardless of the Labdisc model.
 * The micro:bit extension knows this order and reads by position.
 * 
 * Each entry: { id, name, factor }
 */
export const UART_ORDER = [
  { id: 30, name: 'Temp Amb',   factor: 10 },
  { id: 6,  name: 'Humedad',    factor: 10 },
  { id: 20, name: 'Luz',        factor: 1 },
  { id: 26, name: 'Presión',    factor: 10 },
  { id: 2,  name: 'pH',         factor: 100 },
  { id: 25, name: 'Distancia',  factor: 1000 },
  { id: 21, name: 'Sonido',     factor: 10 },
  { id: 13, name: 'Temp Ext',   factor: 10 },
  { id: 27, name: 'Voltaje',    factor: 1000 },
  { id: 28, name: 'Corriente',  factor: 1000 },
  { id: 33, name: 'Micrófono',  factor: 1000 },
  { id: 32, name: 'Ext Analog', factor: 1000 },
  { id: 4,  name: 'Barómetro',  factor: 10 },
];

/** Sentinel value for "no data" in UART output */
export const NO_DATA_VALUE = -9999;
