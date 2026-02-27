/**
 * formatter.js — Data formatter for UART transmission
 * 
 * Converts parsed Labdisc sensor values into the standardized CSV format
 * that the micro:bit extension expects.
 * 
 * Format: "263,587,1136,1013,0,0,723,0,0,0,0,0,0\n"
 * - Values are integers (×10, ×100, or ×1000 depending on sensor)
 * - Fixed order (same regardless of Labdisc model)
 * - -9999 = sensor not available or no data
 */

import { SENSORS, UART_ORDER, NO_DATA_VALUE } from '../labdisc/sensors.js';

/**
 * Format sensor values into a UART CSV line.
 * 
 * @param {Object} values - Parsed sensor values from LabdiscParser.onData
 *   Keys are sensor IDs (numbers), values are { raw, value, noData } objects.
 * @returns {string} CSV line like "263,587,1136,...\n"
 */
export function formatForUART(values) {
  const parts = [];

  for (const entry of UART_ORDER) {
    const data = values[entry.id];

    if (!data || data.noData || data.value === null || data.value === undefined) {
      parts.push(NO_DATA_VALUE);
    } else {
      // Multiply by factor and round to integer
      parts.push(Math.round(data.value * entry.factor));
    }
  }

  return parts.join(',') + '\n';
}

/**
 * Format sensor values into a human-readable debug string.
 * 
 * @param {Object} values - Parsed sensor values
 * @returns {Object[]} Array of { name, value, unit, hasData } for display
 */
export function formatForDisplay(values) {
  const result = [];

  for (const entry of UART_ORDER) {
    const sensor = SENSORS[entry.id];
    const data = values[entry.id];

    if (!sensor) continue;

    if (!data || data.noData || data.value === null) {
      result.push({
        id: entry.id,
        name: sensor.name,
        value: '—',
        unit: sensor.unit,
        hasData: false,
      });
    } else {
      result.push({
        id: entry.id,
        name: sensor.name,
        value: data.value.toFixed(sensor.dec),
        unit: sensor.unit,
        hasData: true,
      });
    }
  }

  return result;
}
