module.exports = {
  apps: [
    {
      name: 'vpanel',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      watch: ['src', 'views'],
      ignore_watch: ['node_modules', 'storage', 'vms', '.git', 'data', 'public/uploads'],
      watch_delay: 1000,
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'storage/logs/pm2-out.log',
      error_file: 'storage/logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
