const cron = require('node-cron');
const { collections, settings } = require('../lib/db');
const logger = require('../lib/logger');
const wallpaperService = require('./wallpaperService');
const updateService = require('./updateService');

let cronTask = null;

function intervalToCron(interval) {
  const norm = String(interval || '6h').toLowerCase().trim();
  switch (norm) {
    case '30m':
      return '*/30 * * * *';
    case '1h':
      return '0 * * * *';
    case '2h':
      return '0 */2 * * *';
    case '6h':
      return '0 */6 * * *';
    case '12h':
      return '0 */12 * * *';
    case '24h':
    case 'daily':
      return '0 0 * * *';
    default:
      return '0 */6 * * *';
  }
}

async function clearAllCaches(source = 'manual') {
  logger.info(`[cache] Clearing all system caches (source: ${source})...`);
  let wpCleared = 0;
  if (typeof wallpaperService.clearCache === 'function') {
    wpCleared = wallpaperService.clearCache();
  }

  if (typeof updateService.clearCache === 'function') {
    updateService.clearCache();
  }

  // Reload database settings cache
  if (typeof settings.reload === 'function') {
    await settings.reload();
  }

  let prunedSessions = 0;
  let prunedTokens = 0;
  let prunedAttempts = 0;

  try {
    if (collections.user_sessions) {
      // Prune inactive sessions older than 7 days
      const sessionCutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      const resSess = await collections.user_sessions.deleteMany({ last_active_at: { $lt: sessionCutoff } });
      prunedSessions = resSess.deletedCount || 0;
    }

    if (collections.reset_tokens) {
      // Prune password reset tokens older than 24 hours
      const tokenCutoff = new Date(Date.now() - 24 * 3600000).toISOString();
      const resTok = await collections.reset_tokens.deleteMany({ created_at: { $lt: tokenCutoff } });
      prunedTokens = resTok.deletedCount || 0;
    }

    if (collections.login_attempts) {
      // Prune login attempts older than 30 days
      const logCutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const resAtt = await collections.login_attempts.deleteMany({ created_at: { $lt: logCutoff } });
      prunedAttempts = resAtt.deletedCount || 0;
    }
  } catch (err) {
    logger.warn('[cache] Error pruning database collections: ' + err.message);
  }

  // Suggest node garbage collection if exposed
  if (typeof global.gc === 'function') {
    try { global.gc(); } catch (_) {}
  }

  const now = new Date().toISOString();
  await settings.set('cache.last_cleared', now);
  const currentTotal = parseInt(settings.get('cache.total_clears') || 0, 10);
  const totalClears = currentTotal + 1;
  await settings.set('cache.total_clears', String(totalClears));

  logger.info(`[cache] Cache clear complete: ${wpCleared} wallpaper queries, ${prunedSessions} expired sessions, ${prunedTokens} tokens pruned.`);

  return {
    ok: true,
    source,
    cleared_at: now,
    total_clears: totalClears,
    memory: process.memoryUsage(),
    details: {
      wallpapers_cleared: wpCleared,
      sessions_pruned: prunedSessions,
      tokens_pruned: prunedTokens,
      login_attempts_pruned: prunedAttempts,
    }
  };
}

async function getCacheStatus() {
  const mem = process.memoryUsage();
  let sessionCount = 0;
  try {
    if (collections.user_sessions) {
      sessionCount = await collections.user_sessions.countDocuments();
    }
  } catch (_) {}

  return {
    auto_clear_enabled: settings.get('cache.auto_clear_enabled') !== '0',
    auto_clear_interval: settings.get('cache.auto_clear_interval') || '6h',
    last_cleared: settings.get('cache.last_cleared') || 'Never',
    total_clears: parseInt(settings.get('cache.total_clears') || 0, 10),
    memory: {
      heap_used: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total: Math.round(mem.heapTotal / 1024 / 1024),
      rss: Math.round(mem.rss / 1024 / 1024),
      external: Math.round(mem.external / 1024 / 1024),
    },
    wallpaper_cache_size: typeof wallpaperService.getCacheSize === 'function' ? wallpaperService.getCacheSize() : 0,
    active_sessions: sessionCount,
    total_settings: Object.keys(settings.all()).length,
  };
}

function initAutoClear() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  const enabled = settings.get('cache.auto_clear_enabled') !== '0';
  if (!enabled) {
    logger.info('[cache] Auto cache clear is disabled');
    return;
  }

  const interval = settings.get('cache.auto_clear_interval') || '6h';
  const cronExpr = intervalToCron(interval);

  try {
    cronTask = cron.schedule(cronExpr, async () => {
      try {
        await clearAllCaches('auto_scheduled');
      } catch (err) {
        logger.error('[cache] Scheduled auto cache clear error: ' + err.message);
      }
    });
    logger.info(`[cache] Auto cache clear scheduled with interval "${interval}" (${cronExpr})`);
  } catch (err) {
    logger.error(`[cache] Failed to schedule auto cache clear: ${err.message}`);
  }
}

async function updateConfig({ enabled, interval }) {
  if (enabled !== undefined) {
    await settings.set('cache.auto_clear_enabled', enabled ? '1' : '0');
  }
  if (interval !== undefined && typeof interval === 'string') {
    await settings.set('cache.auto_clear_interval', interval.toLowerCase().trim());
  }

  initAutoClear();
  return getCacheStatus();
}

module.exports = {
  intervalToCron,
  clearAllCaches,
  getCacheStatus,
  initAutoClear,
  updateConfig,
};

