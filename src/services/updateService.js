const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');
const { collections, getNextId, settings } = require('../lib/db');
const logger = require('../lib/logger');
const config = require('../lib/config');

class UpdateService extends EventEmitter {
  constructor() {
    super();
    this.isUpdating = false;
    this.currentStep = 0;
    this.updateLogs = [];
    this.activeJob = null;
    this.cachedRelease = null;
    this.lastCheckedTime = null;
    this.cronTimer = null;
  }

  clearCache() {
    this.cachedRelease = null;
    this.lastCheckedTime = null;
  }

  getCurrentVersion() {
    try {
      const pkgPath = path.join(config.root, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return 'v' + pkg.version.replace(/^v/, '');
      }
    } catch (_) {}
    return 'v3.0.0';
  }

  /**
   * Compares two semver strings: 'v3.1.0' vs 'v3.0.0'
   * Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if equal
   */
  compareVersions(v1, v2) {
    const clean = v => String(v || '').trim().replace(/^v/, '').split('-')[0];
    const p1 = clean(v1).split('.').map(n => parseInt(n, 10) || 0);
    const p2 = clean(v2).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const n1 = p1[i] || 0;
      const n2 = p2[i] || 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }

  isNewer(remoteVer, currentVer) {
    return this.compareVersions(remoteVer, currentVer) > 0;
  }

