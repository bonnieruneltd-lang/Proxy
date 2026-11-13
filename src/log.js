'use strict';

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function color(code, text) {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

/**
 * Tiny dependency-free logger. Levels: silent|error|warn|info|debug.
 */
function createLogger(level = 'info') {
  let threshold = LEVELS[level] === undefined ? LEVELS.info : LEVELS[level];

  const write = (stream, label, hue, args) => {
    const stamp = new Date().toISOString().slice(11, 23);
    stream.write(`${color(90, stamp)} ${color(hue, label.padEnd(5))} ${args.join(' ')}\n`);
  };

  const api = {
    level,
    setLevel(next) {
      if (LEVELS[next] === undefined) throw new Error(`unknown log level: ${next}`);
      threshold = LEVELS[next];
      api.level = next;
    },
    error: (...args) => threshold >= LEVELS.error && write(process.stderr, 'error', 31, args),
    warn: (...args) => threshold >= LEVELS.warn && write(process.stderr, 'warn', 33, args),
    info: (...args) => threshold >= LEVELS.info && write(process.stdout, 'info', 36, args),
    debug: (...args) => threshold >= LEVELS.debug && write(process.stdout, 'debug', 90, args)
  };
  return api;
}

module.exports = { createLogger, LEVELS };
