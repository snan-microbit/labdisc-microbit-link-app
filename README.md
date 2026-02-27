# 🔬 Labdisc Bridge

**Conectá un Labdisc GenSci con una micro:bit usando bloques de MakeCode.**

Labdisc Bridge es una PWA (Progressive Web App) que actúa como puente entre un [Labdisc](https://www.globisens.net/labdisc) y una [micro:bit](https://microbit.org/), permitiendo que estudiantes lean sensores del Labdisc desde programas creados en [MakeCode](https://makecode.microbit.org/).

## Arquitectura

```
┌──────────┐    BT Classic    ┌──────────┐    BLE     ┌──────────┐
│ Labdisc  │ ←──── SPP ─────→ │  Bridge  │ ←── BLE ──→│ micro:bit│
│ GenSci   │    9600 baud      │  (PWA)   │   UART     │          │
└──────────┘                   └──────────┘            └──────────┘
```

La PWA se conecta al Labdisc por **Bluetooth Classic** (Web Serial API) y a la micro:bit por **BLE** (Web Bluetooth API), traduciendo entre ambos protocolos en tiempo real.

## Requisitos

- **Navegador:** Chrome 89+ o Edge 89+ (requiere Web Serial + Web Bluetooth)
- **Labdisc:** Cualquier modelo GenSci con Bluetooth
- **micro:bit:** v2 con firmware que incluya la extensión Labdisc para MakeCode

## Uso

1. Abrí la app en Chrome: [https://tu-usuario.github.io/labdisc-bridge/](https://tu-usuario.github.io/labdisc-bridge/)
2. Conectá el Labdisc (botón 🔌)
3. Conectá la micro:bit (botón 🔌)
4. Los datos fluyen automáticamente

## Estructura del proyecto

```
labdisc-bridge/
├── index.html              ← Punto de entrada de la PWA
├── manifest.json           ← Manifest para instalación PWA
├── sw.js                   ← Service Worker (offline)
├── src/
│   ├── labdisc/
│   │   ├── protocol.js     ← Constantes del protocolo Labdisc
│   │   ├── sensors.js      ← Catálogo de sensores y fórmulas
│   │   ├── parser.js       ← Parser de paquetes (0x81, 0x82, 0x83, 0x84)
│   │   └── connection.js   ← Conexión Web Serial al Labdisc
│   ├── microbit/
│   │   └── ble-uart.js     ← Conexión Web Bluetooth UART a micro:bit
│   ├── bridge/
│   │   ├── bridge.js       ← Orquestador: Labdisc → conversión → micro:bit
│   │   └── formatter.js    ← Formatea datos para UART (CSV de enteros)
│   └── ui/
│       ├── app.js          ← Lógica de UI y estado global
│       └── logger.js       ← Log de paquetes para debug
├── assets/
│   ├── icon-192.png
│   └── icon-512.png
├── docs/
│   └── architecture.md     ← Documento de arquitectura
└── README.md
```

## Módulos

### `src/labdisc/` — Protocolo Labdisc
Implementa el protocolo propietario del Labdisc, reverse-engineered desde GlobiLab X. Incluye:
- Constantes de protocolo (headers, comandos, checksums)
- Catálogo completo de 30+ sensores con fórmulas de conversión
- Parser de paquetes con soporte para 0x81 (Online) y 0x84 (Experiment)
- Gestión de conexión Web Serial a 9600 baud

### `src/microbit/` — BLE UART
Implementa la conexión BLE con la micro:bit usando el servicio UART estándar (Nordic UART Service). Envía datos como texto ASCII separado por comas.

### `src/bridge/` — Orquestador
Coordina el flujo de datos: recibe paquetes del Labdisc, los decodifica, convierte los valores crudos a unidades físicas, y los reenvía a la micro:bit en formato CSV.

### `src/ui/` — Interfaz
Interfaz mínima con dos botones de conexión, indicadores de estado, selector de modo (1Hz/25Hz), y vista de debug con valores en tiempo real.

## Protocolo UART (Bridge → micro:bit)

Los datos se envían como texto ASCII, una línea por segundo:

```
263,587,1136,1013,0,0,723,0,0,0,0,0,0\n
```

Cada posición tiene un sensor fijo (orden estandarizado). Los valores son enteros multiplicados por ×10, ×100 o ×1000 según el sensor. `-9999` indica sensor sin dato.

## Modos de operación

| Modo | Paquete Labdisc | Tasa | Uso |
|------|----------------|------|-----|
| Normal | 0x81 (Online) | ~1 Hz | Temperatura, humedad, presión, pH |
| Rápido | 0x84 (Experiment) | 25 Hz | Péndulos, caída libre, reacciones |

## Desarrollo

```bash
# Clonar
git clone https://github.com/tu-usuario/labdisc-bridge.git
cd labdisc-bridge

# Servir localmente (requiere HTTPS para Web Serial/Bluetooth)
npx serve .
# o
python -m http.server 8080
```

> **Nota:** Web Serial y Web Bluetooth requieren contexto seguro (HTTPS o localhost).

## Basado en

- [Labdisc Protocol Spec v2](docs/architecture.md) — Protocolo reverse-engineered
- [Labdisc Client v0.5](https://github.com/tu-usuario/labdisc-client) — Cliente de referencia

## Licencia

MIT
