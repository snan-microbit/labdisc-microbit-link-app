/**
 * formatter.js — Data formatter for UART transmission
 * 
 * v4.0 — Split into two lines for BLE UART limit
 * 
 * The micro:bit BLE UART buffer is ~62 bytes. Our full 16-field CSV
 * can reach ~80 bytes, which overflows and crashes the micro:bit.
 * 
 * Solution: split into two lines prefixed with A, and B,:
 *   Line A (8 fields): "A,274,655,2,1013,-9999,-9999,560,-9999\n"  (~45 bytes max)
 *   Line B (8 fields): "B,5,0,-9999,-9999,-347746,-558208,0,161\n" (~50 bytes max)
 * 
 * The micro:bit receives both lines and reconstructs the full dataset.
 * The prefix A/B tells it which half it's receiving.
 * 
 * GPS precision reduced from ÷100000 to ÷10000 (4 decimals, ~11m accuracy)
 * to keep line B under 62 bytes in worst case.
 */

import { SENSORS, UART_ORDER_A, UART_ORDER_B, NO_DATA_VALUE } from '../labdisc/sensors.js';

/**
 * Format sensor values into two UART CSV lines.
 * 
 * @param {Object} values - Parsed sensor values from LabdiscParser.onData
 * @returns {string[]} Array of two lines: ["A,...\n", "B,...\n"]
 */
export function formatForUART(values) {
  var lineA = 'A,' + _formatFields(values, UART_ORDER_A).join(',') + '\n';
  var lineB = 'B,' + _formatFields(values, UART_ORDER_B).join(',') + '\n';
  return [lineA, lineB];
}

function _formatFields(values, order) {
  var parts = [];
  for (var i = 0; i < order.length; i++) {
    var entry = order[i];
    var data = values[entry.id];

    if (entry.gpsField) {
      var gpsValue = _extractGPSField(data, entry.gpsField);
      if (gpsValue === null) {
        parts.push(NO_DATA_VALUE);
      } else {
        parts.push(Math.round(gpsValue * entry.factor));
      }
      continue;
    }

    if (!data || data.noData || data.value === null || data.value === undefined) {
      parts.push(NO_DATA_VALUE);
    } else {
      parts.push(Math.round(data.value * entry.factor));
    }
  }
  return parts;
}

/**
 * Format sensor values for human-readable debug display.
 * (Unchanged — uses full UART_ORDER for display)
 */
export function formatForDisplay(values) {
  var allOrder = UART_ORDER_A.concat(UART_ORDER_B);
  var result = [];

  for (var i = 0; i < allOrder.length; i++) {
    var entry = allOrder[i];
    var sensor = SENSORS[entry.id];

    if (entry.gpsField) {
      var data = values[entry.id];
      var gpsValue = _extractGPSField(data, entry.gpsField);

      if (gpsValue === null) {
        result.push({
          id: entry.id, name: entry.name, value: 'n/c',
          unit: entry.unit || '', hasData: false,
        });
      } else {
        var decimals = (entry.gpsField === 'lat' || entry.gpsField === 'lon') ? 5 : 1;
        result.push({
          id: entry.id, name: entry.name, value: gpsValue.toFixed(decimals),
          unit: entry.unit || '', hasData: true,
        });
      }
      continue;
    }

    var data = values[entry.id];
    if (!sensor) continue;

    if (!data || data.noData || data.value === null) {
      result.push({
        id: entry.id, name: entry.name || sensor.name, value: 'n/c',
        unit: entry.unit || sensor.unit, hasData: false,
      });
    } else {
      result.push({
        id: entry.id, name: entry.name || sensor.name,
        value: data.value.toFixed(sensor.dec),
        unit: entry.unit || sensor.unit, hasData: true,
      });
    }
  }

  return result;
}

function _extractGPSField(gpsData, field) {
  if (!gpsData || gpsData.noData) return null;

  if (field === 'lat') {
    if (gpsData.lat && typeof gpsData.lat.decimal === 'number' && isFinite(gpsData.lat.decimal)) {
      if (gpsData.lat.decimal === 0 && gpsData.lon && gpsData.lon.decimal === 0) return null;
      return gpsData.lat.decimal;
    }
    return null;
  }

  if (field === 'lon') {
    if (gpsData.lon && typeof gpsData.lon.decimal === 'number' && isFinite(gpsData.lon.decimal)) {
      if (gpsData.lat && gpsData.lat.decimal === 0 && gpsData.lon.decimal === 0) return null;
      return gpsData.lon.decimal;
    }
    return null;
  }

  if (field === 'vel') {
    if (typeof gpsData.vel === 'number' && isFinite(gpsData.vel)) return gpsData.vel;
    return null;
  }

  if (field === 'ang') {
    if (typeof gpsData.ang === 'number' && isFinite(gpsData.ang)) return gpsData.ang;
    return null;
  }

  return null;
}