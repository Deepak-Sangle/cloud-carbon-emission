module.exports = {
  apps: [
    {
      name: "ccf-api",
      script: "dist/server.js",
      cwd: "./packages/api",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      log_file: "./logs/combined.log",
      time: true,
      // Restart strategies
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 10000,
    },
    {
      name: "ccf-sync-cron",
      script: "npx",
      args: "ts-node-dev --respawn=false src/jobs/syncAllFootprints.ts",
      cwd: "./packages/api",
      cron_restart: "0 22 * * *", // Run every day at 22:00
      autorestart: false, // Don't restart on crash, only on cron
      watch: false,
      error_file: "./logs/cron-err.log",
      out_file: "./logs/cron-out.log",
      log_file: "./logs/cron-combined.log",
      time: true,
    },
  ],
};
