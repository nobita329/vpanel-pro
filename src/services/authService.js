const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const { v4: uuidv4 } = require('uuid');
const config = require('../lib/config');
const { collections, getNextId, settings } = require('../lib/db');
const logger = require('../lib/logger');
const { logActivity, logLogin } = require('./activityService');

function getGravatar(email) {
  if (!email) return '';
  const hash = crypto.createHash('md5').update(String(email).trim().toLowerCase()).digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=100&d=mp`;
}

function parseUserAgent(ua = '') {
  ua = String(ua || '');
  let device_type = 'Desktop';
  if (/mobile/i.test(ua)) device_type = 'Mobile';
  else if (/tablet|ipad/i.test(ua)) device_type = 'Tablet';

  let platform = 'Unknown';
  if (/windows/i.test(ua)) platform = 'Windows';
  else if (/macintosh|mac os x/i.test(ua)) platform = 'macOS';
  else if (/android/i.test(ua)) platform = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) platform = 'iOS';
  else if (/cros/i.test(ua)) platform = 'ChromeOS';
  else if (/linux/i.test(ua)) platform = 'Linux';

  let browser = 'Unknown';
  if (/edg/i.test(ua)) browser = 'Edge';
  else if (/opr|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';

  return { device_type, platform, browser };
}

function publicUser(u) {
  if (!u) return null;
  const gravatar = getGravatar(u.email);
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    name: u.name,
    name_first: u.name_first || '',
    name_last: u.name_last || '',
    role: u.role,
    root_admin: !!u.root_admin,
    language: u.language || 'en',
    avatar: u.avatar || gravatar,
    gravatar,
    country: u.country || '',
    address: u.address || '',
    zip_code: u.zip_code || '',
    credit: typeof u.credit === 'number' ? u.credit : (parseFloat(u.credit) || 0),
    is_banned: !!u.is_banned,
    ban_reason: u.ban_reason || '',
    suspended: !!u.suspended,
    suspended_until: u.suspended_until || null,
    suspension_reason: u.suspension_reason || '',
    verified: !!u.verified,
    tfa_enabled: !!u.tfa_enabled,
    last_login_at: u.last_login_at,
    last_login_ip: u.last_login_ip,
    created_at: u.created_at,
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpires }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (_) {
    return null;
  }
}

async function findByUsername(username) {
  return collections.users.findOne({
    $or: [
      { username: String(username).trim() },
      { email: String(username).trim().toLowerCase() },
    ],
  });
}

async function findById(id) {
  return collections.users.findOne({ id: Number(id) });
}

async function createUser({
  username,
  email,
  password,
  name,
  name_first = '',
  name_last = '',
  role = 'user',
  root_admin = null,
  language = 'en',
  country = '',
  address = '',
  zip_code = '',
  credit = 0,
  verified = true,
}) {
  const usernameOk = /^[a-zA-Z0-9_]{3,32}$/.test(username);
  if (!usernameOk) throw new Error('Username must be 3-32 chars (letters, numbers, underscore)');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid email address');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters');

  const existing = await collections.users.findOne({
    $or: [{ username }, { email: email.toLowerCase() }],
  });
  if (existing) throw new Error('Username or email already exists');

  const hash = bcrypt.hashSync(password, 10);
  const now = new Date().toISOString();
  const id = await getNextId('users');
  const fn = String(name_first || '').trim();
  const ln = String(name_last || '').trim();
  const displayName = name || (fn || ln ? `${fn} ${ln}`.trim() : username);
  const isAdmin = role === 'admin' || root_admin === 1 || root_admin === true || root_admin === '1';

  const doc = {
    id,
    username,
    email: email.toLowerCase(),
    password: hash,
    name: displayName,
    name_first: fn,
    name_last: ln,
    role: isAdmin ? 'admin' : 'user',
    root_admin: isAdmin ? 1 : 0,
    language: language || 'en',
    avatar: null,
    country: String(country || '').trim(),
    address: String(address || '').trim(),
    zip_code: String(zip_code || '').trim(),
    credit: parseFloat(credit) || 0,
    is_banned: 0,
    ban_reason: '',
    suspended: 0,
    suspended_until: null,
    suspension_reason: '',
    verified: verified ? 1 : 0,
    verify_token: null,
    tfa_enabled: 0,
    tfa_secret: null,
    last_login_at: null,
    last_login_ip: null,
    created_at: now,
    updated_at: now,
  };
  await collections.users.insertOne(doc);
  return findById(id);
}

async function updateUser(id, data) {
  const user = await findById(id);
  if (!user) throw new Error('User not found');
  const allowed = [
    'name', 'name_first', 'name_last', 'email', 'username',
    'language', 'avatar', 'role', 'root_admin',
    'country', 'address', 'zip_code', 'credit',
    'is_banned', 'ban_reason', 'suspended', 'suspended_until', 'suspension_reason'
  ];
  const $set = {};
  for (const f of allowed) {
    if (data[f] !== undefined) $set[f] = data[f];
  }
  if (data.credit !== undefined) {
    $set.credit = Math.max(0, parseFloat(data.credit) || 0);
  }
  if (data.password) {
    if (data.password.length < 6) throw new Error('Password too short (minimum 6 characters)');
    $set.password = bcrypt.hashSync(data.password, 10);
  }
  if (data.suspended !== undefined) $set.suspended = data.suspended ? 1 : 0;
  if (data.is_banned !== undefined) {
    $set.is_banned = data.is_banned ? 1 : 0;
    if (data.is_banned) {
      $set.suspended = 1;
    }
  }
  if (data.suspended_until !== undefined) {
    $set.suspended_until = data.suspended_until ? new Date(data.suspended_until).toISOString() : null;
    if ($set.suspended_until && new Date($set.suspended_until) > new Date()) {
      $set.suspended = 1;
    }
  }
  if (data.verified !== undefined) $set.verified = data.verified ? 1 : 0;
  if (data.root_admin !== undefined) {
    $set.root_admin = (data.root_admin === 1 || data.root_admin === true || data.root_admin === '1') ? 1 : 0;
    if ($set.root_admin) $set.role = 'admin';
  }
  if (data.role !== undefined) {
    if (data.role === 'admin') $set.root_admin = 1;
    else if (data.role === 'user' && data.root_admin === undefined) $set.root_admin = 0;
  }
  if (data.tfa_disabled) {
    $set.tfa_enabled = 0;
    $set.tfa_secret = null;
  }
  if ($set.name_first !== undefined || $set.name_last !== undefined) {
    const fn = $set.name_first !== undefined ? $set.name_first : (user.name_first || '');
    const ln = $set.name_last !== undefined ? $set.name_last : (user.name_last || '');
    if (!$set.name && (fn || ln)) {
      $set.name = `${fn} ${ln}`.trim();
    }
  }
  if (Object.keys($set).length) {
    $set.updated_at = new Date().toISOString();
    if ($set.username || $set.email) {
      const conflict = await collections.users.findOne({
        id: { $ne: Number(id) },
        $or: [
          $set.username ? { username: $set.username } : null,
          $set.email ? { email: $set.email.toLowerCase() } : null,
        ].filter(Boolean),
      });
      if (conflict) throw new Error('Username or email already in use');
    }
    await collections.users.updateOne({ id: Number(id) }, { $set });
  }
  return findById(id);
}

async function deleteUser(id) {
  await collections.users.deleteOne({ id: Number(id) });
  if (collections.user_sessions) {
    await collections.user_sessions.deleteMany({ user_id: Number(id) }).catch(() => {});
  }
  return true;
}

async function countAdmins() {
  return collections.users.countDocuments({
    $or: [{ role: 'admin' }, { root_admin: 1 }],
  });
}

async function attemptLogin(username, password, ip, userAgent = '') {
  const user = await findByUsername(username);
  if (!user) {
    await logLogin({ ip, username, status: 'failed_user', user_agent: userAgent });
    return { ok: false, error: 'Invalid username or password' };
  }
  if (!bcrypt.compareSync(password, user.password)) {
    await logLogin({ user_id: user.id, ip, username, status: 'failed_password', user_agent: userAgent });
    await logActivity({ user_id: user.id, event: 'auth:login_failed', ip, user_agent: userAgent });
    return { ok: false, error: 'Invalid username or password' };
  }
  if (user.is_banned) {
    const reasonMsg = user.ban_reason ? `: ${user.ban_reason}` : '';
    await logLogin({ user_id: user.id, ip, username, status: 'banned', user_agent: userAgent });
    return { ok: false, error: `This account is banned${reasonMsg}` };
  }
  if (user.suspended) {
    if (user.suspended_until && new Date(user.suspended_until) <= new Date()) {
      // Auto-unsuspend expired suspension
      await collections.users.updateOne({ id: user.id }, { $set: { suspended: 0, suspended_until: null, suspension_reason: null } });
      user.suspended = 0;
    } else {
      const untilMsg = user.suspended_until ? ` until ${new Date(user.suspended_until).toLocaleString()}` : '';
      const reasonMsg = user.suspension_reason ? ` (Reason: ${user.suspension_reason})` : '';
      await logLogin({ user_id: user.id, ip, username, status: 'suspended', user_agent: userAgent });
      return { ok: false, error: `This account is suspended${untilMsg}${reasonMsg}` };
    }
  }
  return { ok: true, user, tfaRequired: !!user.tfa_enabled };
}

async function finishLogin(user, ip, userAgent = '') {
  const now = new Date().toISOString();
  await collections.users.updateOne({ id: user.id }, { $set: { last_login_at: now, last_login_ip: ip } });
  await logLogin({ user_id: user.id, ip, username: user.username, status: 'success', user_agent: userAgent });
  await logActivity({ user_id: user.id, event: 'auth:login', ip, user_agent: userAgent });
  const token = signToken(user);

  // Record active session
  const sessionId = uuidv4();
  const uaInfo = parseUserAgent(userAgent);
  if (collections.user_sessions) {
    try {
      await collections.user_sessions.insertOne({
        session_id: sessionId,
        user_id: Number(user.id),
        token,
        ip_address: ip,
        user_agent: userAgent,
        device_type: uaInfo.device_type,
        platform: uaInfo.platform,
        browser: uaInfo.browser,
        location: ip === '127.0.0.1' || ip === '::1' || String(ip || '').startsWith('192.168.') || String(ip || '').startsWith('10.') ? 'Local Network' : 'Unknown',
        is_vpn: false,
        last_active_at: now,
        created_at: now,
      });
    } catch (_) {}
  }

  return { token, user: publicUser({ ...user, last_login_at: now, last_login_ip: ip }), session_id: sessionId };
}

async function listUserSessions(userId) {
  if (!collections.user_sessions) return [];
  return collections.user_sessions
    .find({ user_id: Number(userId) })
    .sort({ last_active_at: -1 })
    .toArray();
}

async function revokeSession(userId, sessionId) {
  if (!collections.user_sessions) return false;
  const res = await collections.user_sessions.deleteOne({
    user_id: Number(userId),
    session_id: String(sessionId)
  });
  return res.deletedCount > 0;
}

async function revokeAllSessions(userId) {
  if (!collections.user_sessions) return false;
  const res = await collections.user_sessions.deleteMany({
    user_id: Number(userId)
  });
  return res.deletedCount > 0;
}

function genVerifyToken() {
  return uuidv4().replace(/-/g, '');
}

async function createVerifyToken(user) {
  const token = genVerifyToken();
  await collections.users.updateOne({ id: user.id }, { $set: { verify_token: token } });
  return token;
}

async function verifyEmail(token) {
  const user = await collections.users.findOne({ verify_token: token });
  if (!user) return { ok: false, error: 'Invalid or expired verification token' };
  await collections.users.updateOne({ id: user.id }, { $set: { verified: 1, verify_token: null } });
  await logActivity({ user_id: user.id, event: 'auth:email_verified' });
  return { ok: true };
}

async function createResetToken(user) {
  const token = genVerifyToken();
  const id = await getNextId('reset_tokens');
  await collections.reset_tokens.insertOne({
    id,
    user_id: user.id,
    token,
    expires_at: new Date(Date.now() + 3600000).toISOString(),
    used: 0,
    created_at: new Date().toISOString(),
  });
  return token;
}

async function resetPassword(token, newPassword) {
  if (!newPassword || newPassword.length < 6) return { ok: false, error: 'Password must be at least 6 characters' };
  const row = await collections.reset_tokens.findOne({ token, used: 0 });
  if (!row) return { ok: false, error: 'Invalid or expired token' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'Token expired' };
  const hash = bcrypt.hashSync(newPassword, 10);
  await collections.users.updateOne({ id: row.user_id }, { $set: { password: hash } });
  await collections.reset_tokens.updateOne({ id: row.id }, { $set: { used: 1 } });
  await logActivity({ user_id: row.user_id, event: 'auth:password_reset' });
  return { ok: true };
}

async function setupTfa(user) {
  const secret = speakeasy.generateSecret({ length: 20, name: `${settings.get('panel.name') || 'vpanel'} (${user.username})` });
  await collections.users.updateOne({ id: user.id }, { $set: { tfa_secret: secret.base32 } });
  return { secret: secret.base32, otpauth_url: secret.otpauth_url };
}

function confirmTfa(user, code) {
  if (!user.tfa_secret) return { ok: false, error: '2FA is not configured' };
  const valid = speakeasy.totp.verify({
    secret: user.tfa_secret,
    encoding: 'base32',
    token: String(code).replace(/\s/g, ''),
    window: 1,
  });
  if (!valid) return { ok: false, error: 'Invalid 2FA code' };
  return { ok: true };
}

async function enableTfa(user, code) {
  const check = confirmTfa(user, code);
  if (!check.ok) return check;
  await collections.users.updateOne({ id: user.id }, { $set: { tfa_enabled: 1 } });
  await logActivity({ user_id: user.id, event: 'auth:tfa_enabled' });
  return { ok: true };
}

async function disableTfa(user, code) {
  const check = confirmTfa(user, code);
  if (!check.ok) return check;
  await collections.users.updateOne({ id: user.id }, { $set: { tfa_enabled: 0, tfa_secret: null } });
  await logActivity({ user_id: user.id, event: 'auth:tfa_disabled' });
  return { ok: true };
}

module.exports = {
  publicUser, signToken, generateToken: signToken, verifyToken, findByUsername, findById, createUser, updateUser, deleteUser,
  countAdmins, attemptLogin, finishLogin, createVerifyToken, verifyEmail, createResetToken,
  resetPassword, setupTfa, confirmTfa, enableTfa, disableTfa,
  getGravatar, listUserSessions, revokeSession, revokeAllSessions,
};
