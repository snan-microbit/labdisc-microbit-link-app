/**
 * poll-worker.js — Web Worker para timer de polling
 * 
 * Los browsers throttlean setInterval a ~1Hz cuando la pestaña está
 * en background. Este Worker corre en un hilo separado que no se
 * throttlea, manteniendo la frecuencia real de polling.
 * 
 * Protocolo de mensajes:
 *   Main → Worker: { cmd: 'start', intervalMs: 100 }
 *   Main → Worker: { cmd: 'stop' }
 *   Main → Worker: { cmd: 'setInterval', intervalMs: 50 }
 *   Worker → Main: 'tick'
 */

// Creamos el Worker inline como un Blob URL para no necesitar un archivo separado
const WORKER_CODE = `
let timer = null;

self.onmessage = function(e) {
  const msg = e.data;
  
  if (msg.cmd === 'start') {
    if (timer) clearInterval(timer);
    timer = setInterval(function() {
      self.postMessage('tick');
    }, msg.intervalMs);
    // Primer tick inmediato
    self.postMessage('tick');
  }
  
  if (msg.cmd === 'stop') {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  
  if (msg.cmd === 'setInterval') {
    if (timer) {
      clearInterval(timer);
      timer = setInterval(function() {
        self.postMessage('tick');
      }, msg.intervalMs);
    }
  }
};
`;

/**
 * Create a polling timer that is NOT throttled in background tabs.
 * Falls back to regular setInterval if Workers are not available.
 */
export function createPollTimer() {
  let worker = null;
  let fallbackTimer = null;
  let onTick = null;

  // Try to create a Web Worker from inline code
  try {
    const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url); // URL can be revoked after worker is created

    worker.onmessage = function() {
      if (onTick) onTick();
    };
  } catch (e) {
    // Workers not available (e.g., some mobile browsers)
    // Fall back to regular setInterval
    worker = null;
  }

  return {
    /**
     * Start the timer.
     * @param {number} intervalMs - Interval in milliseconds
     * @param {function} callback - Called on each tick
     */
    start(intervalMs, callback) {
      onTick = callback;
      if (worker) {
        worker.postMessage({ cmd: 'start', intervalMs });
      } else {
        // Fallback
        if (fallbackTimer) clearInterval(fallbackTimer);
        fallbackTimer = setInterval(callback, intervalMs);
        callback(); // First tick immediate
      }
    },

    /**
     * Stop the timer.
     */
    stop() {
      if (worker) {
        worker.postMessage({ cmd: 'stop' });
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      onTick = null;
    },

    /**
     * Change interval without stopping.
     * @param {number} intervalMs - New interval in milliseconds
     */
    setInterval(intervalMs) {
      if (worker) {
        worker.postMessage({ cmd: 'setInterval', intervalMs });
      } else if (fallbackTimer && onTick) {
        clearInterval(fallbackTimer);
        fallbackTimer = setInterval(onTick, intervalMs);
      }
    },

    /**
     * Clean up the worker.
     */
    destroy() {
      this.stop();
      if (worker) {
        worker.terminate();
        worker = null;
      }
    }
  };
}