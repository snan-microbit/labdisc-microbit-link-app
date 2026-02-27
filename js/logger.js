/**
 * logger.js — Packet log utility
 * 
 * Maintains a scrolling log of protocol events for debugging.
 * Renders to a DOM element with color-coded entries.
 */

export class Logger {
  /**
   * @param {HTMLElement} container - DOM element to render log lines into
   * @param {number} maxLines - Maximum log entries to keep
   */
  constructor(container, maxLines = 300) {
    this.container = container;
    this.maxLines = maxLines;
    this.count = 0;

    /** @type {HTMLElement|null} Optional counter element */
    this.counterEl = null;
  }

  /**
   * Add a log entry.
   * @param {'tx'|'rx'|'info'|'err'|'warn'} type
   * @param {string} message
   */
  log(type, message) {
    const ts = new Date().toISOString().substring(11, 23);
    const prefix = { tx: '→', rx: '←', info: 'ℹ', err: '✕', warn: '⚠' }[type] || '';

    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    line.innerHTML = `<span class="ts">${ts}</span> ${prefix} ${message}`;
    this.container.appendChild(line);
    this.container.scrollTop = this.container.scrollHeight;

    // Prune old entries
    while (this.container.children.length > this.maxLines) {
      this.container.removeChild(this.container.firstChild);
    }

    this.count++;
    if (this.counterEl) {
      this.counterEl.textContent = `${this.count}`;
    }
  }

  /** Clear all log entries */
  clear() {
    this.container.innerHTML = '';
    this.count = 0;
    if (this.counterEl) this.counterEl.textContent = '0';
  }
}
