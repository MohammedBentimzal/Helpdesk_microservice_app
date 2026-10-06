export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    console.error(JSON.stringify({ level: 'fatal', msg: `Missing required environment variables: ${missing.join(', ')}` }));
    process.exit(1);
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retries an async function, used at startup while databases are still booting.
export async function retry(fn, { attempts = 30, delayMs = 2000, logger, label = 'operation' } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      logger?.warn({ attempt: i, err: err.message }, `${label} failed, retrying`);
      await sleep(delayMs);
    }
  }
}
