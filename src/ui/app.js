/**
 * app.js — UI controller
 * 
 * v5.0 — Ceibal themed, connection diagram UI
 * 
 * Wires the Bridge module to DOM elements.
 * 
 * Cambios vs v4.0:
 * - El diagrama de conexión muestra 3 nodos y 2 puentes
 * - Al conectar un dispositivo, su nodo se ilumina (clase "connected")
 *   y el puente correspondiente se activa (clase "active")
 * - Frecuencia y log están en una sección colapsable
 * - Los status dots se reemplazaron por los nodos del diagrama
 * 
 * Exposes `window.bridge` for console debugging.
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

// Expose for console debugging
window.bridge = bridge;

// ─── Wire bridge to UI ───

bridge.onLog = (type, msg) => logger.log(type, msg);
bridge.onUpdate = () => renderState();

// ─── Button handlers (global, called from onclick in HTML) ───

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

window.handleHz = (value) => {
  bridge.setHz(parseFloat(value));
};

window.handleManualStream = async () => {
  if (bridge.labdisc.isStreaming) {
    await bridge.manualStopStream();
  } else {
    await bridge.manualStartStream();
  }
};

// ─── Render ───

function renderState() {
  const s = bridge.getState();

  // ── Labdisc connection ──
  // Distinguimos 3 estados para la UI:
  // - DISCONNECTED: nodo gris, puente punteado
  // - CONNECTING: nodo pulsando, puente punteado, botón deshabilitado
  // - CONNECTED (o STREAMING): nodo teal, puente sólido
  const labConn = s.labdisc === ConnectionState.CONNECTED || s.labdisc === ConnectionState.STREAMING;
  const labConnecting = s.labdisc === ConnectionState.CONNECTING;

  // Nodo del diagrama
  const labNode = $('labNode');
  labNode.classList.toggle('connected', labConn);
  labNode.classList.toggle('connecting', labConnecting);

  // Puente Labdisc↔App
  const labBridge = $('labBridge');
  labBridge.classList.toggle('active', labConn);

  // Botón conectar/desconectar
  const btnLab = $('btnLabdisc');
  if (labConnecting) {
    btnLab.textContent = 'Conectando...';
    btnLab.className = 'btn btn-sm btn-connect';
    btnLab.disabled = true;
  } else {
    btnLab.textContent = labConn ? 'Desconectar' : 'Conectar';
    btnLab.className = `btn btn-sm ${labConn ? 'btn-disconnect' : 'btn-connect'}`;
    btnLab.disabled = false;
  }

  // Detalle del Labdisc
  $('labDetail').textContent = labConn ? 'Conectado' : (labConnecting ? 'Conectando...' : '');

  // ── micro:bit connection ──
  const microConn = s.microbit === BleState.CONNECTED;

  const microNode = $('microNode');
  if (microConn) {
    microNode.classList.add('connected');
  } else {
    microNode.classList.remove('connected');
  }

  const microBridge = $('microBridge');
  if (microConn) {
    microBridge.classList.add('active');
  } else {
    microBridge.classList.remove('active');
  }

  const btnMicro = $('btnMicrobit');
  btnMicro.textContent = microConn ? 'Desconectar' : 'Conectar';
  btnMicro.className = `btn btn-sm ${microConn ? 'btn-disconnect' : 'btn-connect'}`;

  $('microDetail').textContent = microConn ? 'Conectada' : '';

  // ── Streaming status ──
  const streaming = s.labdisc === ConnectionState.STREAMING;

  // Dot indicator
  const streamDot = $('streamDot');
  streamDot.className = `status-indicator ${streaming ? 'streaming' : ''}`;

  // Status text
  const streamLabel = streaming
    ? `${s.pollHz} Hz · ${s.packetCount} pkt${s.uartSentCount > 0 ? ' · → ' + s.uartSentCount + ' uart' : ''}`
    : 'Idle';
  const streamEl = $('streamStatus');
  streamEl.textContent = streamLabel;
  streamEl.className = `status-text-main ${streaming ? 'active' : ''}`;

  // Manual stream button
  $('btnStream').textContent = streaming ? '⏹ Stop' : '▶ Stream';
  $('btnStream').className = `btn btn-sm ${streaming ? 'btn-disconnect' : 'btn-accent'}`;
  $('btnStream').disabled = !labConn;

  // ── UART debug line ──
  if (s.lastUartLine) {
    $('uartInfo').textContent = s.uartSentCount > 0
      ? `→ micro:bit: ${s.uartSentCount} líneas · `
      : '→ UART (micro:bit no conectada) · ';
    $('uartLine').textContent = s.lastUartLine;
  } else {
    $('uartInfo').textContent = '';
    $('uartLine').textContent = '';
  }

  // ── Sensor values ──
  renderSensorValues(s.displayValues);
}

function renderSensorValues(values) {
  const grid = $('sensorGrid');
  if (!values || values.length === 0) {
    grid.innerHTML = '<div class="no-data">Conectá el Labdisc para ver los sensores</div>';
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