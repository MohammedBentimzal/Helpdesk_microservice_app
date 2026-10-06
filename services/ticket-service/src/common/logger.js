import pino from 'pino';

export function createLogger(serviceName) {
  return pino({
    level: process.env.LOG_LEVEL || 'info',
    base: { service: serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

// Logs one JSON line per request. Probe and metrics endpoints are logged at debug level only.
export function requestLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const quiet = ['/health', '/ready', '/metrics'].includes(req.path);
      logger[quiet ? 'debug' : 'info'](
        { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, durationMs: Math.round(ms * 10) / 10 },
        'request'
      );
    });
    next();
  };
}
