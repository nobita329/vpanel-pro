const express = require('express');
const authService = require('../services/authService');
const vmService = require('../services/vmService');
const bootLogService = require('../services/bootLogService');
const backupService = require('../services/backupService');
const scheduleService = require('../services/scheduleService');
const agentService = require('../services/agentService');
const activity = require('../services/activityService');
const { collections, getNextId, settings } = require('../lib/db');
const { apiAuth, apiAdmin } = require('../middleware/auth');
const { uploadAvatar } = require('../middleware/upload');
const router = express.Router();

const json = express.json({ limit: '50mb' });

// ---------- Public auth ----------
router.post('/auth/login', json, async (req, res, next) => {
  try {
    const { username, password, code } = req.body;
    const ip = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'] || '';
    const result = await authService.attemptLogin(String(username || '').trim(), String(password || ''), ip, userAgent);
    if (!result.ok) return res.status(401).json({ error: result.error });
    if (result.tfaRequired) {
      if (!code) return res.json({ tfa_required: true, user: authService.publicUser(result.user) });
      const check = authService.confirmTfa(result.user, code);
      if (!check.ok) return res.status(401).json({ error: check.error });
    }
    const { token, user } = await authService.finishLogin(result.user, ip, userAgent);
    return res.json({ token, user });
  } catch (err) {
    next(err);
  }
});

