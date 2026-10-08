const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const { collections, settings } = require('../lib/db');
const vmService = require('../services/vmService');
const backupService = require('../services/backupService');
const authService = require('../services/authService');
const activity = require('../services/activityService');
const resourceService = require('../services/resourceService');
const { requireAdmin } = require('../middleware/auth');
const { uploadLogo, uploadFavicon, uploadBackground, uploadMusic } = require('../middleware/upload');
const multer = require('multer');
const fs2 = require('fs');
const createUpload = multer({ dest: config.root + '/data/tmp' });
const cacheService = require('../services/cacheService');
const router = express.Router();

router.use(requireAdmin);

function render(res, view, vars = {}) {
  res.render(`admin/${view}`, {
    page: 'admin-' + view,
    user: res.req.user,
    settings: settings.all(),
    ...vars,
  });
}

const nodeService = require('../services/nodeService');

router.get('/admin', async (req, res, next) => {
  try {
    const vms = (await vmService.dbVms()).map(vmService.serializeVm);
    const users = await collections.users.find({}, { projection: { id: 1, username: 1, email: 1, role: 1, suspended: 1, verified: 1, created_at: 1, last_login_at: 1 } }).toArray();
    const running = vms.filter((v) => v.status === 'running').length;
    const totalDisk = vms.reduce((a, v) => a + parseInt(v.disk_size || '0'), 0);
    const recentLogs = await activity.listActivity({ limit: 12 });
    const nodeStats = await nodeService.getNodeLiveStats();
    render(res, 'dashboard', { vms, users, running, totalDisk, recentLogs, usage: vmService.usage(), nodeStats });
  } catch (err) {
    next(err);
  }
});

