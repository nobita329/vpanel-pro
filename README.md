<div align="center">

# ⚡ vPanel Pro v3.1.1
### Enterprise-Grade QEMU/KVM Virtualization Platform with Full Arix Theme v2.1.3 Integration

[![Node.js](https://img.shields.io/badge/Node.js-v18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![QEMU](https://img.shields.io/badge/QEMU-Virtualization-FF6600?style=for-the-badge&logo=qemu&logoColor=white)](https://www.qemu.org/)
[![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![Arix Theme](https://img.shields.io/badge/Arix_Theme-v2.1.3-4A35CF?style=for-the-badge)](https://github.com/nobita329/vpanel-pro)
[![GitHub Release](https://img.shields.io/badge/Release-v3.1.1-6366F1?style=for-the-badge&logo=github)](https://github.com/nobita329/vpanel-pro/releases)
[![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)](LICENSE)

*A complete, high-performance virtualization platform featuring strict 2-Panel Separation (👑 Admin Control Plane vs 👤 Tenant User Panel), native Arix Theme v2.1.3 design system, multi-session SSH console, real-time telemetry area charts, cluster nodes, and automated CI/CD releases.*

---

</div>

## 🌟 Key Highlights & Features

### 🎨 1. Full Arix Theme v2.1.3 Design System
- **Cosmic Glassmorphism Visuals**: Clean dark-mode UI with customizable blur (`--panel-blur`), opacity (`--panel-transparency`), and glowing accent borders.
- **Ambient Themes & Backgrounds**: Integrated 4K Wallpaper browser (Anime, Space, Dark/AMOLED, Cyberpunk, Nature), custom video backgrounds (`.mp4`, `.webm`), and interactive audio cues (`online`, `offline`, `copy`).
- **Unified Navigation**: Arix responsive sidebar with active glowing indicators, collapsible state, mobile drawer, and topbar user controls.

### 🖥️ 2. Signature Arix Server Console Dashboard
- **Top Header & Spec Summary**: Displays server name, OS distro, allocated vCPUs, RAM, and SSH port.
- **Unified Power Controls**: Real-time 3-state power button group (`START` with blue active glow, `RESTART`, `STOP` with danger red glow and safety confirmations).
- **2-Column Split Console Grid**:
  - **Left (Terminal Window)**:
    - Multi-session SSH Terminal with **24/7 background persistence**.
    - 4-corner interactive mouse resize handles and quick presets (`169×33`, `Fit`, `Full`).
    - **noVNC Graphical Desktop**: Low-latency HTML5 remote framebuffer console for QEMU guests with `Ctrl+Alt+Del`.
    - **Live Boot Logs**: Real-time serial kernel streaming with AI Virtualization Diagnostics for boot failure remediation.
    - **Interactive Command Prompt Bar**: Terminal input (`» Type a command...`) supporting Enter dispatch and Up/Down history navigation.
  - **Right (7 Real-Time Stat Cards)**:
    - **Address**: Hostname & port with 1-click clipboard copy.
    - **Uptime**: Live guest uptime counter (`Xd Xh Xm Xs` / `Offline`).
    - **CPU Load**: Real-time % utilization.
    - **Memory**: Used MB vs. Total Allocated MB.
    - **Disk**: Live consumed storage vs. Virtual disk capacity.
    - **Network (Inbound)**: Live RX throughput (KiB/s).
    - **Network (Outbound)**: Live TX throughput (KiB/s).
- **Bottom 3 Telemetry Area Charts**:
  - Real-time Bézier SVG area charts for **CPU Load**, **Memory**, and **Network** (inbound/outbound dual metrics) updated every 2.5 seconds.

### 👑 3. Admin Control Plane vs. Tenant User Panel
- **Cluster Nodes Architecture**: Manage virtualization nodes, resource capacity, daemon ports, and guest allocations.
- **Virtual Machines & Storage**: Deploy VMs with cloud-init images (Ubuntu, Debian, Fedora, CentOS, AlmaLinux, Rocky Linux). Manage Local Directory, LVM, and NFS storage pools.
- **User Management & Delegation**: Subuser access control, TOTP Two-Factor Authentication (2FA), and 1-click **Admin User Impersonation** with a floating return bar.
- **MongoDB Management Studio**: Integrated Mongo-Express style database manager for collections, documents, and query execution.
- **Command Palette (`Ctrl + K`)**: Universal spotlight modal for instant server search, navigation, and power dispatch.
- **Plugin System & Webhooks**: Native integrations for **Discord Rich Embeds**, **Telegram Bot Alerts**, and outgoing signed HTTP POST webhooks.

### 🔄 4. Automated CI/CD & GitHub Actions Release
- **Automated Workflow (`.github/workflows/release.yml`)**: Automatically generates semver tags (`v3.1.1`) and publishes GitHub Releases with release notes upon pushes to `main`.

---

## 🏗️ Architecture & Stack

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        vPanel Pro Frontend                             │
│       Arix Theme v2.1.3 • EJS • Xterm.js • Socket.IO • Lucide Icons    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP / WebSocket (Port 3001)
┌───────────────────────────────────▼────────────────────────────────────┐
│                         Node.js & Express Core                         │
│     Cluster Node Orchestrator • MongoDB • Auth / RBAC • Event Plugins  │
└─────────────────┬──────────────────────────────────────┬───────────────┘
                  │                                      │
┌─────────────────▼──────────────┐     ┌─────────────────▼───────────────┐
│     QEMU Hypervisor Engine     │     │      vPanel Guest Agent         │
│   (KVM / TCG • VirtIO • VNC)   │     │   (Serial Daemon / SSH / Files) │
└────────────────────────────────┘     └─────────────────────────────────┘
```

---

## 📋 System Requirements

- **Operating System**: Linux (Ubuntu 20.04+, Debian 11+, RHEL/CentOS 9+, Fedora, Arch Linux)
- **Node.js**: v18.0.0+ (v20+ recommended)
- **Database**: MongoDB 5.0+ (or Docker container `mongo:latest`)
- **Virtualization**: QEMU (`qemu-system-x86_64`, `qemu-img`)
- **Utilities**: `cloud-image-utils` (`cloud-localds`), `wget`, `openssl`, `python3`

---

## 🚀 Installation & Quick Start

### Option 1: Automated Installer (Recommended)

```bash
# Clone the repository
git clone https://github.com/nobita329/vpanel-pro.git
cd vpanel-pro

# Interactive installation wizard
sudo bash install.sh

# Or 1-line unattended install
sudo bash install.sh --install -y --admin-user admin --admin-email admin@vpanel.local --admin-pass 'your_secure_password'
```

#### Installer CLI Options:
| Flag | Description | Default |
| :--- | :--- | :--- |
| `1`, `--install` | Full automated Debian/Ubuntu installation | - |
| `2`, `--create-admin` | Create or reset administrator account | - |
| `3`, `--update` | Pull latest updates and zero-downtime reload | - |
| `4`, `--pm2` | PM2 cluster management menu | - |
| `5`, `--uninstall` | Safe uninstaller wizard | - |
| `--admin-user <user>` | Administrator username | `admin` |
| `--admin-email <email>`| Administrator email address | `admin@vpanel.local` |
| `--admin-pass <pass>` | Administrator password | Generated random |
| `--no-pm2` | Skip PM2 daemon setup | `0` |
| `-y`, `--non-interactive` | Run without interactive prompts | `0` |

---

### Option 2: Manual Setup

```bash
# 1. Clone repository & install dependencies
git clone https://github.com/nobita329/vpanel-pro.git
cd vpanel-pro
npm install

# 2. Build assets
npm run build

# 3. Create administrator account
npm run createuser

# 4. Start vPanel Pro
npm start
```

---

### Option 3: Production Deployment with PM2

```bash
# Start cluster with automatic restarts and logging
pm2 start ecosystem.config.js

# Persist across system reboots
pm2 save
pm2 startup
```

---

### Option 4: Docker & No-KVM Mode

For environments without `/dev/kvm` hardware acceleration (cloud VPS, GitHub Codespaces, standard Docker):

```bash
# Start container using Docker Compose
docker compose up -d --build
```

Or run standalone:
```bash
docker run -d \
  --name vpanel-pro \
  --restart unless-stopped \
  -e NO_KVM=1 \
  -p 3001:3001 \
  -p 3002:3002 \
  -p 25501-25600:25501-25600 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/vms:/app/vms \
  nobita329/vpanel-pro
```

---

## 🌐 Default Ports & Access

| Service | Default URL / Port | Description |
| :--- | :--- | :--- |
| **Web Panel** | `http://<host_ip>:3001` | Arix-themed management interface & client dashboard |
| **REST API** | `http://<host_ip>:3002/api` | RESTful API & Socket.IO telemetry engine |
| **VM Port Range** | `25501 - 25600` | Dynamic host-forwarded guest SSH ports |
| **noVNC Console Range** | `25901 - 26000` | Dynamic host-forwarded guest VNC ports |
| **Agent Port Range** | `26101 - 26200` | Guest daemon communication |

---

## ⚙️ Configuration (`.env`)

```ini
# Panel Ports & URLs
PANEL_PORT=3001
API_PORT=3002
PANEL_URL=http://localhost:3001
NODE_ENV=production

# Security
JWT_SECRET=your_super_secret_jwt_key_here
JWT_EXPIRES=7d
ALLOW_REGISTER=1

# MongoDB Connection URI
MONGO_URI=mongodb://admin:password@127.0.0.1:27017/vpanel?authSource=admin

# Storage & VM Directories
VM_DIR=./vms

# Port Allocation Ranges
AUTO_PORT_MIN=25501
AUTO_PORT_MAX=25600
AUTO_VNC_PORT_MIN=25901
AUTO_VNC_PORT_MAX=26000
AUTO_AGENT_PORT_MIN=26101
AUTO_AGENT_PORT_MAX=26200
```

---

## 🔌 Core API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/login` | Authenticate and obtain JWT token |
| `GET` | `/api/vms` | List all accessible virtual machines |
| `POST` | `/api/vms/:id/action` | Trigger power actions (`start`, `stop`, `restart`, `kill`) |
| `GET` | `/api/vms/:id/status` | Fetch real-time CPU, RAM, disk, and network telemetry |
| `GET` | `/api/vms/:id/bootlog` | Retrieve kernel serial boot stream |
| `GET` | `/api/vms/:id/files?path=/` | Browse guest filesystem via agent/SSH |
| `POST` | `/api/vms/:id/files/upload` | Upload files to guest filesystem |
| `GET` | `/api/wallpapers?category=all` | Browse 4K wallpaper library |
| `POST` | `/api/wallpapers/apply` | Apply wallpaper & glassmorphism theme presets |

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.

<div align="center">
  <sub>Built with ❤️ by <a href="https://github.com/nobita329">Nobita</a> & contributors.</sub>
</div>