router.post('/auth/register', json, async (req, res) => {
  if (settings.get('security.allow_register') === '0') return res.status(403).json({ error: 'Registration disabled' });
  try {
    const user = await authService.createUser({
      username: String(req.body.username || '').trim(),
      email: String(req.body.email || '').trim().toLowerCase(),
      password: String(req.body.password || ''),
      name: String(req.body.name || '').trim() || req.body.username,
      role: 'user',
      verified: settings.get('security.require_verify') !== '1',
    });
    return res.json({ ok: true, user: authService.publicUser(user) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/settings/public', (req, res) => {
  const s = settings.all();
  return res.json({
    name: s['panel.name'],
    allow_register: s['security.allow_register'],
    require_verify: s['security.require_verify'],
    version: '1.0.0',
  });
});

// ---------- Wallpapers Public API ----------
const wallpaperService = require('../services/wallpaperService');

router.get('/wallpapers', async (req, res) => {
  try {
    const data = await wallpaperService.getWallpapers({
      category: req.query.category,
      page: req.query.page,
      query: req.query.q || req.query.query,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Authenticated ----------
router.use(apiAuth);

router.get('/auth/me', (req, res) => res.json({ user: authService.publicUser(req.user) }));

router.get('/user/activity', async (req, res, next) => {
  try {
    const logs = await activity.listActivity({ user_id: req.user.id, limit: parseInt(req.query.limit || '100', 10) });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

router.get('/user/login-history', async (req, res, next) => {
  try {
    res.json({ history: await activity.listLoginHistory({ user_id: req.user.id, limit: 100 }) });
  } catch (err) {
    next(err);
  }
});

router.post('/user/profile', json, async (req, res) => {
  try {
    const data = {};
    if (req.body.name) data.name = req.body.name;
    if (req.body.email) data.email = req.body.email;
    if (req.body.language) data.language = req.body.language;
    const u = await authService.updateUser(req.user.id, data);
    return res.json({ ok: true, user: authService.publicUser(u) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/user/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const url = `/uploads/avatar/${req.file.filename}`;
  await authService.updateUser(req.user.id, { avatar: url });
  res.json({ ok: true, avatar: url });
});

router.post('/user/password', json, async (req, res) => {
  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(req.body.current, req.user.password)) return res.status(400).json({ error: 'Current password incorrect' });
  if (!req.body.password || req.body.password.length < 6) return res.status(400).json({ error: 'Password too short' });
  await authService.updateUser(req.user.id, { password: req.body.password });
  res.json({ ok: true });
});

// ---------- VMs ----------
async function loadVm(req, res, next) {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm || !(await vmService.canAccess(req.user, vm))) return res.status(404).json({ error: 'Server not found' });
    const row = await collections.vms.findOne({ id: Number(vm.id) }, { projection: { agent_token: 1 } });
    if (row && row.agent_token) {
      Object.defineProperty(vm, 'agent_token', { value: row.agent_token, enumerable: false, configurable: true });
    }
    req.vm = vm;
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/vms', async (req, res, next) => {
  try {
    if (req.user.role === 'admin' || req.user.root_admin) {
      const allDocs = await collections.vms.find().sort({ id: -1 }).toArray();
      const ownerIds = [...new Set(allDocs.map(v => Number(v.owner_id)))];
      const owners = ownerIds.length ? await collections.users.find({ id: { $in: ownerIds } }).toArray() : [];
      const ownerMap = new Map(owners.map(o => [o.id, o]));
      const all = allDocs.map(v => {
        const o = ownerMap.get(v.owner_id);
        const s = vmService.serializeVm(v);
        s.owner_username = o?.username || '';
        s.owner_email = o?.email || '';
        return s;
      });
      return res.json({ vms: all });
    }
    const mineDocs = await collections.vms.find({ owner_id: Number(req.user.id) }).sort({ id: -1 }).toArray();
    const subDocs = await collections.subusers.find({ user_id: Number(req.user.id) }).toArray();
    const vmIds = subDocs.map(s => Number(s.vm_id));
    const sharedDocs = vmIds.length ? await collections.vms.find({ id: { $in: vmIds } }).toArray() : [];
    res.json({ vms: [...mineDocs.map(vmService.serializeVm), ...sharedDocs.map(vmService.serializeVm)] });
  } catch (err) {
    next(err);
  }
});

router.post('/vms', json, async (req, res) => {
  try {
    const vm = await vmService.create({ user: req.user, data: req.body });
    return res.json({ ok: true, vm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/vms/:id', loadVm, (req, res) => res.json({ vm: req.vm }));
router.post('/vms/:id/start', loadVm, async (req, res) => {
  try { await vmService.start(req.vm, { user: req.user }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/stop', loadVm, async (req, res) => {
  try {
    await vmService.stop(req.vm, { user: req.user, force: !!req.body.force });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.post('/vms/:id/restart', loadVm, async (req, res) => {
  try { await vmService.restart(req.vm, req.user); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get(['/vms/:id/status', '/vms/:id/stats'], loadVm, (req, res) => {
  const stats = vmService.liveStats(req.vm);
  res.json({ ok: true, id: req.vm.id, status: stats.status, uptime: stats.uptime, mem: stats.memory.used_bytes, ...stats });
});
router.get('/vms/:id/bootlog', loadVm, (req, res) => {
  res.json({ ok: true, log: vmService.getBootLog(req.vm) });
});
router.get('/vms/:id/bootlog/stream', loadVm, (req, res) => {
  bootLogService.handleSseStream(req, res, req.vm);
});
router.post('/vms/:id/bootlog/clear', loadVm, (req, res) => {
  bootLogService.clearBootLogs(req.vm);
  res.json({ ok: true });
});
router.delete('/vms/:id', loadVm, async (req, res) => {
  try {
    if (req.vm.owner_id !== req.user.id && req.user.role !== 'admin' && !req.user.root_admin) return res.status(403).json({ error: 'Forbidden' });
    await vmService.remove(req.vm, req.user);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/vms/:id', loadVm, json, async (req, res) => {
  try { res.json({ ok: true, vm: await vmService.update(req.vm, req.body, req.user) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/resize', loadVm, json, async (req, res) => {
  try { res.json({ ok: true, vm: await vmService.resizeDisk(req.vm, req.body.disk_size, req.user) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Files (via VM Agent API, SSH fallback) ----------
router.get('/vms/:id/files', loadVm, async (req, res) => {
  try {
    const files = await agentService.listDir(req.vm, req.query.path || '/');
    res.json({ ok: true, files, transport: req.vm.agent_port ? 'agent' : 'ssh' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/vms/:id/files/read', loadVm, async (req, res) => {
  try {
    const content = await agentService.readFile(req.vm, req.query.path);
    res.json({ ok: true, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/write', loadVm, json, async (req, res) => {
  try {
    await agentService.writeFile(req.vm, req.body.path, req.body.content);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/mkdir', loadVm, json, async (req, res) => {
  try { await agentService.mkdir(req.vm, req.body.path); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/delete', loadVm, json, async (req, res) => {
  try { await agentService.rm(req.vm, req.body.path, { recursive: !!req.body.recursive }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/rename', loadVm, json, async (req, res) => {
  try { await agentService.rename(req.vm, req.body.from, req.body.to); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/chmod', loadVm, json, async (req, res) => {
  try { await agentService.chmod(req.vm, req.body.path, req.body.mode); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/vms/:id/files/upload', loadVm, express.raw({ limit: '200mb', type: '*/*' }), async (req, res) => {
  const targetPath = String(req.headers['x-file-path'] || '/');
  try {
    await agentService.upload(req.vm, targetPath, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/vms/:id/files/download', loadVm, async (req, res) => {
  try {
    const data = await agentService.download(req.vm, req.query.path);
    const name = req.query.path.split('/').pop() || 'file';
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Backups / Schedules / Subusers ----------
router.get('/vms/:id/backups', loadVm, async (req, res, next) => {
  try {
    res.json({ backups: await backupService.listForVm(req.vm.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/vms/:id/backups', loadVm, json, async (req, res) => {
  try {
    const backup = await backupService.createBackup(req.vm, { user: req.user, name: req.body.name });
    res.json({ ok: true, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/vms/:id/backups/:bid/restore', loadVm, async (req, res) => {
  try {
    const b = await collections.backups.findOne({ id: Number(req.params.bid), vm_id: Number(req.vm.id) });
    if (!b) return res.status(404).json({ error: 'Backup not found' });
    await backupService.restoreBackup(b, { user: req.user });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/vms/:id/backups/:bid', loadVm, async (req, res) => {
  try {
    const b = await collections.backups.findOne({ id: Number(req.params.bid), vm_id: Number(req.vm.id) });
    if (!b) return res.status(404).json({ error: 'Backup not found' });
    await backupService.deleteBackup(b, { user: req.user });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/vms/:id/schedules', loadVm, async (req, res, next) => {
  try {
    const schedules = await collections.schedules.find({ vm_id: Number(req.vm.id) }).toArray();
    res.json({ schedules });
  } catch (err) {
    next(err);
  }
});

router.post('/vms/:id/schedules', loadVm, json, async (req, res) => {
  try {
    const schedule = await scheduleService.add({ ...req.body, vm_id: req.vm.id }, req.user);
    res.json({ ok: true, schedule });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/vms/:id/schedules/:sid', loadVm, async (req, res) => {
  try {
    await scheduleService.remove(req.params.sid, req.user);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/vms/:id/subusers', loadVm, async (req, res, next) => {
  try {
    const subsRaw = await collections.subusers.find({ vm_id: Number(req.vm.id) }).toArray();
    const userIds = subsRaw.map(s => Number(s.user_id));
    const users = userIds.length ? await collections.users.find({ id: { $in: userIds } }).toArray() : [];
    const userMap = new Map(users.map(u => [u.id, u]));
    const subusers = subsRaw.map(s => ({
      ...s,
      username: userMap.get(s.user_id)?.username || '',
      email: userMap.get(s.user_id)?.email || '',
    }));
    res.json({ subusers });
  } catch (err) {
    next(err);
  }
});

router.post('/vms/:id/subusers', loadVm, json, async (req, res) => {
  try {
    const exists = await collections.subusers.findOne({ vm_id: Number(req.vm.id), user_id: Number(req.body.user_id) });
    if (exists) return res.status(400).json({ error: 'Already exists' });
    const nextId = await getNextId('subusers');
    await collections.subusers.insertOne({
      id: nextId,
      vm_id: Number(req.vm.id),
      user_id: Number(req.body.user_id),
      permissions: JSON.stringify(req.body.permissions || ['*']),
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true, id: nextId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/vms/:id/subusers/:sid', loadVm, async (req, res) => {
  try {
    await collections.subusers.deleteOne({ id: Number(req.params.sid), vm_id: Number(req.vm.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/vms/:id/activity', loadVm, async (req, res, next) => {
  try {
    res.json({ logs: await activity.listActivity({ vm_id: req.vm.id, limit: 200 }) });
  } catch (err) {
    next(err);
  }
});

// ---------- Admin API ----------
router.get('/admin/vms', apiAdmin, async (req, res, next) => {
  try {
    res.json({ vms: (await vmService.dbVms()).map(vmService.serializeVm) });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/users', apiAdmin, async (req, res, next) => {
  try {
    const users = await collections.users.find().sort({ id: -1 }).toArray();
    res.json({ users: users.map(authService.publicUser) });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/users', apiAdmin, json, async (req, res) => {
  try {
    const user = await authService.createUser(req.body);
    res.json({ ok: true, user: authService.publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/admin/users/:id', apiAdmin, json, async (req, res) => {
  try {
    const user = await authService.updateUser(req.params.id, req.body);
    res.json({ ok: true, user: authService.publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/users/:id', apiAdmin, async (req, res) => {
  try {
    await authService.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/activity', apiAdmin, async (req, res, next) => {
  try {
    res.json({ logs: await activity.listActivity({ limit: 500 }) });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/settings', apiAdmin, (req, res) => res.json({ settings: settings.all() }));

router.put('/admin/settings', apiAdmin, json, (req, res) => {
  for (const [k, v] of Object.entries(req.body || {})) settings.set(k, v);
  res.json({ ok: true, settings: settings.all() });
});

router.get('/admin/stats', apiAdmin, async (req, res, next) => {
  try {
    const userCount = await collections.users.countDocuments();
    const vms = await vmService.dbVms();
    const backupCount = await collections.backups.countDocuments();
    res.json({
      users: userCount,
      vms: vms.length,
      running: vms.filter((v) => vmService.isRunning(v)).length,
      backups: backupCount,
      disk_usage: vmService.totalDiskUsage(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Wallpapers & Customization API ----------
router.post('/wallpapers/apply', json, async (req, res) => {
  try {
    const { url, mode = 'image', overlay, blur, transparency } = req.body || {};
    if (url) {
      if (mode === 'video') {
        await settings.set('panel.bg_mode', 'video');
        await settings.set('panel.bg_video_url', url);
        await settings.set('panel.bg_video_file', '');
      } else {
        await settings.set('panel.bg_mode', 'image');
        await settings.set('panel.bg_url', url);
        await settings.set('panel.bg_file', '');
      }
    }
    if (overlay !== undefined) await settings.set('panel.bg_overlay', String(overlay));
    if (blur !== undefined) await settings.set('panel.bg_blur', String(blur));
    if (transparency !== undefined) await settings.set('panel.bg_transparency', String(transparency));
    res.json({ ok: true, message: 'Background applied successfully', settings: settings.all() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/customization/save', json, async (req, res) => {
  try {
    const fields = [
      'panel.bg_mode', 'panel.bg_color', 'panel.bg_url', 'panel.bg_video_url',
      'panel.bg_overlay', 'panel.bg_cover', 'panel.bg_blur', 'panel.bg_transparency',
      'panel.theme', 'panel.accent'
    ];
    for (const k of fields) {
      if (req.body[k] !== undefined) {
        await settings.set(k, String(req.body[k]));
      }
    }
    res.json({ ok: true, message: 'Customization saved', settings: settings.all() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/admin/nodes/status', async (req, res) => {
  try {
    const nodeService = require('../services/nodeService');
    res.json({ ok: true, stats: await nodeService.getNodeLiveStats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
