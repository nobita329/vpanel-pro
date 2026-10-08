const { MongoClient } = require('mongodb');
const config = require('./config');
const logger = require('./logger');

const client = new MongoClient(config.mongoUri, {
  maxPoolSize: 20,
  minPoolSize: 2,
  serverSelectionTimeoutMS: 5000,
});

let dbInstance = null;
let connectingPromise = null;
const collections = {};
const settingsCache = {};

async function getNextId(name) {
  await ensureConnected();
  let maxId = 0;
  try {
    if (collections[name]) {
      const highest = await collections[name]
        .find({ id: { $type: 'number' } })
        .sort({ id: -1 })
        .limit(1)
        .toArray();
      if (highest.length > 0 && typeof highest[0].id === 'number') {
        maxId = highest[0].id;
      }
    }
  } catch (_) {}

  const ret = await collections.counters.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  let nextSeq = typeof ret.seq === 'number' ? ret.seq : (ret.value?.seq || 1);
  if (nextSeq <= maxId) {
    nextSeq = maxId + 1;
    await collections.counters.updateOne({ _id: name }, { $set: { seq: nextSeq } });
  }
  return nextSeq;
}

const defaultSettings = {
  'panel.name': 'vpanel',
  'panel.logo_mode': 'url',
  'panel.logo_url': '',
  'panel.logo_file': '',
  'panel.favicon_name': 'vpanel',
  'panel.favicon_mode': 'url',
  'panel.favicon_url': '',
  'panel.favicon_file': '',
  'panel.bg_mode': 'color',
  'panel.bg_color': '#000000',
  'panel.bg_url': '',
  'panel.bg_file': '',
  'panel.bg_video_file': '',
  'panel.bg_video_url': '',
  'panel.bg_cover': '1',
  'panel.bg_overlay': '0.55',
  'panel.music_mode': 'none',
  'panel.music_url': '',
  'panel.music_file': '',
  'panel.music_youtube': '',
  'panel.music_autoplay': '0',
  'panel.music_loop': '1',
  'panel.music_volume': '35',
  'panel.navbar_style': 'glass',
  'panel.navbar_transparent': '1',
  'panel.navbar_blur': '1',
  'panel.accent': '#38bdf8',
  'panel.theme': 'dark',
  'panel.wallpapers_api_key': '',
  'billing.currency': 'USD',
  'billing.currency_symbol': '$',
  'billing.stripe_enabled': '0',
  'billing.paypal_enabled': '0',
  'billing.bank_transfer_enabled': '1',
  'billing.bank_details': 'Bank: Global Cloud Bank\nAccount: 0123-4567-8901\nRouting/IFSC: GCB000452',
  'ai.enabled': '1',
  'ai.provider': 'offline',
  'ai.api_key': '',
  'ai.model': 'gpt-4o-mini',
  'update.channel': 'stable',
  'update.auto_check': '1',
  'update.backup_before': '1',
  'update.auto_pm2_restart': '1',
  'update.repo': 'nobita329/vpanel-pro',
  'update.last_checked': '',
  'update.latest_version': '',
  'update.available': '0',
  'update.ignored_version': '',
  'mail.host': config.mail.host,
  'mail.port': String(config.mail.port),
  'mail.secure': String(config.mail.secure),
  'mail.user': config.mail.user,
  'mail.pass': config.mail.pass,
  'mail.from': config.mail.from,
  'mail.verify': String(Boolean(config.mail.host)),
  'security.allow_register': config.allowRegister ? '1' : '0',
  'security.require_verify': '0',
  'security.force_tfa': '0',
  'vm.auto_port_min': String(config.autoPortMin),
  'vm.auto_port_max': String(config.autoPortMax),
  'vm.vnc_port_min': String(config.autoVncPortMin),
  'vm.vnc_port_max': String(config.autoVncPortMax),
  'vm.agent_port_min': String(config.autoAgentPortMin),
  'vm.agent_port_max': String(config.autoAgentPortMax),
  'vm.default_memory': '2048',
  'vm.default_cpus': '2',
  'vm.default_disk': '20G',
  'vm.default_os': 'Ubuntu 24.04',
  'vm.os_list': JSON.stringify([
    ['Ubuntu 22.04', 'ubuntu', 'jammy', 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Ubuntu 24.04', 'ubuntu', 'noble', 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img', 'ubuntu', 'root'],
    ['Debian 11', 'debian', 'bullseye', 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.qcow2', 'debian', 'root'],
    ['Debian 12', 'debian', 'bookworm', 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.qcow2', 'debian', 'root'],
    ['Debian 13', 'debian', 'trixie', 'https://cloud.debian.org/images/cloud/trixie/daily/latest/debian-13-generic-amd64-daily.qcow2', 'debian', 'root'],
    ['Fedora 40', 'fedora', '40', 'https://download.fedoraproject.org/pub/fedora/linux/releases/40/Cloud/x86_64/images/Fedora-Cloud-Base-40-1.14.x86_64.qcow2', 'fedora', 'root'],
    ['CentOS Stream 9', 'centos', 'stream9', 'https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-GenericCloud-9-latest.x86_64.qcow2', 'centos', 'root'],
    ['AlmaLinux 9', 'almalinux', '9', 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2', 'almalinux', 'root'],
    ['Rocky Linux 9', 'rockylinux', '9', 'https://download.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud.latest.x86_64.qcow2', 'rocky', 'root']
  ]),
  'vm.template_repo': 'https://github.com/nobita329/Template.git',
  'user.default_cpu_cores': '8',
  'user.default_ram_mb': '8192',
  'user.default_disk_gb': '100',
  'user.default_bandwidth_gb': '1000',
  'user.default_ipv4': '2',
  'user.default_snapshots': '5',
  'user.default_backups': '10',
  'cache.auto_clear_enabled': '1',
  'cache.auto_clear_interval': '6h',
  'cache.last_cleared': '',
  'cache.total_clears': '0',
};

for (const [k, v] of Object.entries(defaultSettings)) {
  settingsCache[k] = v;
}

const S = {
  get(key, fallback = null) {
    if (key in settingsCache) {
      const val = settingsCache[key];
      try { return JSON.parse(val); } catch (_) { return val; }
    }
    return fallback;
  },
  async set(key, value) {
    await ensureConnected();
    const valStr = typeof value === 'string' ? value : JSON.stringify(value);
    settingsCache[key] = valStr;
    await collections.settings.updateOne(
      { key },
      { $set: { key, value: valStr } },
      { upsert: true }
    );
  },
  all() {
    const out = {};
    for (const [k, v] of Object.entries(settingsCache)) {
      try { out[k] = JSON.parse(v); } catch (_) { out[k] = v; }
    }
    return out;
  },
  async reload() {
    await ensureConnected();
    const allDocs = await collections.settings.find().toArray();
    for (const [k, v] of Object.entries(defaultSettings)) {
      settingsCache[k] = v;
    }
    for (const doc of allDocs) {
      settingsCache[doc.key] = doc.value;
    }
    return Object.keys(settingsCache).length;
  },
};

async function initDb() {
  if (dbInstance) return { db: dbInstance, collections, settings: S, getNextId };
  await client.connect();
  dbInstance = client.db('vpanel');

  const names = [
    'users', 'vms', 'subusers', 'backups', 'schedules',
    'activity_logs', 'settings', 'login_attempts', 'reset_tokens',
    'notifications', 'counters',
    'storage_pools', 'storage_volumes', 'iso_images',
    'network_bridges', 'ip_pools', 'port_forwards', 'firewall_rules',
    'api_keys', 'webhooks', 'audit_events', 'plugins_config',
    'billing_plans', 'billing_invoices', 'billing_coupons',
    'update_history', 'quotas', 'templates', 'user_sessions',
    'nodes', 'node_allocations', 'locations'
  ];
  for (const name of names) {
    collections[name] = dbInstance.collection(name);
  }

  try {
    await Promise.all([
      collections.user_sessions.createIndex({ session_id: 1 }, { unique: true }),
      collections.user_sessions.createIndex({ user_id: 1 }),
      collections.user_sessions.createIndex({ last_active_at: -1 }),
      collections.templates.createIndex({ vmid: 1 }, { unique: true, sparse: true }),
      collections.templates.createIndex({ id: 1 }, { unique: true }),
      collections.users.createIndex({ id: 1 }, { unique: true }),
      collections.users.createIndex({ username: 1 }, { unique: true }),
      collections.users.createIndex({ email: 1 }, { unique: true }),
      collections.vms.createIndex({ id: 1 }, { unique: true }),
      collections.vms.createIndex({ uuid: 1 }, { unique: true }),
      collections.vms.createIndex({ owner_id: 1 }),
      collections.subusers.createIndex({ id: 1 }, { unique: true }),
      collections.subusers.createIndex({ vm_id: 1 }),
      collections.subusers.createIndex({ user_id: 1 }),
      collections.backups.createIndex({ id: 1 }, { unique: true }),
      collections.backups.createIndex({ vm_id: 1 }),
      collections.schedules.createIndex({ id: 1 }, { unique: true }),
      collections.schedules.createIndex({ vm_id: 1 }),
      collections.activity_logs.createIndex({ id: 1 }, { unique: true }),
      collections.activity_logs.createIndex({ user_id: 1 }),
      collections.activity_logs.createIndex({ vm_id: 1 }),
      collections.activity_logs.createIndex({ created_at: -1 }),
      collections.settings.createIndex({ key: 1 }, { unique: true }),
      collections.login_attempts.createIndex({ ip: 1 }),
      collections.reset_tokens.createIndex({ token: 1 }),
      collections.notifications.createIndex({ user_id: 1 }),
      collections.storage_pools.createIndex({ id: 1 }, { unique: true }),
      collections.storage_volumes.createIndex({ id: 1 }, { unique: true }),
      collections.iso_images.createIndex({ id: 1 }, { unique: true }),
      collections.firewall_rules.createIndex({ id: 1 }, { unique: true }),
      collections.port_forwards.createIndex({ id: 1 }, { unique: true }),
      collections.api_keys.createIndex({ key: 1 }, { unique: true }),
      collections.webhooks.createIndex({ id: 1 }, { unique: true }),
      collections.audit_events.createIndex({ timestamp: -1 }),
      collections.billing_plans.createIndex({ id: 1 }, { unique: true }),
      collections.billing_invoices.createIndex({ id: 1 }, { unique: true }),
      collections.billing_coupons.createIndex({ id: 1 }, { unique: true }),
      collections.update_history.createIndex({ id: 1 }, { unique: true }),
      collections.update_history.createIndex({ timestamp: -1 }),
    ]);
  } catch (e) {
    logger.warn('[mongo] index creation: ' + e.message);
  }

  try {
    const all = await collections.settings.find().toArray();
    for (const row of all) {
      settingsCache[row.key] = row.value;
    }
    for (const [k, v] of Object.entries(defaultSettings)) {
      if (!(k in settingsCache)) {
        await collections.settings.insertOne({ key: k, value: v });
        settingsCache[k] = v;
      }
    }
  } catch (e) {
    logger.warn('[mongo] settings cache init: ' + e.message);
  }

  return { db: dbInstance, collections, settings: S, getNextId };
}

function ensureConnected() {
  if (dbInstance) return Promise.resolve(dbInstance);
  if (!connectingPromise) {
    connectingPromise = initDb()
      .then(() => dbInstance)
      .catch((err) => {
        connectingPromise = null;
        throw err;
      });
  }
  return connectingPromise;
}

ensureConnected().catch((err) => {
  logger.error('[mongo] connection error: ' + err.message);
});

async function closeDb() {
  try {
    await client.close();
  } catch (_) {}
  dbInstance = null;
  connectingPromise = null;
}

module.exports = {
  client,
  get db() { return dbInstance; },
  collections,
  getNextId,
  initDb,
  closeDb,
  settings: S,
  ensureConnected,
};
