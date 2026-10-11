const sandboxConfig = require('./sandboxConfig');

/**
 * Converts memory string (e.g. '256m', '512m', '1g') or number to bytes.
 * Returns null if input is invalid, NaN, or non-positive.
 *
 * @param {string|number|null|undefined} mem
 * @returns {number|null} Memory in bytes, or null if invalid
 */
function parseMemoryToBytes(mem) {
  if (mem === undefined || mem === null) {
    return sandboxConfig.MAX_MEMORY_BYTES;
  }
  if (typeof mem === 'number') {
    if (isNaN(mem) || mem <= 0 || !isFinite(mem)) {
      return null;
    }
    return Math.round(mem);
  }
  if (typeof mem !== 'string') {
    return null;
  }
  const match = mem.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)(?:b|B)?$/i);
  if (!match) {
    return null;
  }
  const val = parseFloat(match[1]);
  if (isNaN(val) || val <= 0 || !isFinite(val)) {
    return null;
  }
  const unit = match[2].toLowerCase();
  if (unit === 'g') return Math.round(val * 1024 * 1024 * 1024);
  if (unit === 'm') return Math.round(val * 1024 * 1024);
  if (unit === 'k') return Math.round(val * 1024);
  return Math.round(val);
}

/**
 * Converts CPU quota string or number to NanoCPUs (1 CPU = 1e9 NanoCPUs).
 *
 * @param {string|number|null|undefined} cpu
 * @returns {number} NanoCPUs (500000000 = 0.5 CPU)
 */
function parseCpuToNanoCPUs(cpu) {
  if (typeof cpu === 'number') {
    return Math.round(cpu * 1e9);
  }
  if (!cpu || typeof cpu !== 'string') {
    return 500000000; // 0.5 CPU
  }
  const parsed = parseFloat(cpu);
  return isNaN(parsed) ? 500000000 : Math.round(parsed * 1e9);
}

module.exports = {
  parseMemoryToBytes,
  parseCpuToNanoCPUs,
};
