const express = require('express');
const http = require('http');
const path = require('path');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const { Server } = require('socket.io');
const config = require('./lib/config');
const logger = require('./lib/logger');
const { initDb, collections, settings } = require('./lib/db');
const { getUserFromReq } = require('./middleware/auth');
const vmService = require('./services/vmService');
const sshService = require('./services/sshService');
const bootLogService = require('./services/bootLogService');
const scheduleService = require('./services/scheduleService');
const activity = require('./services/activityService');
const { attachVncProxy } = require('./services/vncService');

const authService = require('./services/authService');

function createWebApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  const { i18nMiddleware } = require('./lib/i18n');
  app.use(i18nMiddleware);
  app.use((req, res, next) => {
    res.locals.settings = settings.all();
    res.locals.user = null;
    res.locals.uploadUrl = (p) => p ? (String(p).startsWith('http') ? p : `/uploads${String(p).startsWith('/uploads') ? '' : '/'}${p}`) : '';
    next();
  });
  app.use(express.static(path.join(config.root, 'public')));
  app.use('/uploads', express.static(path.join(config.root, 'public/uploads')));

  // expose auth for middleware
  const { optionalAuth } = require('./middleware/auth');
  app.use(optionalAuth);
  app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.token = req.cookies?.token || (req.user ? authService.generateToken(req.user) : '');
    next();
  });

  app.post('/api/locale', express.json(), (req, res) => {
    const lang = String(req.body.lang || req.body.locale || 'en').toLowerCase();
    res.cookie('vpanel_lang', lang, { maxAge: 31536000000, path: '/' });
    res.json({ ok: true, lang });
  });

  app.get('/', (req, res) => res.redirect(req.user ? '/dashboard' : '/login'));
  app.use('/api', require('./routes/api'));
  app.use('/', require('./routes/webAuth'));
  app.use('/', require('./routes/webUser'));
  app.use('/', require('./routes/webAdmin'));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('error/404', {
      code: 404, title: 'Not Found', message: 'The page you are looking for does not exist.',
      settings: settings.all(), user: req.user || null,
    });
  });
  app.use((err, req, res, next) => {
    logger.error('[panel] web error: ' + (err.stack || err.message));
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message || 'Server error' });
    res.status(500).render('error/404', {
      code: 500, title: 'Server Error', message: err.message || 'An unexpected error occurred.',
      settings: settings.all(), user: req.user || null,
    });
  });
  return app;
}

function createApiApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use('/api', require('./routes/api'));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}

function attachConsoleSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.cookie?.split(';').find((c) => c.trim().startsWith('token='))?.split('=')[1];
      const user = token ? authService.verifyToken(token) : null;
      if (!user) return next(new Error('Not authenticated'));
      socket.data.user = await authService.findById(Number(user.sub));
      if (!socket.data.user || socket.data.user.suspended) return next(new Error('Not authenticated'));
      next();
    } catch (e) {
      next(new Error('Not authenticated'));
    }
  });

  io.on('connection', (socket) => {
    socket.data.sessions = socket.data.sessions || {};

    socket.on('console:join', async (payload = {}) => {
      const vmId = payload.vmId;
      const sessionId = String(payload.sessionId || '1');
      socket.data.isLeaving = false;

      // Clean up previous session with the same ID if any
      const prevSession = socket.data.sessions[sessionId];
      if (prevSession) {
        if (prevSession.stream) { try { prevSession.stream.end(); } catch (_) {} }
        if (prevSession.conn) { try { prevSession.conn.end(); } catch (_) {} }
        delete socket.data.sessions[sessionId];
      }

      const vm = await vmService.getVm(parseInt(vmId, 10));
      if (!vm || !(await vmService.canAccess(socket.data.user, vm, 'console'))) {
        socket.emit('console:error', { sessionId, message: 'Access denied or server not found' });
        socket.emit('console:error', 'Access denied or server not found');
        return;
      }
      if (!vmService.isRunning(vm)) {
        socket.emit('console:offline', { sessionId });
        socket.emit('console:offline');
        return;
      }

      const initialCols = payload.cols || socket.data.cols || 169;
      const initialRows = payload.rows || socket.data.rows || 33;

      sshService.shellStreamWithRetry(vm, {
        maxRetries: 30,
        retryDelay: 1500,
        shouldContinue: () => socket.connected && !socket.data.isLeaving && vmService.isRunning(vm),
      })
        .then(({ conn, stream }) => {
          if (socket.data.isLeaving || !socket.connected) {
            try { stream.end(); } catch (_) {}
            try { conn.end(); } catch (_) {}
            return;
          }
          const sessionObj = { conn, stream, cols: initialCols, rows: initialRows, vmId };
          socket.data.sessions[sessionId] = sessionObj;
          if (sessionId === '1' || !socket.data.stream) {
            socket.data.stream = stream;
            socket.data.conn = conn;
          }

          socket.emit('console:ready', { sessionId, cols: initialCols, rows: initialRows });

          stream.on('data', (d) => {
            const str = d.toString('utf8');
            socket.emit('console:data', { sessionId, data: str });
            if (sessionId === '1') socket.emit('console:data', str);
          });

          const onEnd = () => {
            socket.emit('console:close', { sessionId });
            if (sessionId === '1') socket.emit('console:close');
            delete socket.data.sessions[sessionId];
            if (socket.data.stream === stream) socket.data.stream = null;
            if (socket.data.conn === conn) socket.data.conn = null;
          };

          stream.on('close', onEnd);
          stream.on('error', onEnd);
          stream.setWindow(initialRows, initialCols);
        })
        .catch((e) => {
          if (socket.data.isLeaving || !socket.connected) return;
          if (!vmService.isRunning(vm)) {
            socket.emit('console:offline', { sessionId });
            socket.emit('console:offline');
          } else {
            const errMsg = 'SSH connection failed: ' + e.message;
            socket.emit('console:error', { sessionId, message: errMsg });
            socket.emit('console:error', errMsg);
          }
        });
    });

    socket.on('console:closeSession', ({ sessionId } = {}) => {
      const sId = String(sessionId || '1');
      const sess = socket.data.sessions ? socket.data.sessions[sId] : null;
      if (sess) {
        if (sess.stream) { try { sess.stream.end(); } catch (_) {} }
        if (sess.conn) { try { sess.conn.end(); } catch (_) {} }
        delete socket.data.sessions[sId];
        if (socket.data.stream === sess.stream) socket.data.stream = null;
        if (socket.data.conn === sess.conn) socket.data.conn = null;
      }
      socket.emit('console:close', { sessionId: sId });
    });

    socket.on('console:leave', () => {
      socket.data.isLeaving = true;
      if (socket.data.sessions) {
        for (const sId of Object.keys(socket.data.sessions)) {
          const sess = socket.data.sessions[sId];
          if (sess && sess.stream) { try { sess.stream.end(); } catch (_) {} }
          if (sess && sess.conn) { try { sess.conn.end(); } catch (_) {} }
        }
        socket.data.sessions = {};
      }
      socket.data.stream = null;
      socket.data.conn = null;
    });

    socket.on('console:input', (payload) => {
      let sId = '1';
      let data = payload;
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        sId = String(payload.sessionId || '1');
        data = payload.data;
      }
      const sess = (socket.data.sessions && socket.data.sessions[sId]) || (sId === '1' ? { stream: socket.data.stream } : null);
      if (sess && sess.stream) sess.stream.write(data);
    });

    socket.on('console:resize', (payload = {}) => {
      const sId = String(payload.sessionId || '1');
      const cols = payload.cols || 169;
      const rows = payload.rows || 33;
      socket.data.cols = cols;
      socket.data.rows = rows;
      const sess = (socket.data.sessions && socket.data.sessions[sId]) || (sId === '1' ? { stream: socket.data.stream } : null);
      if (sess && sess.stream) {
        sess.cols = cols;
        sess.rows = rows;
        try { sess.stream.setWindow(rows, cols); } catch (_) {}
      }
    });

    socket.on('bootlog:join', async ({ vmId }) => {
      const vm = await vmService.getVm(parseInt(vmId, 10));
      if (!vm || !(await vmService.canAccess(socket.data.user, vm, 'console'))) {
        socket.emit('bootlog:error', 'Access denied or server not found');
        return;
      }
      if (socket.data.bootLogStream) {
        socket.data.bootLogStream.close();
        socket.data.bootLogStream = null;
      }
      socket.emit('bootlog:ready', {
        vmId: vm.id,
        status: vm.status,
        isRunning: vmService.isRunning(vm),
      });
      socket.data.bootLogStream = bootLogService.createBootLogStream(vm, {
        onData: (text, meta) => {
          socket.emit('bootlog:data', {
            text,
            init: !!meta.init,
            source: meta.source || 'boot',
            vmId: vm.id,
          });
        },
        onError: (e) => socket.emit('bootlog:error', e.message),
        onClose: () => socket.emit('bootlog:close', { vmId: vm.id }),
      });
    });

    socket.on('bootlog:leave', () => {
      if (socket.data.bootLogStream) {
        socket.data.bootLogStream.close();
        socket.data.bootLogStream = null;
      }
    });

    socket.on('bootlog:clear', async ({ vmId }) => {
      const vm = await vmService.getVm(parseInt(vmId, 10));
      if (!vm || !(await vmService.canAccess(socket.data.user, vm, 'console'))) {
        socket.emit('bootlog:error', 'Access denied or server not found');
        return;
      }
      bootLogService.clearBootLogs(vm);
      socket.emit('bootlog:cleared', { vmId: vm.id });
    });

    socket.on('disconnect', () => {
      if (socket.data.sessions) {
        for (const sId of Object.keys(socket.data.sessions)) {
          const sess = socket.data.sessions[sId];
          if (sess && sess.stream) { try { sess.stream.end(); } catch (_) {} }
          if (sess && sess.conn) { try { sess.conn.end(); } catch (_) {} }
        }
        socket.data.sessions = {};
      }
      if (socket.data.stream) { try { socket.data.stream.end(); } catch (_) {} }
      if (socket.data.conn) { try { socket.data.conn.end(); } catch (_) {} }
      if (socket.data.bootLogStream) {
        socket.data.bootLogStream.close();
        socket.data.bootLogStream = null;
      }
    });
  });
}

