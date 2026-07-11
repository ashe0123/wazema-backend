/**
 * PM2 Ecosystem Configuration for Production
 * Enables cluster mode for horizontal scaling across CPU cores
 * Recommended for 2000+ users
 */
module.exports = {
  apps: [{
    name: 'wazema-api',
    script: './server.js',
    
    // Cluster mode - runs multiple instances (1 per CPU core)
    instances: process.env.PM2_INSTANCES || 'max', // 'max' = all CPU cores, or set to specific number like 4
    exec_mode: 'cluster',
    
    // Environment variables
    env: {
      NODE_ENV: 'production',
      PORT: 3002,
    },
    
    // Auto-restart configuration
    watch: false,
    max_memory_restart: '500M', // Restart if memory exceeds 500MB
    
    // Error handling
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Logging
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Advanced PM2 features
    instance_var: 'INSTANCE_ID',
    
    // Health monitoring
    cron_restart: '0 3 * * *', // Restart daily at 3 AM
  }],
  
  // Deployment configuration (optional)
  deploy: {
    production: {
      user: 'deploy',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:your-org/wazema.git',
      path: '/var/www/wazema',
      'post-deploy': 'cd backend && npm install && pm2 reload ecosystem.config.js',
      env: {
        NODE_ENV: 'production'
      }
    }
  }
};
