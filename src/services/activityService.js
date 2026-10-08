const { collections, getNextId } = require('../lib/db');
const pluginManager = require('../lib/pluginManager');

async function logActivity({ user_id = null, vm_id = null, event, details = null, ip = null, user_agent = null }) {
  try {
    const id = await getNextId('activity_logs');
    await collections.activity_logs.insertOne({
      id,
      user_id: user_id !== null ? Number(user_id) : null,
      vm_id: vm_id !== null ? Number(vm_id) : null,
      event,
      details,
      ip,
      user_agent,
      created_at: new Date().toISOString(),
    });

    // Dispatch to pluginManager event bus
    pluginManager.emitPlatformEvent(
      event,
      {
        ...(typeof details === 'object' && details !== null ? details : { info: details }),
        user_id,
        vm_id,
      },
      { user_id, vm_id, ip }
    ).catch(() => {});
  } catch (e) { /* noop */ }
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

async function logLogin({ user_id = null, ip, username, status, user_agent = null, location = null, is_vpn = false }) {
  try {
    const id = await getNextId('login_attempts');
    const uaInfo = parseUserAgent(user_agent);
    const loc = location || (ip === '127.0.0.1' || ip === '::1' || String(ip || '').startsWith('192.168.') || String(ip || '').startsWith('10.') ? 'Local Network' : 'Unknown');
    await collections.login_attempts.insertOne({
      id,
      user_id: user_id !== null ? Number(user_id) : null,
      ip,
      username,
      status,
      success: status === 'success',
      user_agent,
      device_type: uaInfo.device_type,
      platform: uaInfo.platform,
      browser: uaInfo.browser,
      location: loc,
      is_vpn: !!is_vpn,
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    // Dispatch to pluginManager event bus
    const eventName = status === 'success' ? 'auth:login_success' : 'auth:failed_login';
    pluginManager.emitPlatformEvent(
      eventName,
      { username, ip, status, device_type: uaInfo.device_type, browser: uaInfo.browser },
      { user_id, ip }
    ).catch(() => {});
  } catch (e) { /* noop */ }
}

async function listActivity({ user_id = null, vm_id = null, limit = 100, offset = 0 }) {
  const query = {};
  if (user_id !== null) query.user_id = Number(user_id);
  if (vm_id !== null) query.vm_id = Number(vm_id);

  const logs = await collections.activity_logs
    .find(query)
    .sort({ id: -1 })
    .skip(Number(offset) || 0)
    .limit(Number(limit) || 100)
    .toArray();

  if (!logs.length) return [];

  const userIds = [...new Set(logs.map((l) => l.user_id).filter((id) => id !== null))];
  const vmIds = [...new Set(logs.map((l) => l.vm_id).filter((id) => id !== null))];

  const [users, vms] = await Promise.all([
    userIds.length ? collections.users.find({ id: { $in: userIds } }).toArray() : [],
    vmIds.length ? collections.vms.find({ id: { $in: vmIds } }).toArray() : [],
  ]);

  const userMap = new Map(users.map((u) => [u.id, u.username]));
  const vmMap = new Map(vms.map((v) => [v.id, v.name]));

  return logs.map((l) => ({
    ...l,
    username: userMap.get(l.user_id) || null,
    vm_name: vmMap.get(l.vm_id) || null,
  }));
}

async function listLoginHistory({ user_id = null, limit = 100, offset = 0 }) {
  const query = {};
  if (user_id !== null) query.user_id = Number(user_id);

  return collections.login_attempts
    .find(query)
    .sort({ id: -1 })
    .skip(Number(offset) || 0)
    .limit(Number(limit) || 100)
    .toArray();
}

async function recentLogin(userId) {
  return collections.login_attempts
    .findOne({ user_id: Number(userId) }, { sort: { id: -1 } });
}

module.exports = { logActivity, logLogin, listActivity, listLoginHistory, recentLogin };
