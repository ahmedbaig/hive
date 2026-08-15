// PM2 process definition for the hive agent daemon on this machine.
//
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # survive reboot
//   pm2 logs hive-agent
//
// The server itself runs in Docker (docker compose up -d); only the per-machine
// agent daemon is managed here. `.cjs` because the workspace is type: module.
module.exports = {
  apps: [
    {
      name: 'hive-agent',
      script: 'packages/agent/dist/daemon.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 5000,
      // The daemon spawns Claude sessions, so it needs headroom, but a runaway
      // should be recycled rather than taking the machine down.
      max_memory_restart: '4G',
      env: {
        // The server runs in Docker on this host, so loopback is fine here.
        HIVE_URL: 'http://127.0.0.1:7777',
        HIVE_AGENT_NAME: 'workstation-pc',
        // Directory woken sessions and chat replies run in.
        HIVE_WAKE_CWD: '/home/ahmedbaig-workstation',
        HIVE_WAKE_ENABLED: '1',
        HIVE_MEMORY_SYNC: '1',
      },
      time: true,
      merge_logs: true,
    },
  ],
};