// ── Nodes Management (matching Pterodactyl nodes suite) ─────────────────
router.get('/admin/nodes', async (req, res, next) => {
  try {
    const filterQuery = req.query?.['filter[name]'] || req.query?.filter?.name || req.query?.q || '';
    const nodes = await nodeService.listNodes(filterQuery);
    const nodeStats = await nodeService.getNodeLiveStats(1);
    render(res, 'nodes', { nodes, nodeStats, filterQuery });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/nodes/status', async (req, res) => {
  try {
    const stats = await nodeService.getNodeLiveStats(req.query?.id || 1);
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get(['/admin/nodes/new', '/admin/nodes/create'], async (req, res, next) => {
  try {
    const locations = await nodeService.listLocations();
    render(res, 'nodeCreate', { locations });
  } catch (err) {
    next(err);
  }
});

router.post(['/admin/nodes/new', '/admin/nodes/create'], express.json(), async (req, res, next) => {
  try {
    const node = await nodeService.createNode(req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:node_create', details: { id: node.id, name: node.name } });
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ ok: true, node });
    }
    res.redirect(`/admin/nodes/${node.id}`);
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    next(err);
  }
});

router.get(['/admin/nodes/:id', '/admin/nodes/view/:id'], async (req, res, next) => {
  try {
    const node = await nodeService.getNode(req.params.id);
    if (!node) return res.redirect('/admin/nodes');
    const locations = await nodeService.listLocations();
    const allNodes = await nodeService.listNodes();
    const nodeStats = await nodeService.getNodeLiveStats(req.params.id);
    render(res, 'nodeDetail', { node, locations, allNodes, nodeStats });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/nodes/:id/settings', express.json(), async (req, res) => {
  try {
    const updated = await nodeService.updateNode(req.params.id, req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:node_settings_update', details: { id: req.params.id } });
    res.json({ ok: true, node: updated });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/:id/delete', express.json(), async (req, res) => {
  try {
    await nodeService.deleteNode(req.params.id, req.body?.force || false);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:node_delete', details: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/:id/configuration/token', async (req, res) => {
  try {
    const node = await nodeService.getNode(req.params.id);
    if (!node) return res.status(404).json({ ok: false, error: 'Node not found' });
    const deploy = nodeService.generateDeployToken(node);
    res.json({ ok: true, token: deploy.token, node: deploy.node, command: deploy.command });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/:id/allocations/create', express.json(), async (req, res) => {
  try {
    const result = await nodeService.createAllocations(req.params.id, req.body);
    res.json({ ok: true, added: result.added });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/:id/allocations/delete', express.json(), async (req, res) => {
  try {
    const count = await nodeService.deleteAllocations(req.params.id, req.body.allocation_ids || []);
    res.json({ ok: true, deleted: count });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/:id/allocations/:allocId/alias', express.json(), async (req, res) => {
  try {
    await nodeService.updateAllocationAlias(req.params.id, req.params.allocId, req.body.alias);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/mass/app-name', express.json(), async (req, res) => {
  try {
    const count = await nodeService.massUpdateAppName(req.body.node_ids, req.body.app_name);
    res.json({ ok: true, updated: count });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/mass/wings-control', express.json(), async (req, res) => {
  try {
    const results = await nodeService.massWingsControl(req.body.node_ids, req.body.action);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/admin/nodes/:id/logs', async (req, res) => {
  try {
    const logs = nodeService.getNodeLogs(req.params.id, req.query?.source || 'wings');
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/admin/nodes/:id/wings/control', express.json(), async (req, res) => {
  try {
    const act = req.body?.action || 'restart';
    res.json({ ok: true, message: `Dispatched ${act} to Wings Agent` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/admin/servers', async (req, res, next) => {
  try {
    const vms = (await vmService.dbVms()).map(vmService.serializeVm);
    const nodes = await nodeService.listNodes();
    render(res, 'servers', { vms, nodes, filterQuery: req.query?.['filter[*]'] || req.query?.q || '' });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/servers/new', (req, res) => {
  res.redirect('/admin/servers/create');
});

router.post('/admin/servers/mass/action', express.json(), async (req, res) => {
  try {
    const { server_ids, action, force } = req.body;
    if (!Array.isArray(server_ids) || !server_ids.length) {
      return res.status(400).json({ ok: 0, fail: 0, error: 'No servers selected' });
    }
    let ok = 0;
    let fail = 0;
    for (const rawId of server_ids) {
      try {
        const id = Number(rawId);
        const vm = await vmService.getVm(id);
        if (!vm) { fail++; continue; }
        if (action === 'suspend') {
          await collections.vms.updateOne({ id }, { $set: { suspended: true, updated_at: new Date() } });
          if (vmService.isRunning(vm)) {
            await vmService.stop(vm, { user: req.user, force: true });
          }
          ok++;
        } else if (action === 'unsuspend') {
          await collections.vms.updateOne({ id }, { $set: { suspended: false, updated_at: new Date() } });
          ok++;
        } else if (action === 'delete') {
          await vmService.remove(vm, req.user);
          ok++;
        } else {
          fail++;
        }
      } catch (_) {
        fail++;
      }
    }
    res.json({ ok, fail });
  } catch (err) {
    res.status(500).json({ ok: 0, fail: 0, error: err.message });
  }
});

router.post('/admin/servers/mass/transfer', express.json(), async (req, res) => {
  try {
    const { server_ids, node_id } = req.body;
    if (!Array.isArray(server_ids) || !server_ids.length) {
      return res.status(400).json({ ok: 0, fail: 0, error: 'No servers selected' });
    }
    let ok = 0;
    for (const rawId of server_ids) {
      const id = Number(rawId);
      await collections.vms.updateOne({ id }, { $set: { node_id: Number(node_id || 1), updated_at: new Date() } });
      ok++;
    }
    res.json({ ok, fail: 0 });
  } catch (err) {
    res.status(500).json({ ok: 0, fail: 0, error: err.message });
  }
});

router.post('/admin/servers/:id/details', express.json(), async (req, res) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    const { name, external_id, owner_id, description, exp_date } = req.body;
    const updateData = {};
    if (name) updateData.name = String(name).trim();
    if (external_id !== undefined) updateData.external_id = String(external_id).trim();
    if (description !== undefined) updateData.description = String(description).trim();
    if (exp_date !== undefined) updateData.exp_date = exp_date;

    if (owner_id && Number(owner_id) !== Number(vm.owner_id)) {
      await vmService.transferOwner(vm, Number(owner_id), req.user);
    }
    await vmService.update(vm, updateData, req.user);
    res.json({ ok: true, message: 'Server details updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/servers/:id/build', express.json(), async (req, res) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    const { cpu, memory, disk, threads, swap } = req.body;
    const updateData = {};
    if (cpu !== undefined && parseInt(cpu, 10) > 0) updateData.cpus = parseInt(cpu, 10);
    if (memory !== undefined && parseInt(memory, 10) > 0) updateData.memory = parseInt(memory, 10);
    if (disk !== undefined) {
      let diskStr = String(disk).trim().toUpperCase();
      if (!diskStr.endsWith('G') && !diskStr.endsWith('M')) diskStr += 'G';
      updateData.disk_size = diskStr;
    }
    if (threads !== undefined) updateData.threads = String(threads).trim();
    if (swap !== undefined) updateData.swap = parseInt(swap, 10);

    await vmService.update(vm, updateData, req.user);
    res.json({ ok: true, message: 'Build configuration updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/servers/:id/manage/suspension', express.json(), async (req, res) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    const action = req.body.action || (vm.suspended ? 'unsuspend' : 'suspend');
    const suspend = action === 'suspend';
    await collections.vms.updateOne({ id: Number(vm.id) }, { $set: { suspended: suspend, updated_at: new Date() } });
    if (suspend && vmService.isRunning(vm)) {
      await vmService.stop(vm, { user: req.user, force: true });
    }
    res.json({ ok: true, suspended: suspend });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/servers/:id/manage/reinstall', express.json(), async (req, res) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    if (vmService.isRunning(vm)) {
      await vmService.stop(vm, { user: req.user, force: true });
    }
    vmService.writeSeed(vm);
    res.json({ ok: true, message: 'Server reinstalled successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/servers/:id/manage/toggle', express.json(), async (req, res) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    if (vmService.isRunning(vm)) {
      await vmService.stop(vm, { user: req.user });
      res.json({ ok: true, status: 'stopped' });
    } else {
      await vmService.start(vm, { user: req.user });
      res.json({ ok: true, status: 'running' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/servers/:id/delete', express.json(), async (req, res) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    await vmService.remove(vm, req.user);
    res.json({ ok: true, message: 'Server deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/servers/create', async (req, res, next) => {
  try {
    const users = await collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).sort({ username: 1 }).toArray();
    render(res, 'create', { osList: vmService.getOsList(), users });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/servers/create', createUpload.fields([{ name: 'image', maxCount: 1 }]), async (req, res) => {
  try {
    const files = req.files || {};
    const ownerId = parseInt(req.body.owner_id || req.user.id, 10);
    const owner = await collections.users.findOne({ id: ownerId });
    if (!owner) return res.status(400).json({ error: 'Owner not found' });
    const data = { ...req.body };
    try { if (data.port_forwards) data.port_forwards = JSON.parse(data.port_forwards); } catch (_) { data.port_forwards = []; }
    if (files.image && files.image[0]) data.upload_image = files.image[0];
    if (files.image && files.image[0]) {
      try { fs2.mkdirSync(config.root + '/data/tmp', { recursive: true }); } catch (_) {}
    }
    const vm = await vmService.create({ user: owner, data });
    // keep the image file if it was a download; clean temp upload if used
    if (data.upload_image) {
      try { fs2.unlinkSync(data.upload_image.path); } catch (_) {}
    }
    return res.json({ ok: true, vm, redirect: `/admin/servers/${vm.id}` });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/action', async (req, res) => {
  const vm = await vmService.getVm(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  const { action } = req.body;
  try {
    if (action === 'start') {
      await vmService.start(vm, { user: req.user });
      return res.json({ ok: true, status: 'running' });
    } else if (action === 'stop') {
      const s = await vmService.stop(vm, { user: req.user });
      return res.json({ ok: true, status: s.status });
    } else if (action === 'kill') {
      const s = await vmService.stop(vm, { user: req.user, force: true });
      return res.json({ ok: true, status: s.status });
    } else if (action === 'restart') {
      await vmService.restart(vm, req.user);
      return res.json({ ok: true, status: 'running' });
    } else if (action === 'delete') {
      const s = await vmService.remove(vm, req.user);
      return res.json(s);
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/servers/:id/transfer', express.json(), async (req, res) => {
  const vm = await vmService.getVm(req.params.id);
  if (!vm) return res.status(404).json({ error: 'Server not found' });
  const { owner_id } = req.body;
  if (!owner_id) return res.status(400).json({ error: 'Owner ID is required' });
  try {
    const updated = await vmService.transferOwner(vm, parseInt(owner_id, 10), req.user);
    res.json({ ok: true, vm: vmService.serializeVm(updated) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/servers/:id', async (req, res, next) => {
  try {
    const vm = await vmService.getVm(req.params.id);
    if (!vm) return res.status(404).render('error/404', { code: 404, title: 'Not Found', message: 'Server not found', settings: settings.all(), user: req.user });
    const backups = await backupService.listForVm(vm.id);
    const schedules = await collections.schedules.find({ vm_id: Number(vm.id) }).toArray();
    const subsRaw = await collections.subusers.find({ vm_id: Number(vm.id) }).toArray();
    const userIds = subsRaw.map(s => Number(s.user_id));
    const subUsers = userIds.length ? await collections.users.find({ id: { $in: userIds } }).toArray() : [];
    const userMap = new Map(subUsers.map(u => [u.id, u]));
    const subs = subsRaw.map(s => ({ ...s, username: userMap.get(s.user_id)?.username || '' }));
    const allUsers = await collections.users.find({}, { projection: { id: 1, username: 1, email: 1 } }).sort({ username: 1 }).toArray();
    render(res, 'serverDetail', { vm, backups, schedules, subs, allUsers, uptime: vmService.uptimeSeconds(vm), mem: vmService.memUsage(vm) });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/users', async (req, res, next) => {
  try {
    const filterQuery = (req.query?.['filter[email]'] || req.query?.filter?.email || req.query?.q || '').trim();
    let query = {};
    if (filterQuery) {
      const reg = new RegExp(filterQuery.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i');
      query = {
        $or: [
          { email: reg },
          { username: reg },
          { name: reg },
          { name_first: reg },
          { name_last: reg },
        ]
      };
    }
    const usersRaw = await collections.users.find(query).sort({ id: -1 }).toArray();
    const vms = await collections.vms.find({}, { projection: { owner_id: 1 } }).toArray();
    const subusers = collections.subusers ? await collections.subusers.find({}, { projection: { user_id: 1 } }).toArray() : [];

    const countMap = {};
    for (const v of vms) countMap[v.owner_id] = (countMap[v.owner_id] || 0) + 1;
    const subMap = {};
    for (const s of subusers) subMap[s.user_id] = (subMap[s.user_id] || 0) + 1;

    const users = usersRaw.map(u => {
      const pub = authService.publicUser(u);
      pub.vm_count = countMap[u.id] || 0;
      pub.subuser_count = subMap[u.id] || 0;
      return pub;
    });

    render(res, 'users', { users, filterQuery });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/users/new', (req, res) => {
  const languages = {
    en: 'English',
    es: 'Español',
    fr: 'Français',
    de: 'Deutsch',
    zh: '简体中文',
    ja: '日本語',
    ru: 'Русский',
    hi: 'हिन्दी'
  };
  render(res, 'userCreate', { languages });
});

router.get('/admin/users/:id', async (req, res, next) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.redirect('/admin/users');
    const vmsDocs = await collections.vms.find({ owner_id: Number(target.id) }).toArray();
    const vms = vmsDocs.map(vmService.serializeVm);
    const otherDocs = await collections.vms.find({ owner_id: { $ne: Number(target.id) } }).sort({ name: 1 }).toArray();
    const otherOwnerIds = [...new Set(otherDocs.map(v => Number(v.owner_id)))];
    const otherOwners = otherOwnerIds.length ? await collections.users.find({ id: { $in: otherOwnerIds } }).toArray() : [];
    const ownerMap = new Map(otherOwners.map(o => [o.id, o.username]));
    const otherVms = otherDocs.map(v => ({ ...vmService.serializeVm(v), owner_username: ownerMap.get(v.owner_id) || '' }));
    const loginHistory = await activity.listLoginHistory({ user_id: target.id, limit: 50 });
    const activeSessions = await authService.listUserSessions(target.id);
    const logs = await activity.listActivity({ user_id: target.id, limit: 100 });
    const quota = await resourceService.getUserQuota(target.id);
    const languages = {
      en: 'English',
      es: 'Español',
      fr: 'Français',
      de: 'Deutsch',
      zh: '简体中文',
      ja: '日本語',
      ru: 'Русский',
      hi: 'हिन्दी'
    };
    const currency = settings.get('billing.currency_symbol') || '$';
    render(res, 'userDetail', {
      target: authService.publicUser(target),
      vms,
      otherVms,
      loginHistory,
      activeSessions,
      logs,
      quota,
      languages,
      currency
    });
  } catch (err) {
    next(err);
  }
});

router.post('/admin/users/:id/quota', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const quota = await resourceService.updateUserQuota(target.id, req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:quota_update', details: { target: target.username, ...req.body } });
    return res.json({ ok: true, quota });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/assign-vm', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const { vm_id } = req.body;
    if (!vm_id) return res.status(400).json({ error: 'VM ID is required' });
    const vm = await vmService.getVm(vm_id);
    if (!vm) return res.status(404).json({ error: 'Server not found' });
    await vmService.transferOwner(vm, target.id, req.user);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/create', express.json(), async (req, res) => {
  try {
    const user = await authService.createUser({
      username: req.body.username,
      email: req.body.email,
      password: req.body.password,
      name: req.body.name,
      name_first: req.body.name_first,
      name_last: req.body.name_last,
      language: req.body.language || 'en',
      role: req.body.role || (req.body.root_admin ? 'admin' : 'user'),
      root_admin: req.body.root_admin ? 1 : 0,
      country: req.body.country || '',
      address: req.body.address || '',
      zip_code: req.body.zip_code || '',
      credit: parseFloat(req.body.credit) || 0,
      verified: true,
    });
    await activity.logActivity({
      user_id: req.user.id,
      event: 'admin:user_create',
      details: { username: user.username, email: user.email, role: user.role }
    });
    return res.json({ ok: true, user: authService.publicUser(user) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/update', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if ((req.body.suspended === false || req.body.role === 'user' || req.body.root_admin === false || req.body.root_admin === 0) && target.root_admin && (await authService.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot demote the last admin' });
    }
    const updated = await authService.updateUser(target.id, req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:user_update', details: { target: target.username, ...req.body } });
    return res.json({ ok: true, user: authService.publicUser(updated) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/status', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if ((req.body.is_banned || req.body.suspended) && target.root_admin && (await authService.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot ban or suspend the last admin' });
    }
    const updated = await authService.updateUser(target.id, {
      is_banned: req.body.is_banned !== undefined ? (req.body.is_banned === true || req.body.is_banned === '1' || req.body.is_banned === 1) : target.is_banned,
      ban_reason: req.body.ban_reason !== undefined ? String(req.body.ban_reason).trim() : (target.ban_reason || ''),
      suspended: req.body.suspended !== undefined ? (req.body.suspended === true || req.body.suspended === '1' || req.body.suspended === 1) : target.suspended,
      suspended_until: req.body.suspended_until || null,
      suspension_reason: req.body.suspension_reason !== undefined ? String(req.body.suspension_reason).trim() : (target.suspension_reason || '')
    });
    await activity.logActivity({ user_id: req.user.id, event: 'admin:user_status_update', details: { target: target.username, ...req.body } });
    return res.json({ ok: true, user: authService.publicUser(updated) });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/ban', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.root_admin && (await authService.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot ban the last admin' });
    }
    const ban = req.body.ban !== false;
    const ban_reason = String(req.body.ban_reason || req.body.reason || '').trim();
    await authService.updateUser(target.id, { is_banned: ban, ban_reason });
    await activity.logActivity({ user_id: req.user.id, event: ban ? 'admin:user_ban' : 'admin:user_unban', details: { target: target.username, ban_reason } });
    return res.json({ ok: true, banned: ban, ban_reason });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/sessions/:sid/revoke', async (req, res) => {
  try {
    await authService.revokeSession(req.params.id, req.params.sid);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:session_revoke', details: { user_id: req.params.id, session_id: req.params.sid } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/sessions/revoke-all', async (req, res) => {
  try {
    await authService.revokeAllSessions(req.params.id);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:session_revoke_all', details: { user_id: req.params.id } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/delete', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.root_admin && (await authService.countAdmins()) <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account' });

    const userVmCount = await collections.vms.countDocuments({ owner_id: Number(target.id) });
    if (userVmCount > 0 && req.body?.force !== true && req.body?.force !== 'true') {
      return res.status(400).json({ error: `There are still ${userVmCount} virtual machine(s) associated with this account. Please transfer or delete them first.` });
    }

    await authService.deleteUser(target.id);
    await activity.logActivity({ user_id: req.user.id, event: 'admin:user_delete', details: { target: target.username } });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/suspend', express.json(), async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.root_admin && (await authService.countAdmins()) <= 1) return res.status(400).json({ error: 'Cannot suspend the last admin' });
    const suspend = req.body.suspend !== false;
    await authService.updateUser(target.id, {
      suspended: suspend,
      suspended_until: req.body.suspended_until || null,
      suspension_reason: req.body.suspension_reason || ''
    });
    await activity.logActivity({ user_id: req.user.id, event: suspend ? 'admin:user_suspend' : 'admin:user_unsuspend', details: { target: target.username } });
    return res.json({ ok: true, suspended: suspend });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.post('/admin/users/:id/impersonate', async (req, res) => {
  try {
    const target = await authService.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.suspended) return res.status(400).json({ error: 'Cannot impersonate a suspended user' });

    let adminToken = req.cookies?.token;
    if (!adminToken && req.headers?.authorization?.startsWith('Bearer ')) {
      adminToken = req.headers.authorization.slice(7).trim();
    }
    if (!adminToken) {
      adminToken = authService.generateToken(req.user);
    }

    const userToken = authService.generateToken(target);

    res.cookie('vpanel_impersonate_admin', adminToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 86400000,
    });
    res.cookie('token', userToken, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 86400000,
    });

    await activity.logActivity({
      user_id: req.user.id,
      event: 'auth:impersonate_start',
      details: { admin: req.user.username, target: target.username, target_id: target.id },
      ip: req.ip,
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, redirect: '/dashboard', target: target.username });
    }
    return res.redirect('/dashboard');
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/admin/activity', async (req, res, next) => {
  try {
    const logs = await activity.listActivity({ limit: 500 });
    render(res, 'activity', { logs });
  } catch (err) {
    next(err);
  }
});

router.get('/admin/settings', async (req, res) => {
  const all = settings.all();
  let wallpapers = [];
  const wallpaperCache = path.join(config.root, 'data/wallpapers.json');
  if (fs.existsSync(wallpaperCache)) {
    try { wallpapers = JSON.parse(fs.readFileSync(wallpaperCache, 'utf8')); } catch (_) {}
  }
  let cacheStatus = null;
  try {
    cacheStatus = await cacheService.getCacheStatus();
  } catch (_) {}
  render(res, 'settings', { all, wallpapers, updated: req.query.updated || '', cacheStatus });
});

router.get('/admin/cache/status', async (req, res) => {
  try {
    const status = await cacheService.getCacheStatus();
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/cache/clear', async (req, res) => {
  try {
    const result = await cacheService.clearAllCaches('manual_admin');
    await activity.logActivity({ user_id: req.user.id, event: 'admin:cache_clear', details: result.details });
    const status = await cacheService.getCacheStatus();
    res.json({ ok: true, result, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/cache/auto-clear/config', express.json(), async (req, res) => {
  try {
    const { enabled, interval } = req.body;
    const status = await cacheService.updateConfig({ enabled, interval });
    await activity.logActivity({ user_id: req.user.id, event: 'admin:cache_auto_config', details: { enabled, interval } });
    res.json({ ok: true, status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/settings', express.json(), async (req, res) => {
  const body = req.body || {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'panel.name') continue; // guarded
    settings.set(k, v);
  }
  await activity.logActivity({ user_id: req.user.id, event: 'admin:settings_update', details: Object.keys(body) });
  return res.json({ ok: true, settings: settings.all() });
});

router.post('/admin/settings/general', express.urlencoded({ extended: true }), async (req, res) => {
  const save = (key) => {
    if (req.body[key] !== undefined) settings.set(key, req.body[key]);
  };
  for (const key of [
    'panel.name', 'panel.logo_mode', 'panel.logo_url', 'panel.favicon_name',
    'panel.favicon_mode', 'panel.favicon_url', 'panel.bg_mode', 'panel.bg_color',
    'panel.bg_url', 'panel.bg_cover', 'panel.bg_overlay', 'panel.bg_video_url',
    'panel.music_mode', 'panel.music_url', 'panel.music_youtube', 'panel.music_autoplay',
    'panel.music_loop', 'panel.music_volume', 'panel.navbar_style', 'panel.navbar_transparent',
    'panel.navbar_blur', 'panel.accent', 'panel.theme',
  ]) save(key);
  save('panel.wallpapers_api_key');
  for (const key of ['mail.host', 'mail.port', 'mail.secure', 'mail.user', 'mail.pass', 'mail.from']) save(key);
  for (const key of ['security.allow_register', 'security.require_verify', 'security.force_tfa', 'vm.auto_port_min', 'vm.auto_port_max', 'vm.vnc_port_min', 'vm.vnc_port_max', 'vm.agent_port_min', 'vm.agent_port_max', 'vm.default_memory', 'vm.default_cpus', 'vm.default_disk', 'vm.default_os']) save(key);
  if (req.body.vm_os_list) {
    try {
      settings.set('vm.os_list', JSON.stringify(JSON.parse(req.body.vm_os_list)));
    } catch (_) {}
  }
  activity.logActivity({ user_id: req.user.id, event: 'admin:settings_update' });
  return res.redirect('/admin/settings?updated=1');
});

router.post('/admin/settings/arix', express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  const save = (key) => {
    if (req.body[key] !== undefined) settings.set(key, req.body[key]);
  };
  for (const key of [
    'arix.primary', 'arix.mode', 'arix.radius_box', 'arix.radius_input',
    'arix.nav_glow', 'arix.sound_effects', 'arix.login_bg', 'arix.logo_url'
  ]) {
    save(key);
  }
  // synchronize primary with panel.accent and panel.theme
  if (req.body['arix.primary']) {
    settings.set('panel.accent', req.body['arix.primary']);
  }
  if (req.body['arix.mode']) {
    settings.set('panel.theme', req.body['arix.mode']);
  }
  await activity.logActivity({ user_id: req.user.id, event: 'admin:settings_arix_update', details: req.body });
  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.json({ ok: true, settings: settings.all() });
  }
  return res.redirect('/admin/settings?tab=arix&updated=1');
});

router.post('/admin/settings/logo', uploadLogo.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.logo_mode', 'upload');
  settings.set('panel.logo_file', `/uploads/logo/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/logo/${req.file.filename}` });
});

router.post('/admin/settings/favicon', uploadFavicon.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  settings.set('panel.favicon_mode', 'upload');
  settings.set('panel.favicon_file', `/uploads/favicon/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/favicon/${req.file.filename}` });
});

router.post('/admin/settings/background', uploadBackground.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const isVideo = /\.(mp4|webm|avi|mov)$/i.test(req.file.filename);
  if (isVideo) {
    await settings.set('panel.bg_mode', 'video');
    await settings.set('panel.bg_video_file', `/uploads/background/${req.file.filename}`);
  } else {
    await settings.set('panel.bg_mode', 'image');
    await settings.set('panel.bg_file', `/uploads/background/${req.file.filename}`);
  }
  return res.json({ ok: true, url: `/uploads/background/${req.file.filename}`, mode: isVideo ? 'video' : 'image' });
});

router.post('/admin/settings/music', uploadMusic.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  await settings.set('panel.music_mode', 'upload');
  await settings.set('panel.music_file', `/uploads/music/${req.file.filename}`);
  return res.json({ ok: true, url: `/uploads/music/${req.file.filename}` });
});

router.post('/admin/settings/logo-clear', async (req, res) => {
  await settings.set('panel.logo_mode', 'url');
  await settings.set('panel.logo_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/favicon-clear', async (req, res) => {
  await settings.set('panel.favicon_mode', 'url');
  await settings.set('panel.favicon_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/background-clear', async (req, res) => {
  await settings.set('panel.bg_mode', 'color');
  await settings.set('panel.bg_file', '');
  await settings.set('panel.bg_video_file', '');
  res.json({ ok: true });
});
router.post('/admin/settings/music-clear', async (req, res) => {
  await settings.set('panel.music_mode', 'none');
  await settings.set('panel.music_file', '');
  res.json({ ok: true });
});

const wallpaperService = require('../services/wallpaperService');

router.get('/admin/wallpapers', async (req, res) => {
  try {
    const data = await wallpaperService.getWallpapers({
      category: req.query.category,
      page: req.query.page,
      query: req.query.q || req.query.query,
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Failed to fetch wallpapers: ' + e.message });
  }
});

router.post('/admin/wallpapers/apply', express.json(), async (req, res) => {
  const { url, thumbnail, blur, transparency, overlay } = req.body;
  if (!url) return res.status(400).json({ error: 'No url provided' });
  await settings.set('panel.bg_mode', 'image');
  await settings.set('panel.bg_url', url);
  if (thumbnail) await settings.set('panel.bg_thumb', thumbnail);
  if (blur !== undefined) await settings.set('panel.bg_blur', String(blur));
  if (transparency !== undefined) await settings.set('panel.bg_transparency', String(transparency));
  if (overlay !== undefined) await settings.set('panel.bg_overlay', String(overlay));
  return res.json({ ok: true, message: 'Wallpaper applied successfully' });
});

router.use('/admin/mongodb', require('./webAdminMongo'));
router.use('/admin/storage', require('./webAdminStorage'));
router.use('/admin/network', require('./webAdminNetwork'));
router.use('/admin/billing', (req, res) => res.redirect('/admin'));
router.use('/admin/updates', require('./webAdminUpdates'));
router.use('/admin/api', require('./webAdminApiManager'));
router.use('/admin/audit', require('./webAdminAudit'));
router.use('/admin/plugins', require('./webAdminPlugins'));
router.use('/admin/resources', (req, res) => res.redirect('/admin'));

module.exports = router;