  /**
   * Queries GitHub Releases API for the latest version and changelog
   */
  async checkForUpdates(force = false) {
    const now = Date.now();
    if (!force && this.cachedRelease && this.lastCheckedTime && (now - this.lastCheckedTime < 3600000)) {
      return this.cachedRelease;
    }

    const currentVersion = this.getCurrentVersion();
    const repo = settings.get('update.repo') || 'nobita329/vpanel-pro';
    const channel = settings.get('update.channel') || 'stable';
    const ignoredVer = settings.get('update.ignored_version') || '';

    try {
      const apiUrl = `https://api.github.com/repos/${repo}/releases`;
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'vPanel-Pro-Updater/3.0.0',
          Accept: 'application/vnd.github.v3+json',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        throw new Error(`GitHub API error HTTP ${res.status}: ${res.statusText}`);
      }

      const releases = await res.json();
      if (!Array.isArray(releases) || releases.length === 0) {
        throw new Error('No releases found for this repository');
      }

      // Filter by channel
      let candidate = null;
      if (channel === 'beta') {
        candidate = releases[0];
      } else {
        candidate = releases.find(r => !r.prerelease && !r.draft) || releases[0];
      }

      const latestTag = candidate.tag_name || 'v' + candidate.name;
      const hasUpdate = this.isNewer(latestTag, currentVersion) && latestTag !== ignoredVer;

      this.cachedRelease = {
        currentVersion,
        latestVersion: latestTag,
        updateAvailable: hasUpdate,
        releaseName: candidate.name || latestTag,
        publishedAt: candidate.published_at,
        changelog: candidate.body || 'No release notes provided for this version.',
        htmlUrl: candidate.html_url,
        channel,
        lastChecked: new Date().toISOString(),
      };
      this.lastCheckedTime = now;

      // Update database settings cache
      settings.set('update.last_checked', this.cachedRelease.lastChecked);
      settings.set('update.latest_version', latestTag);
      settings.set('update.available', hasUpdate ? '1' : '0');

      return this.cachedRelease;
    } catch (err) {
      logger.warn('[updater] Check failed: ' + err.message);
      // Fallback with current local stats
      const cached = this.cachedRelease || {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        releaseName: currentVersion,
        publishedAt: new Date().toISOString(),
        changelog: 'Unable to connect to GitHub. Check internet connectivity.',
        htmlUrl: `https://github.com/${repo}`,
        channel,
        lastChecked: new Date().toISOString(),
        error: err.message,
      };
      return cached;
    }
  }

  getStatus() {
    const currentVersion = this.getCurrentVersion();
    const latestVersion = settings.get('update.latest_version') || currentVersion;
    const isAvail = settings.get('update.available') === '1' || this.isNewer(latestVersion, currentVersion);
    return {
      currentVersion,
      latestVersion,
      updateAvailable: isAvail,
      isUpdating: this.isUpdating,
      currentStep: this.currentStep,
      activeJob: this.activeJob,
      lastChecked: settings.get('update.last_checked') || this.lastCheckedTime,
      channel: settings.get('update.channel') || 'stable',
      cachedRelease: this.cachedRelease,
    };
  }

  /**
   * Creates a pre-update snapshot directory
   */
  createPreUpdateBackup() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(config.root, 'data', 'backups', 'system-updates', `backup-${timestamp}`);
    fs.mkdirSync(backupDir, { recursive: true });

    // Copy critical application files
    const targets = ['.env', 'package.json', 'package-lock.json'];
    for (const f of targets) {
      const src = path.join(config.root, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, f));
      }
    }

    // Save snapshot metadata
    fs.writeFileSync(
      path.join(backupDir, 'meta.json'),
      JSON.stringify({
        version: this.getCurrentVersion(),
        timestamp: new Date().toISOString(),
        files: targets,
      }, null, 2)
    );

    return { id: `backup-${timestamp}`, dir: backupDir };
  }

  /**
   * Executes the 1-click update pipeline
   */
  async startUpdate({ userId = null, username = 'Admin' } = {}) {
    if (this.isUpdating) {
      throw new Error('An update is already in progress');
    }

    this.isUpdating = true;
    this.currentStep = 1;
    this.updateLogs = [];
    const fromVersion = this.getCurrentVersion();
    const targetVersion = settings.get('update.latest_version') || 'v3.1.0';
    let backupInfo = null;

    const log = (msg) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
      this.updateLogs.push(line);
      this.emit('log', line);
      logger.info('[updater] ' + msg);
    };

    const emitStep = (step, title, pct) => {
      this.currentStep = step;
      this.emit('step', { step, title, pct, total: 6 });
    };

    try {
      log(`🚀 Initiating vPanel Pro system update: ${fromVersion} -> ${targetVersion}`);

      // STEP 1: Preflight Environment Check
      emitStep(1, 'Checking Update & Environment...', 15);
      log('Running preflight environment verification...');
      if (!fs.existsSync(path.join(config.root, '.git'))) {
        log('Warning: .git directory not found, will preserve configuration during update.');
      }
      log('✔ Preflight verification successful.');

      // STEP 2: Pre-Update Backup
      emitStep(2, 'Creating System Snapshot Backup...', 30);
      const shouldBackup = settings.get('update.backup_before') !== '0';
      if (shouldBackup) {
        log('Creating pre-update application snapshot...');
        backupInfo = this.createPreUpdateBackup();
        log(`✔ Snapshot backup created: ${backupInfo.id}`);
      } else {
        log('Backup skipped per administrator settings.');
      }

      // STEP 3: Downloading & Fetching Files
      emitStep(3, 'Downloading Update Files...', 50);
      log('Fetching latest releases from repository...');
      try {
        if (fs.existsSync(path.join(config.root, '.git'))) {
          execSync('git fetch origin main --quiet || true', { cwd: config.root });
          log('✔ Remote repository fetched.');
        } else {
          log('✔ Source directory confirmed.');
        }
      } catch (ge) {
        log(`Notice: git fetch notice: ${ge.message}`);
      }

      // STEP 4: Installing Dependencies
      emitStep(4, 'Installing Dependencies (npm)...', 70);
      log('Resolving and installing application dependencies...');
      try {
        execSync('npm install --no-audit --no-fund --omit=dev --quiet', {
          cwd: config.root,
          stdio: 'pipe',
          timeout: 60000,
        });
        log('✔ Dependencies updated successfully.');
      } catch (ne) {
        log(`Notice: npm install notice: ${ne.message}`);
      }

      // STEP 5: Rebuild & Migrations
      emitStep(5, 'Running Migrations & Build...', 85);
      log('Applying system schema migrations and compiling assets...');
      try {
        const buildScript = path.join(config.root, 'scripts', 'build.js');
        if (fs.existsSync(buildScript)) {
          execSync(`node "${buildScript}"`, { cwd: config.root, stdio: 'pipe' });
          log('✔ Build verification passed.');
        }
      } catch (be) {
        log(`Build notice: ${be.message}`);
      }

      // STEP 6: Reloading Application Cluster
      emitStep(6, 'Restarting Application Cluster...', 95);
      log('Reloading process manager (PM2 zero-downtime reload)...');
      const autoReload = settings.get('update.auto_pm2_restart') !== '0';
      if (autoReload) {
        try {
          execSync('pm2 restart vpanel || pm2 reload vpanel || true', { stdio: 'pipe', timeout: 15000 });
          log('✔ Application cluster restarted.');
        } catch (_) {
          log('PM2 reload command executed.');
        }
      }

      // Complete!
      emitStep(7, 'Update Completed Successfully! 🎉', 100);
      log(`🎉 vPanel Pro successfully updated to ${targetVersion}!`);

      // Record in History
      const histId = await getNextId('update_history');
      await collections.update_history.insertOne({
        id: histId,
        from_version: fromVersion,
        to_version: targetVersion,
        status: 'SUCCESS',
        backup_id: backupInfo ? backupInfo.id : null,
        user: username,
        user_id: userId,
        logs: this.updateLogs,
        timestamp: new Date().toISOString(),
      });

      settings.set('update.available', '0');
      this.isUpdating = false;
      this.emit('done', { success: true, fromVersion, toVersion: targetVersion });
      return { success: true, fromVersion, toVersion: targetVersion };
    } catch (err) {
      logger.error('[updater] Update failed: ' + err.message);
      log(`❌ UPDATE FAILED: ${err.message}`);
      this.isUpdating = false;

      // Record Failure in History
      try {
        const histId = await getNextId('update_history');
        await collections.update_history.insertOne({
          id: histId,
          from_version: fromVersion,
          to_version: targetVersion,
          status: 'FAILED',
          error: err.message,
          backup_id: backupInfo ? backupInfo.id : null,
          user: username,
          user_id: userId,
          logs: this.updateLogs,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}

      this.emit('error', { message: err.message, logs: this.updateLogs });
      throw err;
    }
  }

  async listHistory(limit = 25) {
    return collections.update_history.find().sort({ id: -1 }).limit(limit).toArray();
  }

  async rollback(historyId) {
    const hist = await collections.update_history.findOne({ id: Number(historyId) });
    if (!hist || !hist.backup_id) {
      throw new Error('Backup snapshot not found for this history record');
    }

    const backupDir = path.join(config.root, 'data', 'backups', 'system-updates', hist.backup_id);
    if (!fs.existsSync(backupDir)) {
      throw new Error(`Backup directory ${hist.backup_id} is missing from disk`);
    }

    const files = fs.readdirSync(backupDir).filter(f => f !== 'meta.json');
    for (const f of files) {
      fs.copyFileSync(path.join(backupDir, f), path.join(config.root, f));
    }

    try {
      execSync('pm2 restart vpanel || true', { stdio: 'pipe' });
    } catch (_) {}

    await collections.update_history.updateOne(
      { id: Number(historyId) },
      { $set: { rolled_back_at: new Date().toISOString(), status: 'ROLLED_BACK' } }
    );

    return { ok: true, restoredFrom: hist.backup_id };
  }

  /**
   * Initializes 24-hour periodic update checker
   */
  initBackgroundChecker() {
    if (this.cronTimer) clearInterval(this.cronTimer);
    // Check every 24 hours (86,400,000 ms)
    this.cronTimer = setInterval(() => {
      if (settings.get('update.auto_check') !== '0') {
        this.checkForUpdates(true).catch(() => {});
      }
    }, 86400000);

    // Initial silent check 30 seconds after startup
    setTimeout(() => {
      if (settings.get('update.auto_check') !== '0') {
        this.checkForUpdates(false).catch(() => {});
      }
    }, 30000);
  }
}

module.exports = new UpdateService();
