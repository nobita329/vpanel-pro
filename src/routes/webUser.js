const express = require('express');
const path = require('path');
const qrcode = require('qrcode');
const config = require('../lib/config');
const { collections, getNextId, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const bootLogService = require('../services/bootLogService');
const backupService = require('../services/backupService');
const authService = require('../services/authService');
const activity = require('../services/activityService');
const aiLogService = require('../services/aiLogService');
const resourceService = require('../services/resourceService');
const { requireAuth } = require('../middleware/auth');
const { uploadAvatar } = require('../middleware/upload');
const router = express.Router();

router.use(requireAuth);

function render(res, view, vars = {}) {
  res.render(`user/${view}`, {
    page: view,
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}

async function myVms(user) {
  const rows = await collections.vms.find({ owner_id: Number(user.id) }).sort({ id: -1 }).toArray();
  return rows.map(vmService.serializeVm);
}

async function loadVm(req, res, next) {
  try {
    const vm = await vmService.getVm(parseInt(req.params.id, 10));
    if (!vm || !(await vmService.canAccess(req.user, vm))) {
      return res.status(404).render('error/404', {
        code: 404, title: 'Not Found', message: 'Server not found or no access.',
        settings: settings.all(), user: req.user,
      });
    }
    const owner = await collections.users.findOne({ id: Number(vm.owner_id) });
    if (owner) {
      vm.owner_name = owner.username;
      vm.owner_email = owner.email;
    }
    req.vm = vm;
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const vms = await myVms(req.user);
    const subDocs = await collections.subusers.find({ user_id: Number(req.user.id) }).toArray();
    const vmIds = subDocs.map(s => Number(s.vm_id));
    const subVmDocs = vmIds.length ? await collections.vms.find({ id: { $in: vmIds } }).toArray() : [];
    const subVms = subVmDocs.map(vmService.serializeVm);
    const running = [...vms, ...subVms].filter((v) => v.status === 'running').length;
    const recentActivity = await activity.listActivity({ user_id: req.user.id, limit: 8 });
    render(res, 'dashboard', { vms, subVms, running, recentActivity });
  } catch (err) {
    next(err);
  }
});

router.get('/servers/:id', loadVm, async (req, res, next) => {
  try {
    const allUsers = (req.user.role === 'admin' || req.user.root_admin)
      ? await collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).sort({ username: 1 }).toArray()
      : [];
    const backups = await backupService.listForVm(req.vm.id);
    render(res, 'server/overview', { vm: req.vm, backups, allUsers });
  } catch (err) {
    next(err);
  }
});

router.get('/servers/:id/overview', loadVm, async (req, res, next) => {
  try {
    const allUsers = (req.user.role === 'admin' || req.user.root_admin)
      ? await collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).sort({ username: 1 }).toArray()
      : [];
    const backups = await backupService.listForVm(req.vm.id);
    render(res, 'server/overview', { vm: req.vm, backups, allUsers });
  } catch (err) {
    next(err);
  }
});

router.get('/servers/:id/status', loadVm, (req, res) => {
  const s = vmService.liveStats(req.vm);
  res.json({ ok: true, stats: s, ...s });
});

router.get('/servers/:id/console', loadVm, (req, res) => {
  render(res, 'server/console', { vm: req.vm });
});

router.get('/servers/:id/bootlog', loadVm, (req, res) => {
  res.json({ ok: true, log: vmService.getBootLog(req.vm) });
});

router.get('/servers/:id/bootlog/stream', loadVm, (req, res) => {
  bootLogService.handleSseStream(req, res, req.vm);
});

router.post('/servers/:id/bootlog/clear', loadVm, (req, res) => {
  bootLogService.clearBootLogs(req.vm);
  res.json({ ok: true });
});

