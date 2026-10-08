const authService = require('../services/authService');
const { settings } = require('../lib/db');

async function getUserFromReq(req) {
  const candidates = [];
  if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    const t = req.headers.authorization.slice(7).trim();
    if (t && t !== 'undefined' && t !== 'null' && t !== '[object Object]') candidates.push(t);
  }
  if (req.cookies && req.cookies.token) {
    const raw = String(req.cookies.token).trim();
    let t = raw;
    try { t = decodeURIComponent(raw); } catch (_) {}
    if (t && t !== 'undefined' && t !== 'null' && t !== '[object Object]') candidates.push(t);
  }
  if (req.query && req.query.token) {
    const raw = String(req.query.token).trim();
    let t = raw;
    try { t = decodeURIComponent(raw); } catch (_) {}
    if (t && t !== 'undefined' && t !== 'null' && t !== '[object Object]') candidates.push(t);
  }

  let user = null;
  for (const token of candidates) {
    try {
      const payload = authService.verifyToken(token);
      if (!payload || !payload.sub) continue;
      const found = await authService.findById(Number(payload.sub));
      if (found) {
        if (found.is_banned) continue;
        if (found.suspended) {
          if (found.suspended_until && new Date(found.suspended_until) <= new Date()) {
            await authService.updateUser(found.id, { suspended: false, suspended_until: null, suspension_reason: null }).catch(() => {});
            found.suspended = 0;
          } else {
            continue;
          }
        }
        user = found;
        break;
      }
    } catch (_) {}
  }

  if (user && req.cookies && req.cookies.vpanel_impersonate_admin) {
    try {
      const adminToken = String(req.cookies.vpanel_impersonate_admin).trim();
      const adminPayload = authService.verifyToken(adminToken);
      if (adminPayload && adminPayload.sub) {
        const adminUser = await authService.findById(Number(adminPayload.sub));
        if (adminUser && (adminUser.role === 'admin' || adminUser.root_admin)) {
          user.is_impersonating = true;
          user.impersonated_by = adminUser.username;
          user.impersonator_id = adminUser.id;
        }
      }
    } catch (_) {}
  }
  return user;
}

async function requireAuth(req, res, next) {
  try {
    const user = await getUserFromReq(req);
    if (!user) {
      if (req.xhr || req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      return res.redirect('/login');
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

async function optionalAuth(req, res, next) {
  try {
    req.user = await getUserFromReq(req);
    next();
  } catch (err) {
    next(err);
  }
}

async function requireAdmin(req, res, next) {
  try {
    const user = req.user || (await getUserFromReq(req));
    if (!user) {
      if (req.xhr || req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      return res.redirect('/login');
    }
    if (user.role !== 'admin' && !user.root_admin) {
      if (req.xhr || req.path.startsWith('/api') || req.headers.accept?.includes('application/json')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.status(403).render('error/403', { code: 403, title: 'Forbidden', message: 'You do not have permission to access this page.', settings: settings.all(), user });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

async function apiAuth(req, res, next) {
  try {
    const user = await getUserFromReq(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

async function apiAdmin(req, res, next) {
  try {
    const user = await getUserFromReq(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (user.role !== 'admin' && !user.root_admin) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, optionalAuth, requireAdmin, apiAuth, apiAdmin, getUserFromReq };
