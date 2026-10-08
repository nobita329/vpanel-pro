const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const MODULE_REGISTRY = [
  {
    slug: 'mongodb',
    name: 'MongoDB Studio',
    category: 'Database Management',
    description: 'Complete Mongo Express style database, collection, document and query console manager',
    icon: 'database',
    route: '/admin/mongodb',
    version: '1.0.0',
    enabled: true,
    isCore: true,
  },
  {
    slug: 'storage',
    name: 'Storage Pools & ISO Library',
    category: 'Infrastructure',
    description: 'Manage Local, LVM and NFS storage pools, virtual volumes, and cloud ISO downloads',
    icon: 'hard-drive',
    route: '/admin/storage',
    version: '1.0.0',
    enabled: true,
    isCore: true,
  },
  {
    slug: 'network',
    name: 'Network & Firewall',
    category: 'Infrastructure',
    description: 'Bridge interfaces, IP pools, DHCP/DNS, NAT port forwarding, and virtual firewall rules',
    icon: 'network',
    route: '/admin/network',
    version: '1.0.0',
    enabled: true,
    isCore: true,
  },
  {
    slug: 'api_manager',
    name: 'API & Webhooks Manager',
    category: 'Integration',
    description: 'Scoped API key generation, rate limiting, and event webhook subscriptions',
    icon: 'key',
    route: '/admin/api',
    version: '1.0.0',
    enabled: true,
    isCore: true,
  },
  {
    slug: 'audit',
    name: 'Audit & Security Center',
    category: 'Security',
    description: 'Comprehensive audit trails, login history breakdown, and security incident tracking',
    icon: 'shield',
    route: '/admin/audit',
    version: '1.0.0',
    enabled: true,
    isCore: true,
  },
  {
    slug: 'monitoring',
    name: 'Cluster Monitoring',
    category: 'Observability',
    description: 'Real-time host node and VM telemetry, rolling waveforms, and health metrics',
    icon: 'activity',
    route: '/admin/nodes',
    version: '1.0.0',
    enabled: true,
    isCore: true,
  },
  {
    slug: 'updates',
    name: 'System Updates',
    category: 'System',
    description: 'Automated GitHub release checker, snapshot backups, and zero-downtime cluster reloader',
    icon: 'refresh-cw',
    route: '/admin/updates',
    version: '1.0.0',
    enabled: true,
    isCore: true,
  },
];

class ModuleLoader {
  constructor() {
    this.modules = new Map();
    MODULE_REGISTRY.forEach(m => this.modules.set(m.slug, { ...m }));
  }

  listModules() {
    return Array.from(this.modules.values());
  }

  getModule(slug) {
    return this.modules.get(slug) || null;
  }

  toggleModule(slug, enabled) {
    const mod = this.modules.get(slug);
    if (!mod) throw new Error(`Module '${slug}' not found`);
    if (mod.isCore && !enabled) {
      throw new Error(`Core module '${mod.name}' cannot be disabled`);
    }
    mod.enabled = Boolean(enabled);
    return mod;
  }
}

module.exports = new ModuleLoader();
