module.exports = {
    apps: [{
        name        : 'oxo-backend',
        script      : 'server.js',
        cwd         : __dirname,
        instances   : 'max',      // CPU çekirdek sayısı kadar process
        exec_mode   : 'cluster',  // HTTP istekleri otomatik dağıtılır
        watch       : false,
        max_memory_restart: '512M',

        env: {
            NODE_ENV : 'production',
            PORT     : 3001,
        },

        // Log ayarları
        log_date_format : 'YYYY-MM-DD HH:mm:ss',
        error_file      : './logs/error.log',
        out_file        : './logs/out.log',
        merge_logs      : true,

        // Crash durumunda yeniden başlat
        autorestart     : true,
        restart_delay   : 3000,
        max_restarts    : 10,
    }]
};