async function bootstrap() {
  for (const d of [
    config.vmDir,
    config.uploads.dir, config.uploads.logo, config.uploads.favicon,
    config.uploads.background, config.uploads.music, config.uploads.avatar, config.uploads.backup,
    path.join(config.root, 'data'),
    path.join(config.root, 'storage/logs'),
  ]) {
    fs.mkdirSync(d, { recursive: true });
  }

  await initDb();
  const pluginManager = require('./lib/pluginManager');
  await pluginManager.init();
  const updateService = require('./services/updateService');
  updateService.initBackgroundChecker();
  await scheduleService.loadAll();
  const templateService = require('./services/templateService');
  templateService.initDefaults().catch(e => logger.warn('[app] templateService init error: ' + e.message));
  const cacheService = require('./services/cacheService');
  cacheService.initAutoClear();

  const webApp = createWebApp();
  const apiApp = createApiApp();

  const webServer = http.createServer(webApp);
  const io = new Server(webServer, {
    maxHttpBufferSize: 1e7,
    pingInterval: 10000,
    pingTimeout: 25000,
    cors: { origin: '*' }
  });
  attachConsoleSocket(io);
  attachVncProxy(webServer);

  // Auto-seed admin if none exists
  try {
    if ((await authService.countAdmins()) === 0) {
      const username = process.env.ADMIN_USERNAME || 'admin';
      const email = process.env.ADMIN_EMAIL || 'admin@vpanel.local';
      const password = process.env.ADMIN_PASSWORD || 'admin12345';
      const user = await authService.createUser({ username, email, password, name: 'Administrator', role: 'admin', verified: true });
      await collections.users.updateOne({ id: user.id }, { $set: { root_admin: 1 } });
      logger.info(`[panel] auto-seeded initial admin: ${username} (${email})`);
    }
  } catch (e) {
    logger.warn('[panel] auto-seed admin: ' + e.message);
  }

  webServer.listen(config.panelPort, '0.0.0.0', () => {
    logger.info(`[panel] vpanel web running on http://0.0.0.0:${config.panelPort}`);
  });
  apiApp.listen(config.apiPort, '0.0.0.0', () => {
    logger.info(`[panel] vpanel API running on http://0.0.0.0:${config.apiPort}/api`);
  });

  // Autostart VMs flagged to start on boot
  setTimeout(() => vmService.startOnBootAll(), 3000);

  return { webServer, io, apiApp };
}

module.exports = { bootstrap, createWebApp, createApiApp };
