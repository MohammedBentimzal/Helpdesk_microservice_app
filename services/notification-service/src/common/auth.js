import jwt from 'jsonwebtoken';

export function signToken(user, secret, expiresIn = '8h') {
  return jwt.sign({ sub: user.email, name: user.name, role: user.role, picture: user.picture || null }, secret, {
    algorithm: 'HS256',
    expiresIn,
  });
}

export function requireAuth(secret) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    try {
      const claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
      req.user = { email: claims.sub, name: claims.name, role: claims.role, picture: claims.picture };
      return next();
    } catch {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
  };
}

export const requireRole = (role) => (req, res, next) =>
  req.user?.role === role ? next() : res.status(403).json({ error: `${role} role required` });
