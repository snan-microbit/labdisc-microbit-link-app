/**
 * poll-worker.js — Web Worker para timer de polling
 * 
 * Los browsers throttlean setInterval a ~1Hz cuando la pestaña está
 * en background. Este Worker corre en un hilo separado que no se
 * throttlea, manteniendo la frecuencia real de polling.
 */

var WORKER_CODE = [
  "var timer = null;",
  "self.onmessage = function(e) {",
  "  var msg = e.data;",
  "  if (msg.cmd === 'start') {",
  "    if (timer) clearInterval(timer);",
  "    timer = setInterval(function() { self.postMessage('tick'); }, msg.intervalMs);",
  "    self.postMessage('tick');",
  "  }",
  "  if (msg.cmd === 'stop') {",
  "    if (timer) { clearInterval(timer); timer = null; }",
  "  }",
  "  if (msg.cmd === 'setInterval') {",
  "    if (timer) {",
  "      clearInterval(timer);",
  "      timer = setInterval(function() { self.postMessage('tick'); }, msg.intervalMs);",
  "    }",
  "  }",
  "};"
].join("\n");

/**
 * Create a polling timer that is NOT throttled in background tabs.
 * Falls back to regular setInterval if Workers are not available.
 */
export function createPollTimer() {
  var worker = null;
  var fallbackTimer = null;
  var onTick = null;

  try {
    var blob = new Blob([WORKER_CODE], { type: "application/javascript" });
    var url = URL.createObjectURL(blob);
    worker = new Worker(url);
    URL.revokeObjectURL(url);

    worker.onmessage = function() {
      if (onTick) onTick();
    };
  } catch (e) {
    worker = null;
  }

  return {
    start: function(intervalMs, callback) {
      onTick = callback;
      if (worker) {
        worker.postMessage({ cmd: "start", intervalMs: intervalMs });
      } else {
        if (fallbackTimer) clearInterval(fallbackTimer);
        fallbackTimer = setInterval(callback, intervalMs);
        callback();
      }
    },

    stop: function() {
      if (worker) {
        worker.postMessage({ cmd: "stop" });
      }
      if (fallbackTimer) {
        clearInterval(fallbackTimer);
        fallbackTimer = null;
      }
      onTick = null;
    },

    setInterval: function(intervalMs) {
      if (worker) {
        worker.postMessage({ cmd: "setInterval", intervalMs: intervalMs });
      } else if (fallbackTimer && onTick) {
        clearInterval(fallbackTimer);
        fallbackTimer = setInterval(onTick, intervalMs);
      }
    },

    destroy: function() {
      this.stop();
      if (worker) {
        worker.terminate();
        worker = null;
      }
    }
  };
}