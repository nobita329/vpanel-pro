const express = require('express');
const storageService = require('../services/storageService');
const templateService = require('../services/templateService');
const { requireAdmin } = require('../middleware/auth');
const { settings } = require('../lib/db');
const activity = require('../services/activityService');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const [pools, isos, volumes] = await Promise.all([
      storageService.listPools(),
      storageService.listIsos(),
      storageService.listVolumes(),
    ]);

    res.render('admin/storage', {
      page: 'admin-storage',
      user: req.user,
      settings: settings.all(),
      pools,
      isos,
      volumes,
    });
  } catch (e) {
    next(e);
  }
});

router.get('/api/pools', async (req, res) => {
  try {
    const pools = await storageService.listPools();
    res.json({ ok: true, pools });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/pools/create', async (req, res) => {
  try {
    const pool = await storageService.createPool(req.body);
    await activity.logActivity({ user_id: req.user.id, event: 'storage:pool_create', details: { name: pool.name } });
    res.json({ ok: true, pool });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/pools/delete', async (req, res) => {
  try {
    const result = await storageService.deletePool(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'storage:pool_delete', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/isos', async (req, res) => {
  try {
    const isos = await storageService.listIsos();
    res.json({ ok: true, isos });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/isos/download', async (req, res) => {
  try {
    const iso = await storageService.createIsoDownload(req.body.name, req.body.url, req.body.category);
    await activity.logActivity({ user_id: req.user.id, event: 'storage:iso_download', details: { name: iso.name, url: req.body.url } });
    res.json({ ok: true, iso });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/isos/delete', async (req, res) => {
  try {
    const result = await storageService.deleteIso(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'storage:iso_delete', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/volumes', async (req, res) => {
  try {
    const volumes = await storageService.listVolumes();
    res.json({ ok: true, volumes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/volumes/create', async (req, res) => {
  try {
    const volume = await storageService.createVolume(req.body.name, req.body.size_gb, req.body.pool_id);
    await activity.logActivity({ user_id: req.user.id, event: 'storage:volume_create', details: { name: volume.name } });
    res.json({ ok: true, volume });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/volumes/delete', async (req, res) => {
  try {
    const result = await storageService.deleteVolume(req.body.id);
    await activity.logActivity({ user_id: req.user.id, event: 'storage:volume_delete', details: { id: req.body.id } });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/api/templates', async (req, res) => {
  try {
    const templates = await templateService.listTemplates();
    res.json({ ok: true, repo: templateService.getRepoUrl(), count: templates.length, templates });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/api/templates/sync', async (req, res) => {
  try {
    const { repo } = req.body || {};
    const result = await templateService.syncTemplates(repo);
    await activity.logActivity({
      user_id: req.user.id,
      event: 'template:sync',
      details: { repo: result.repo, count: result.count }
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;

