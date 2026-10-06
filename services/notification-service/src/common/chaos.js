// Failure injection for reliability drills (see README).
// Start mode comes from CHAOS_MODE. It can be changed at runtime with POST /chaos
// (only when CHAOS_TOKEN is set). /chaos is not routed through the ingress, so it is only
// reachable inside the cluster or with kubectl port-forward.
const MODES = ['none', 'slow', 'error', 'crash'];
const EXEMPT = new Set(['/health', '/ready', '/metrics', '/chaos']);

export function createChaos(logger) {
  const state = {
    mode: MODES.includes(process.env.CHAOS_MODE) ? process.env.CHAOS_MODE : 'none',
    delayMs: Number(process.env.CHAOS_DELAY_MS || 2000),
    errorRate: Number(process.env.CHAOS_ERROR_RATE || 0.5),
  };
  if (state.mode !== 'none') logger.warn({ chaos: state }, 'chaos mode enabled at startup');

  function middleware(req, res, next) {
    if (state.mode === 'none' || EXEMPT.has(req.path)) return next();
    if (state.mode === 'slow') return setTimeout(next, state.delayMs);
    if (state.mode === 'error') {
      if (Math.random() < state.errorRate) return res.status(500).json({ error: 'chaos: injected failure' });
      return next();
    }
    if (state.mode === 'crash') {
      logger.error('chaos: crash mode, exiting process');
      res.status(500).json({ error: 'chaos: crashing' });
      return setTimeout(() => process.exit(1), 50);
    }
    return next();
  }

  function handler(req, res) {
    const token = process.env.CHAOS_TOKEN;
    if (!token) return res.status(404).json({ error: 'chaos endpoint disabled (CHAOS_TOKEN not set)' });
    if (req.get('x-chaos-token') !== token) return res.status(403).json({ error: 'bad chaos token' });
    if (req.method === 'POST') {
      const { mode, delayMs, errorRate } = req.body || {};
      if (mode !== undefined) {
        if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of ${MODES.join(', ')}` });
        state.mode = mode;
      }
      if (delayMs !== undefined) state.delayMs = Number(delayMs);
      if (errorRate !== undefined) state.errorRate = Number(errorRate);
      logger.warn({ chaos: state }, 'chaos state changed');
    }
    return res.json(state);
  }

  return { middleware, handler, state };
}