router.post('/servers/:id/bootlog/diagnose', loadVm, async (req, res) => {
  try {
    const diagnosis = await aiLogService.diagnoseVm(req.vm);
    res.json({ ok: true, diagnosis });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/ai/diagnose-log', express.json(), async (req, res) => {
  try {
    const text = req.body?.log || req.body?.text || '';
    const diagnosis = await aiLogService.diagnoseLog(text);
    res.json({ ok: true, diagnosis });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/servers/:id/files', loadVm, (req, res) => {
  render(res, 'server/files', { vm: req.vm });
});

router.get('/servers/:id/backups', loadVm, async (req, res, next) => {
  try {
    const backups = await backupService.listForVm(req.vm.id);
    render(res, 'server/backups', { vm: req.vm, backups });
  } catch (err) {
    next(err);
  }
});

router.get('/servers/:id/schedules', loadVm, async (req, res, next) => {
  try {
    const schedules = await collections.schedules.find({ vm_id: Number(req.vm.id) }).sort({ id: -1 }).toArray();
    render(res, 'server/schedules', { vm: req.vm, schedules });
  } catch (err) {
    next(err);
  }
});

router.get('/servers/:id/startup', loadVm, (req, res) => {
  render(res, 'server/startup', { vm: req.vm });
});

router.get('/servers/:id/settings', loadVm, (req, res) => {
  render(res, 'server/settings', { vm: req.vm });
});

router.get('/servers/:id/subusers', loadVm, async (req, res, next) => {
  try {
    const subsRaw = await collections.subusers.find({ vm_id: Number(req.vm.id) }).sort({ id: -1 }).toArray();
    const userIds = subsRaw.map(s => Number(s.user_id));
    const users = userIds.length ? await collections.users.find({ id: { $in: userIds } }).toArray() : [];
    const userMap = new Map(users.map(u => [u.id, u]));
    const subs = subsRaw.map(s => ({
      ...s,
      username: userMap.get(s.user_id)?.username || '',
      email: userMap.get(s.user_id)?.email || ''
    }));
    const allUsers = await collections.users.find({ id: { $ne: Number(req.vm.owner_id || 0) } }, { projection: { id: 1, username: 1, email: 1 } }).sort({ username: 1 }).toArray();
    render(res, 'server/subusers', { vm: req.vm, subs, allUsers });
  } catch (err) {
    next(err);
  }
});

router.get('/servers/:id/activity', loadVm, async (req, res, next) => {
  try {
    const logs = await activity.listActivity({ vm_id: req.vm.id, limit: 200 });
    render(res, 'server/activity', { vm: req.vm, logs });
  } catch (err) {
    next(err);
  }
});

router.post('/servers/:id/power', loadVm, express.json(), async (req, res) => {
  const action = req.body.action;
  try {
    if (action === 'start') {
      await vmService.start(req.vm, { user: req.user });
      return res.json({ ok: true, status: 'running' });
    }
    if (action === 'stop') {
      await vmService.stop(req.vm, { user: req.user });
      return res.json({ ok: true, status: 'stopped' });
    }
    if (action === 'kill') {
      await vmService.stop(req.vm, { user: req.user, force: true });
      return res.json({ ok: true, status: 'stopped' });
    }
    if (action === 'restart') {
      await vmService.restart(req.vm, req.user);
      return res.json({ ok: true, status: 'running' });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/settings', loadVm, express.json(), async (req, res) => {
  try {
    const vm = await vmService.update(req.vm, req.body, req.user);
    return res.json({ ok: true, vm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/resize', loadVm, express.json(), async (req, res) => {
  try {
    const vm = await vmService.resizeDisk(req.vm, req.body.disk_size, req.user);
    return res.json({ ok: true, vm });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups', loadVm, express.json(), async (req, res) => {
  try {
    const backup = await backupService.createBackup(req.vm, { user: req.user, name: req.body.name });
    return res.json({ ok: true, backup });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups/:bid/restore', loadVm, async (req, res) => {
  try {
    const backup = await collections.backups.findOne({ id: Number(req.params.bid), vm_id: Number(req.vm.id) });
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    await backupService.restoreBackup(backup, { user: req.user });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups/:bid/delete', loadVm, async (req, res) => {
  try {
    const backup = await collections.backups.findOne({ id: Number(req.params.bid), vm_id: Number(req.vm.id) });
    if (!backup) return res.status(404).json({ error: 'Backup not found' });
    await backupService.deleteBackup(backup, { user: req.user });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/backups/:bid/download', loadVm, async (req, res) => {
  const backup = await collections.backups.findOne({ id: Number(req.params.bid), vm_id: Number(req.vm.id) });
  if (!backup) return res.status(404).send('Backup not found');
  res.download(backup.file, `${req.vm.name}-${backup.name}.qcow2`);
});

router.post('/servers/:id/schedules', loadVm, express.json(), async (req, res) => {
  try {
    const scheduleService = require('../services/scheduleService');
    const sched = await scheduleService.add({ ...req.body, vm_id: req.vm.id }, req.user);
    return res.json({ ok: true, schedule: sched });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/schedules/:sid/delete', loadVm, async (req, res) => {
  try {
    const scheduleService = require('../services/scheduleService');
    const sched = await collections.schedules.findOne({ id: Number(req.params.sid), vm_id: Number(req.vm.id) });
    if (!sched) return res.status(404).json({ error: 'Schedule not found' });
    await scheduleService.remove(sched.id, req.user);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/subusers', loadVm, express.json(), async (req, res) => {
  try {
    const { user_id, permissions } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    if (Number(user_id) === req.vm.owner_id) return res.status(400).json({ error: 'Owner cannot be a subuser' });
    const exists = await collections.subusers.findOne({ vm_id: Number(req.vm.id), user_id: Number(user_id) });
    if (exists) return res.status(400).json({ error: 'User already has access to this server' });
    const nextId = await getNextId('subusers');
    await collections.subusers.insertOne({
      id: nextId,
      vm_id: Number(req.vm.id),
      user_id: Number(user_id),
      permissions: JSON.stringify(permissions || ['*']),
      created_at: new Date().toISOString()
    });
    await activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'subuser:add', details: { user_id } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/subusers/:sid/delete', loadVm, async (req, res) => {
  try {
    await collections.subusers.deleteOne({ id: Number(req.params.sid), vm_id: Number(req.vm.id) });
    await activity.logActivity({ user_id: req.user.id, vm_id: req.vm.id, event: 'subuser:remove' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/transfer', loadVm, express.json(), async (req, res) => {
  if (req.user.role !== 'admin' && !req.user.root_admin && req.vm.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only server owner or administrators can transfer ownership' });
  }
  const { owner_id } = req.body;
  if (!owner_id) return res.status(400).json({ error: 'Owner ID is required' });
  try {
    const updated = await vmService.transferOwner(req.vm, parseInt(owner_id, 10), req.user);
    res.json({ ok: true, vm: vmService.serializeVm(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/servers/:id/delete', loadVm, async (req, res) => {
  if (req.vm.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the owner can delete this server' });
  }
  try {
    await vmService.remove(req.vm, req.user);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/profile', async (req, res, next) => {
  try {
    const loginHistory = await activity.listLoginHistory({ user_id: req.user.id, limit: 50 });
    render(res, 'profile', { loginHistory });
  } catch (err) {
    next(err);
  }
});

router.post('/profile', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const data = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.email) data.email = req.body.email;
    if (req.body.language) data.language = req.body.language;
    await authService.updateUser(req.user.id, data);
    return render(res, 'profile', {
      success: 'Profile updated!',
      loginHistory: await activity.listLoginHistory({ user_id: req.user.id, limit: 50 }),
    });
  } catch (e) {
    return render(res, 'profile', {
      error: e.message,
      loginHistory: await activity.listLoginHistory({ user_id: req.user.id, limit: 50 }),
    });
  }
});

router.post('/profile/avatar', uploadAvatar.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/avatar/${req.file.filename}`;
  await authService.updateUser(req.user.id, { avatar: url });
  return res.json({ ok: true, avatar: url });
});

router.post('/profile/password', express.json(), async (req, res) => {
  const { current, password } = req.body;
  const bcrypt = require('bcryptjs');
  if (!bcrypt.compareSync(current, req.user.password)) return res.status(400).json({ error: 'Current password is incorrect' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'New password too short' });
  await authService.updateUser(req.user.id, { password });
  await activity.logActivity({ user_id: req.user.id, event: 'profile:password_changed' });
  return res.json({ ok: true });
});

router.get('/settings', (req, res) => render(res, 'userSettings', { tfaSetup: null }));
router.get('/user-settings', (req, res) => res.redirect('/settings'));
router.post('/settings', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const data = {};
    if (req.body.avatar_url) data.avatar = req.body.avatar_url;
    if (req.body.language) data.language = req.body.language;
    await authService.updateUser(req.user.id, data);
    return render(res, 'userSettings', { success: 'Settings saved!' });
  } catch (e) {
    return render(res, 'userSettings', { error: e.message });
  }
});

router.get('/settings/tfa/setup', (req, res) => {
  const tfaSetup = authService.setupTfa(req.user);
  return render(res, 'userSettings', { tfaSetup });
});

router.post('/settings/tfa/enable', express.json(), async (req, res) => {
  const result = await authService.enableTfa(req.user, req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ ok: true });
});

router.post('/settings/tfa/disable', express.json(), async (req, res) => {
  const result = await authService.disableTfa(req.user, req.body.code);
  if (!result.ok) return res.status(400).json({ error: result.error });
  return res.json({ ok: true });
});

router.get('/activity', async (req, res, next) => {
   try {
     const logs = await activity.listActivity({ user_id: req.user.id, limit: 200 });
     render(res, 'activity', { logs });
   } catch (err) {
     next(err);
   }
});

router.get(['/resources', '/resources/stats'], (req, res) => res.redirect('/dashboard'));

router.get('/qrcode', (req, res) => {
  const data = req.query.data;
  if (!data) return res.status(400).end();
  qrcode.toBuffer(data, { width: 220, margin: 1 })
    .then((buf) => { res.setHeader('Content-Type', 'image/png'); res.send(buf); })
    .catch(() => res.status(500).end());
});

router.get('/notifications', async (req, res, next) => {
  try {
    const notifs = await collections.notifications.find({ user_id: Number(req.user.id) }).sort({ id: -1 }).limit(50).toArray();
    render(res, 'notifications', { notifs });
  } catch (err) {
    next(err);
  }
});

router.post('/notifications/:id/read', async (req, res, next) => {
  try {
    await collections.notifications.updateOne({ id: Number(req.params.id), user_id: Number(req.user.id) }, { $set: { read: 1 } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
