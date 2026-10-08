const express = require('express');
const authService = require('../services/authService');
const mailService = require('../services/mailService');
const { settings } = require('../lib/db');
const activity = require('../services/activityService');
const router = express.Router();

function render(res, view, vars = {}) {
  res.render(`auth/${view}`, {
    page: view,
    user: null,
    settings: settings.all(),
    ...vars,
  });
}

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  render(res, 'login');
});

router.post('/login', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const { username, password, code } = req.body;
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    const result = await authService.attemptLogin(String(username || '').trim(), String(password || ''), ip, userAgent);
    if (!result.ok) {
      return render(res, 'login', { error: result.error, username });
    }
    const { user } = result;
    if (result.tfaRequired) {
      if (!code) {
        return render(res, 'login', { tfa: true, tfaUser: user.username, error: null });
      }
      const check = authService.confirmTfa(user, code);
      if (!check.ok) return render(res, 'login', { tfa: true, tfaUser: user.username, error: check.error });
    }
    const { token } = await authService.finishLogin(user, ip, userAgent);
    res.cookie('token', token, { httpOnly: false, sameSite: 'lax', maxAge: 7 * 24 * 3600 * 1000 });
    res.redirect('/dashboard');
  } catch (err) {
    next(err);
  }
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  const allowed = settings.get('security.allow_register') !== '0';
  render(res, 'register', { allowed });
});

router.post('/register', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    if (settings.get('security.allow_register') === '0') {
      return render(res, 'register', { error: 'Registration is disabled by the administrator', allowed: false });
    }
    const { username, email, password, name, password2 } = req.body;
    if (password !== password2) return render(res, 'register', { error: 'Passwords do not match', username, email, name });
    const requireVerify = settings.get('security.require_verify') === '1';
    try {
      const user = await authService.createUser({
        username: String(username || '').trim(),
        email: String(email || '').trim().toLowerCase(),
        password: String(password || ''),
        name: String(name || '').trim() || username,
        role: 'user',
        verified: !requireVerify,
      });
      if (requireVerify) {
        const token = await authService.createVerifyToken(user);
        awaitable(mailService.sendVerifyEmail(user, token));
      }
      await activity.logActivity({ user_id: user.id, event: 'auth:register', ip: req.ip });
      return render(res, 'register', { success: 'Account created! You can now login.' });
    } catch (e) {
      return render(res, 'register', { error: e.message, username, email, name });
    }
  } catch (err) {
    next(err);
  }
});

function awaitable(p) { return Promise.resolve(p).catch(() => {}); }

router.get('/forgot', (req, res) => render(res, 'forgot'));
router.post('/forgot', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const target = await authService.findByUsername(String(req.body.email || '').trim().toLowerCase());
    if (target) {
      const token = await authService.createResetToken(target);
      awaitable(mailService.sendResetEmail(target, token));
    }
    return render(res, 'forgot', { success: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

router.get('/reset', (req, res) => render(res, 'reset', { token: req.query.token || '' }));
router.post('/reset', express.urlencoded({ extended: true }), async (req, res, next) => {
  try {
    const { token, password, password2 } = req.body;
    if (password !== password2) return render(res, 'reset', { token, error: 'Passwords do not match' });
    const result = await authService.resetPassword(token, password);
    if (!result.ok) return render(res, 'reset', { token, error: result.error });
    return render(res, 'reset', { token: '', success: 'Password reset! You can now login.' });
  } catch (err) {
    next(err);
  }
});

router.get('/verify', async (req, res, next) => {
  try {
    const result = await authService.verifyEmail(req.query.token || '');
    return render(res, 'verify', { ok: result.ok, error: result.error });
  } catch (err) {
    next(err);
  }
});

router.get('/logout', async (req, res) => {
  const user = req.user;
  if (user) await activity.logActivity({ user_id: user.id, event: 'auth:logout', ip: req.ip });
  res.clearCookie('token');
  res.clearCookie('vpanel_impersonate_admin');
  res.redirect('/login');
});

router.all(['/auth/impersonate/revert', '/admin/users/impersonate/revert'], async (req, res) => {
  try {
    const adminToken = req.cookies?.vpanel_impersonate_admin;
    if (!adminToken) {
      return res.redirect('/dashboard');
    }
    const adminPayload = authService.verifyToken(adminToken);
    if (!adminPayload || !adminPayload.sub) {
      res.clearCookie('vpanel_impersonate_admin');
      return res.redirect('/login');
    }
    const adminUser = await authService.findById(Number(adminPayload.sub));
    if (!adminUser || (adminUser.role !== 'admin' && !adminUser.root_admin)) {
      res.clearCookie('vpanel_impersonate_admin');
      return res.redirect('/login');
    }

    res.cookie('token', adminToken, { httpOnly: true, sameSite: 'lax', maxAge: 86400000 });
    res.clearCookie('vpanel_impersonate_admin');

    await activity.logActivity({
      user_id: adminUser.id,
      event: 'auth:impersonate_end',
      details: { admin: adminUser.username },
      ip: req.ip,
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, redirect: '/admin/users' });
    }
    return res.redirect('/admin/users');
  } catch (e) {
    return res.redirect('/login');
  }
});

module.exports = router;
