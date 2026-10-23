const fs = require('fs');
const path = require('path');

const logDirectory = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDirectory, 'backend.log');
const maxLogBytes = 5 * 1024 * 1024;

function writeLog(level, message, details = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(details.code ? { code: details.code } : {}),
    ...(details.status ? { status: details.status } : {}),
    ...(details.stack && process.env.NODE_ENV !== 'production' ? { stack: details.stack } : {})
  };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    fs.mkdirSync(logDirectory, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size + Buffer.byteLength(line, 'utf8') > maxLogBytes) {
      const previousFile = `${logFile}.1`;
      if (fs.existsSync(previousFile)) fs.unlinkSync(previousFile);
      fs.renameSync(logFile, previousFile);
    }
    fs.appendFileSync(logFile, line, { encoding: 'utf8' });
  } catch {
    // Preserve service availability if local disk logging is unavailable.
  }
  if (process.env.NODE_ENV !== 'production') {
    const writer = level === 'error' ? console.error : console.info;
    writer(line.trim());
  }
}

module.exports = {
  info: (message, details) => writeLog('info', message, details),
  warn: (message, details) => writeLog('warn', message, details),
  error: (message, details) => writeLog('error', message, details)
};
