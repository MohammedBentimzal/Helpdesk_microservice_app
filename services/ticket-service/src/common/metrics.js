import client from 'prom-client';

// Creates an isolated registry with default process metrics plus HTTP RED metrics.
// Business metrics are added by each service using the returned registry.
export function createMetrics() {
  const register = new client.Registry();
  client.collectDefaultMetrics({ register });

  const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [register],
  });
  const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  const skip = new Set(['/health', '/ready', '/metrics']);
  function middleware(req, res, next) {
    if (skip.has(req.path)) return next();
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? `${req.baseUrl || ''}${req.route.path}` : 'unmatched';
      const labels = { method: req.method, route, status: res.statusCode };
      httpRequests.inc(labels);
      end(labels);
    });
    next();
  }

  return { client, register, middleware };
}
