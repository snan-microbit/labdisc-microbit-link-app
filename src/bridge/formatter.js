/**
 * formatter.js — Data formatter for UART transmission
 * 
 * Converts parsed Labdisc sensor values into the standardized CSV format
 * that the micro:bit extension expects.
 * 
 * Format: "278,541,3,1020,0,0,723,0,0,0,0,0,-3477470,-5582070,0,1615\n"
 * - Values are integers (×10, ×100, ×1000, or ×100000 depending on sensor)
 * - Fixed order (same regardless of Labdisc model)
 * - -9999 = sensor not available or no data
 * 
 * GPS entries use 'gpsField' property to extract lat/lon/vel/ang from
 * the GPS data object (values[7]).
 */

import { SENSORS, UART_ORDER, NO_DATA_VALUE } from '../labdisc/sensors.js';

/**
 * Format sensor values into a UART CSV line.
 * 
 * @param {Object} values - Parsed sensor values from LabdiscParser.onData
 *   Keys are sensor IDs (numbers), values are { raw, value, noData } objects.
 *   GPS (id 7) has { lat, lon, vel, ang } with .decimal on lat/lon.
 * @returns {string} CSV line like "278,541,3,...\n"
 */
export function formatForUART(values) {
  var parts = [];

  for (var i = 0; i < UART_ORDER.length; i++) {
    var entry = UART_ORDER[i];
    var data = values[entry.id];

    // GPS sub-fields: extract from the GPS data object
    if (entry.gpsField) {
      var gpsValue = _extractGPSField(data, entry.gpsField);
      if (gpsValue === null) {
        parts.push(NO_DATA_VALUE);
      } else {
        parts.push(Math.round(gpsValue * entry.factor));
      }
      continue;
    }

    // Normal sensors
    if (!data || data.noData || data.value === null || data.value === undefined) {
      parts.push(NO_DATA_VALUE);
    } else {
      parts.push(Math.round(data.value * entry.factor));
    }
  }

  return parts.join(',') + '\n';
}

/**
 * Format sensor values for human-readable debug display.
 * 
 * @param {Object} values - Parsed sensor values
 * @returns {Object[]} Array of { id, name, value, unit, hasData } for display
 */
export function formatForDisplay(values) {
  var result = [];

  for (var i = 0; i < UART_ORDER.length; i++) {
    var entry = UART_ORDER[i];
    var sensor = SENSORS[entry.id];

    // GPS sub-fields
    if (entry.gpsField) {
      var data = values[entry.id];
      var gpsValue = _extractGPSField(data, entry.gpsField);

      if (gpsValue === null) {
        result.push({
          id: entry.id,
          name: entry.name,
          value: '—',
          unit: entry.unit || '',
          hasData: false,
        });
      } else {
        // Lat/Lon show 5 decimals, Vel/Ang show 1
        var decimals = (entry.gpsField === 'lat' || entry.gpsField === 'lon') ? 5 : 1;
        result.push({
          id: entry.id,
          name: entry.name,
          value: gpsValue.toFixed(decimals),
          unit: entry.unit || '',
          hasData: true,
        });
      }
      continue;
    }

    // Normal sensors
    var data = values[entry.id];
    if (!sensor) continue;

    if (!data || data.noData || data.value === null) {
      result.push({
        id: entry.id,
        name: entry.name || sensor.name,
        value: '—',
        unit: entry.unit || sensor.unit,
        hasData: false,
      });
    } else {
      result.push({
        id: entry.id,
        name: entry.name || sensor.name,
        value: data.value.toFixed(sensor.dec),
        unit: entry.unit || sensor.unit,
        hasData: true,
      });
    }
  }

  return result;
}

/**
 * Extract a GPS sub-field from the GPS data object.
 * 
 * The parser stores GPS data as:
 *   values[7] = { raw, value, noData, lat, lon, vel?, ang? }
 * where lat/lon are objects with { decimal, dms }.
 * 
 * @param {Object|undefined} gpsData - values[7] from parser
 * @param {string} field - 'lat', 'lon', 'vel', or 'ang'
 * @returns {number|null} The numeric value, or null if no data
 */
function _extractGPSField(gpsData, field) {
  if (!gpsData || gpsData.noData) return null;

  if (field === 'lat') {
    // lat is { decimal, dms } from decodeGPSCoord
    if (gpsData.lat && typeof gpsData.lat.decimal === 'number' && isFinite(gpsData.lat.decimal)) {
      // Check for "zero" GPS (no fix) — both bytes 0x00
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