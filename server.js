const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');

const PORT = 3456;
const SHARED = path.join(__dirname, 'shared');
const MEM_FILE = path.join(SHARED, 'memory.json');
const MSG_FILE = path.join(SHARED, 'messages.json');
const PLAN_FILE = path.join(SHARED, 'plan.json');
const PROGRESS_FILE = path.join(SHARED, 'progress.json');
const WORK_DIR = 'C:\\Users\\YUAN\\Desktop\\claude code';

// 初始化共享目录
for (const f of [SHARED]) if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true });
for (const [file, content] of [[MEM_FILE,'{}'],[MSG_FILE,'[]'],[PLAN_FILE,'{"items":[],"status":"idle"}'],[PROGRESS_FILE,'{"agents":{}}']]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}

// ── Agent 管理 ──
const agents = new Map();

function createAgent(id, opts = {}) {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const cwd = opts.cwd || WORK_DIR;

  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: opts.cols || 120,
    rows: opts.rows || 30,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  const agent = {
    id, proc, alive: true,
    role: opts.role || 'general',  // planner / executor / general
    label: opts.label || id,
    status: 'running',             // running / done / error
    startedAt: Date.now(),
  };
  agents.set(id, agent);

  // 更新进度
  updateProgress(id, { status: 'running', role: agent.role, label: agent.label });

  proc.onData(data => {
    broadcast({ type: 'output', id, data });

    // 自动检测状态变化
    if (data.includes('ERROR') || data.includes('error:') || data.includes('FAILED')) {
      agent.status = 'error';
      updateProgress(id, { status: 'error' });
    }
  });

  proc.onExit(({ exitCode }) => {
    agent.alive = false;
    agent.status = exitCode === 0 ? 'done' : 'error';
    updateProgress(id, { status: agent.status, exitCode });
    agents.delete(id);
    broadcast({ type: 'exit', id, code: exitCode });
  });

  return agent;
}

function stopAgent(id) {
  const agent = agents.get(id);
  if (!agent) return;
  try { agent.proc.kill(); } catch {}
  agents.delete(id);
  updateProgress(id, { status: 'stopped' });
}

function updateProgress(id, data) {
  try {
    let prog = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    prog.agents[id] = { ...prog.agents[id], ...data, updatedAt: Date.now() };
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(prog, null, 2));
    broadcast({ type: 'progress_update', data: prog });
  } catch {}
}

// ── HTTP ──
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8'));
  } else { res.writeHead(404); res.end(); }
});

// ── WebSocket ──
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', ws => {
  clients.add(ws);
  console.log(`[WS] +1 (${clients.size})`);

  // 发初始状态
  const sendFile = (file, type) => { try { ws.send(JSON.stringify({ type, data: JSON.parse(fs.readFileSync(file, 'utf-8')) })); } catch {} };
  sendFile(MEM_FILE, 'memory_update');
  sendFile(MSG_FILE, 'messages_init');
  sendFile(PLAN_FILE, 'plan_update');
  sendFile(PROGRESS_FILE, 'progress_update');

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      switch (msg.type) {
        case 'create_agent': {
          createAgent(msg.id, msg.opts || {});
          ws.send(JSON.stringify({ type: 'agent_created', id: msg.id }));
          break;
        }
        case 'input': {
          const a = agents.get(msg.id);
          if (a && a.alive) a.proc.write(msg.data);
          break;
        }
        case 'resize': {
          const a = agents.get(msg.id);
          if (a && a.alive && msg.cols && msg.rows) {
            try { a.proc.resize(msg.cols, msg.rows); } catch {}
          }
          break;
        }
        case 'stop': { stopAgent(msg.id); break; }

        // ── 共享记忆 ──
        case 'memory_write': {
          let mem = {};
          try { mem = JSON.parse(fs.readFileSync(MEM_FILE, 'utf-8')); } catch {}
          if (msg.key === null) { mem = msg.value; }
          else {
            const keys = msg.key.split('.'); let obj = mem;
            for (let i = 0; i < keys.length - 1; i++) { if (!obj[keys[i]]||typeof obj[keys[i]]!=='object') obj[keys[i]]={}; obj=obj[keys[i]]; }
            obj[keys[keys.length-1]] = msg.value;
          }
          fs.writeFileSync(MEM_FILE, JSON.stringify(mem, null, 2));
          broadcast({ type: 'memory_update', data: mem });
          break;
        }
        case 'memory_clear': {
          fs.writeFileSync(MEM_FILE, '{}');
          broadcast({ type: 'memory_update', data: {} });
          break;
        }

        // ── Plan 管理 ──
        case 'plan_update': {
          fs.writeFileSync(PLAN_FILE, JSON.stringify(msg.data, null, 2));
          broadcast({ type: 'plan_update', data: msg.data });
          break;
        }
        case 'plan_add_item': {
          let plan = { items: [] };
          try { plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8')); } catch {}
          plan.items.push(msg.item);
          fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
          broadcast({ type: 'plan_update', data: plan });
          break;
        }
        case 'plan_update_item': {
          let plan = { items: [] };
          try { plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf-8')); } catch {}
          const idx = plan.items.findIndex(i => i.id === msg.itemId);
          if (idx >= 0) { plan.items[idx] = { ...plan.items[idx], ...msg.updates }; }
          fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
          broadcast({ type: 'plan_update', data: plan });
          break;
        }

        // ── 消息 ──
        case 'message': {
          let msgs = [];
          try { msgs = JSON.parse(fs.readFileSync(MSG_FILE, 'utf-8')); } catch {}
          const entry = { from: msg.from||'user', to: msg.to||'*', text: msg.text, time: new Date().toISOString() };
          msgs.push(entry); if (msgs.length > 200) msgs = msgs.slice(-200);
          fs.writeFileSync(MSG_FILE, JSON.stringify(msgs, null, 2));
          broadcast({ type: 'message', ...entry });
          break;
        }
        case 'messages_clear': {
          fs.writeFileSync(MSG_FILE, '[]');
          broadcast({ type: 'messages_init', data: [] });
          break;
        }
      }
    } catch (err) { console.error('[ERR]', err.message); }
  });

  ws.on('close', () => { clients.delete(ws); console.log(`[WS] -1 (${clients.size})`); });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) { if (ws.readyState === 1) ws.send(data); }
}

// ── 启动 ──
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  AgentHub  http://localhost:${PORT}\n`);
  if (process.platform === 'win32') require('child_process').exec(`start http://localhost:${PORT}`);
});

process.on('SIGINT', () => { for (const [id] of agents) stopAgent(id); process.exit(0); });
