/**
 * app.js — UI controller
 * 
 * Wires the Bridge module to DOM elements.
 * Handles button clicks, state rendering, and debug display.
 */

import { Bridge } from '../bridge/bridge.js';
import { LabdiscConnection, ConnectionState } from '../labdisc/connection.js';
import { MicrobitBLE, BleState } from '../microbit/ble-uart.js';
import { Logger } from './logger.js';

// ─── DOM references ───
const $ = id => document.getElementById(id);

// ─── Initialize ───

const bridge = new Bridge();
const logger = new Logger($('logBody'));
logger.counterEl = $('logCount');

// ─── Wire bridge to UI ───

bridge.onLog = (type, msg) => logger.log(type, msg);
bridge.onUpdate = () => renderState();

// ─── Button handlers ───

window.handleLabdisc = async () => {
  if (bridge.labdisc.isConnected) {
    await bridge.disconnectLabdisc();
  } else {
    await bridge.connectLabdisc();
  }
};

window.handleMicrobit = async () => {
  if (bridge.microbit.isConnected) {
    await bridge.disconnectMicrobit();
  } else {
    await bridge.connectMicrobit();
  }
};

window.handleMode = (value) => {
  bridge.setMode(value);
};

window.handleManualStream = async () => {
  if (bridge.labdisc.isStreaming) {
    await bridge.labdisc.stopStreaming();
  } else if (bridge.labdisc.isConnected) {
    if (bridge.mode === 'fast') {
      await bridge.labdisc.startExperiment();
    } else {
      await bridge.labdisc.startOnline();
    }
    bridge.uartSentCount = 0;
  }
  renderState();
};

// ─── Render ───

function renderState() {
  const s = bridge.getState();

  // Labdisc connection
  const labConn = s.labdisc !== ConnectionState.DISCONNECTED;
  $('labDot').className = `status-dot ${labConn ? 'on' : ''}`;
  $('labStatus').textContent = labConn ? 'Conectado' : 'Desconectado';
  $('labStatus').className = `status-text ${labConn ? 'on' : ''}`;
  $('btnLabdisc').textContent = labConn ? 'Desconectar' : 'Conectar';
  $('btnLabdisc').className = `btn ${labConn ? 'danger' : 'primary'}`;

  // Labdisc detail
  if (s.deviceStatus) {
    $('labDetail').textContent = `FW ${s.deviceStatus.firmware} · ${s.sensorIds.length} sensores · ${s.deviceStatus.date} ${s.deviceStatus.time}`;
  } else if (labConn) {
    $('labDetail').textContent = 'Obteniendo info...';
  } else {
    $('labDetail').textContent = '';
  }

  // micro:bit connection
  const microConn = s.microbit === BleState.CONNECTED;
  $('microDot').className = `status-dot ${microConn ? 'on' : ''}`;
  $('microStatus').textContent = microConn ? 'Conectada' : 'Desconectada';
  $('microStatus').className = `status-text ${microConn ? 'on' : ''}`;
  $('btnMicrobit').textContent = microConn ? 'Desconectar' : 'Conectar';
  $('btnMicrobit').className = `btn ${microConn ? 'danger' : 'primary'}`;

  // Streaming status
  const streaming = s.labdisc === ConnectionState.STREAMING;
  const streamLabel = streaming
    ? `Enviando datos · ${s.mode === 'fast' ? '25 Hz' : '1 Hz'} · ${s.packetCount} paquetes`
    : 'Idle';
  $('streamStatus').textContent = streamLabel;
  $('streamStatus').className = `stream-status ${streaming ? 'active' : ''}`;

  // Manual stream button
  $('btnStream').textContent = streaming ? '⏹ Stop' : '▶ Stream';
  $('btnStream').className = `btn ${streaming ? 'danger' : 'accent'}`;
  $('btnStream').disabled = !labConn;

  // UART info
  if (s.uartSentCount > 0) {
    $('uartInfo').textContent = `→ micro:bit: ${s.uartSentCount} líneas enviadas`;
    $('uartLine').textContent = s.lastUartLine;
  } else {
    $('uartInfo').textContent = '';
    $('uartLine').textContent = '';
  }

  // Sensor values (debug view)
  renderSensorValues(s.displayValues);
}

function renderSensorValues(values) {
  const grid = $('sensorGrid');
  if (!values || values.length === 0) {
    grid.innerHTML = '<div class="no-data">Sin datos</div>';
    return;
  }

  grid.innerHTML = values.map(v => `
    <div class="sensor-card ${v.hasData ? 'active' : ''}">
      <div class="sensor-name">${v.name}</div>
      <div class="sensor-value ${v.hasData ? '' : 'dim'}">${v.value}<span class="sensor-unit">${v.hasData ? v.unit : ''}</span></div>
    </div>
  `).join('');
}

// ─── API support check ───

function checkSupport() {
  const serial = LabdiscConnection.isSupported();
  const ble = MicrobitBLE.isSupported();

  if (!serial) {
    logger.log('err', 'Web Serial API no disponible. Usá Chrome 89+.');
    $('btnLabdisc').disabled = true;
  }
  if (!ble) {
    logger.log('err', 'Web Bluetooth API no disponible. Usá Chrome 89+.');
    $('btnMicrobit').disabled = true;
  }
  if (serial && ble) {
    logger.log('info', 'Web Serial + Web Bluetooth disponibles. Listo.');
  }
}

// ─── Init ───
checkSupport();
renderState();
