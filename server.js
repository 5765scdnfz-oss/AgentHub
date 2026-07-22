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

// ── Claude API 配置 ──
const CLAUDE_API = {
  baseUrl: process.env.ANTHROPIC_BASE_URL || 'https://token-plan-cn.xiaomimimo.com/anthropic',
  apiKey: process.env.ANTHROPIC_AUTH_TOKEN || 'tp-c79bek9lv4lqcgexiyyrgn03jvd4tkjlicpi8xs44y9r0g4f',
  model: 'mimo-v2.5-pro',
};

// 初始化共享目录
for (const f of [SHARED]) if (!fs.existsSync(f)) fs.mkdirSync(f, { recursive: true });
for (const [file, content] of [[MEM_FILE,'{}'],[MSG_FILE,'[]'],[PLAN_FILE,'{"items":[],"status":"idle"}'],[PROGRESS_FILE,'{"agents":{}}']]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}

// ── 工具函数 ──
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return {}; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── Agent 管理（PTY 终端）──
const agents = new Map();

function createAgent(id, opts = {}) {
  // 如果是 claude 类型，走 API
  if (opts.type === 'claude') return createClaudeAgent(id, opts);

  const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color', cols: opts.cols || 120, rows: opts.rows || 30,
    cwd: opts.cwd || WORK_DIR, env: { ...process.env, TERM: 'xterm-256color' },
  });

  const agent = { id, proc, alive: true, type: 'terminal', role: opts.role || 'general', label: opts.label || id, status: 'running', startedAt: Date.now() };
  agents.set(id, agent);
  updateProgress(id, { status: 'running', role: agent.role, label: agent.label });

  proc.onData(data => {
    broadcast({ type: 'output', id, data });
    if (data.includes('ERROR') || data.includes('error:') || data.includes('FAILED')) {
      agent.status = 'error'; updateProgress(id, { status: 'error' });
    }
  });

  proc.onExit(({ exitCode }) => {
    agent.alive = false; agent.status = exitCode === 0 ? 'done' : 'error';
    updateProgress(id, { status: agent.status, exitCode });
    agents.delete(id); broadcast({ type: 'exit', id, code: exitCode });
  });

  return agent;
}

// ── Claude API Agent ──
function createClaudeAgent(id, opts = {}) {
  const agent = {
    id, alive: true, type: 'claude',
    role: opts.role || 'planner',
    label: opts.label || 'Claude',
    status: 'running',
    startedAt: Date.now(),
    history: [],  // 对话历史
  };
  agents.set(id, agent);
  updateProgress(id, { status: 'running', role: agent.role, label: agent.label, type: 'claude' });

  // 输出欢迎消息
  const welcome = `\x1b[36m[Claude Agent] 已连接 (${CLAUDE_API.model})\x1b[0m\r\n`;
  broadcast({ type: 'output', id, data: welcome });
  broadcast({ type: 'output', id, data: `\x1b[33m等待消息中...在聊天室 @${agent.label} 或直接发消息给它\x1b[0m\r\n\r\n` });

  return agent;
}

// 调用 Claude API
async function callClaude(agentId, userMessage) {
  const agent = agents.get(agentId);
  if (!agent || agent.type !== 'claude') return;

  // 构建上下文
  const plan = readJSON(PLAN_FILE);
  const mem = readJSON(MEM_FILE);
  const msgs = readJSON(MSG_FILE);

  const planText = plan.items?.length
    ? plan.items.map(i => `${i.status === 'done' ? '✅' : i.status === 'doing' ? '🔄' : '⬜'} ${i.title}`).join('\n')
    : '暂无计划';

  const systemPrompt = `你是 AgentHub 的 ${agent.role} Agent。你的角色是参与团队讨论，分析问题，提供方案。

当前计划：
${planText}

共享记忆：
${JSON.stringify(mem, null, 2)}

你的职责：
- 如果你是 planner：分析需求、设计方案、添加计划项
- 如果你是 executor：读取计划、执行任务、回写结果
- 回复简洁，用中文，必要时用代码块
- 如果需要添加计划项，用 JSON 格式输出：[PLAN_ADD] {"title":"xxx","assignee":"executor"}`;

  agent.history.push({ role: 'user', content: userMessage });

  // 显示思考中
  broadcast({ type: 'output', id: agentId, data: `\x1b[90m[Claude 思考中...]\x1b[0m\r\n` });

  try {
    const response = await fetch(`${CLAUDE_API.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_API.model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: agent.history,
      }),
    });

    const data = await response.json();
    // 兼容 thinking + text 两种响应格式
    const textBlock = data.content?.find(b => b.type === 'text');
    const thinkBlock = data.content?.find(b => b.type === 'thinking');
    const reply = textBlock?.text || thinkBlock?.thinking || '无响应';

    agent.history.push({ role: 'assistant', content: reply });

    // 输出到终端
    broadcast({ type: 'output', id: agentId, data: `\r\n\x1b[32m[Claude]\x1b[0m ${reply}\r\n\r\n` });

    // 检测是否需要添加计划项
    const planMatch = reply.match(/\[PLAN_ADD\]\s*(\{[^}]+\})/g);
    if (planMatch) {
      for (const m of planMatch) {
        try {
          const item = JSON.parse(m.replace('[PLAN_ADD] ', ''));
          const plan = readJSON(PLAN_FILE);
          plan.items = plan.items || [];
          plan.items.push({ id: 'p' + Date.now(), title: item.title, status: 'todo', assignee: item.assignee || 'executor' });
          writeJSON(PLAN_FILE, plan);
          broadcast({ type: 'plan_update', data: plan });
          broadcast({ type: 'output', id: agentId, data: `\x1b[36m[自动] 已添加计划项: ${item.title}\x1b[0m\r\n` });
        } catch {}
      }
    }

    // 自动发消息到聊天室
    broadcast({ type: 'message', from: agent.label, to: '*', text: reply, time: new Date().toISOString() });

  } catch (err) {
    broadcast({ type: 'output', id: agentId, data: `\x1b[31m[错误] ${err.message}\x1b[0m\r\n` });
  }
}

function stopAgent(id) {
  const agent = agents.get(id);
  if (!agent) return;
  if (agent.type === 'terminal') { try { agent.proc.kill(); } catch {} }
  agents.delete(id);
  updateProgress(id, { status: 'stopped' });
}

function updateProgress(id, data) {
  try {
    let prog = readJSON(PROGRESS_FILE);
    prog.agents[id] = { ...prog.agents[id], ...data, updatedAt: Date.now() };
    writeJSON(PROGRESS_FILE, prog);
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

  const sendFile = (file, type) => { try { ws.send(JSON.stringify({ type, data: readJSON(file) })); } catch {} };
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
          if (a && a.alive && a.type === 'terminal') a.proc.write(msg.data);
          break;
        }
        case 'claude_input': {
          // 发消息给 Claude Agent
          const a = agents.get(msg.id);
          if (a && a.alive && a.type === 'claude') {
            callClaude(msg.id, msg.text);
          }
          break;
        }
        case 'resize': {
          const a = agents.get(msg.id);
          if (a && a.alive && a.type === 'terminal' && msg.cols && msg.rows) {
            try { a.proc.resize(msg.cols, msg.rows); } catch {}
          }
          break;
        }
        case 'stop': { stopAgent(msg.id); break; }

        case 'memory_write': {
          let mem = readJSON(MEM_FILE);
          if (msg.key === null) { mem = msg.value; }
          else {
            const keys = msg.key.split('.'); let obj = mem;
            for (let i = 0; i < keys.length - 1; i++) { if (!obj[keys[i]]||typeof obj[keys[i]]!=='object') obj[keys[i]]={}; obj=obj[keys[i]]; }
            obj[keys[keys.length-1]] = msg.value;
          }
          writeJSON(MEM_FILE, mem);
          broadcast({ type: 'memory_update', data: mem });
          break;
        }
        case 'memory_clear': {
          writeJSON(MEM_FILE, {});
          broadcast({ type: 'memory_update', data: {} });
          break;
        }

        case 'plan_update': {
          writeJSON(PLAN_FILE, msg.data);
          broadcast({ type: 'plan_update', data: msg.data });
          // 通知所有 Claude Agent
          notifyClaudeAgents(`计划已更新:\n${msg.data.items?.map(i => `${i.status === 'done' ? '✅' : i.status === 'doing' ? '🔄' : '⬜'} ${i.title}`).join('\n') || '无'}`);
          break;
        }
        case 'plan_add_item': {
          let plan = readJSON(PLAN_FILE);
          plan.items = plan.items || [];
          plan.items.push(msg.item);
          writeJSON(PLAN_FILE, plan);
          broadcast({ type: 'plan_update', data: plan });
          notifyClaudeAgents(`新增计划项: ${msg.item.title}`);
          break;
        }
        case 'plan_update_item': {
          let plan = readJSON(PLAN_FILE);
          const idx = plan.items.findIndex(i => i.id === msg.itemId);
          if (idx >= 0) { plan.items[idx] = { ...plan.items[idx], ...msg.updates }; }
          writeJSON(PLAN_FILE, plan);
          broadcast({ type: 'plan_update', data: plan });
          break;
        }

        case 'message': {
          let msgs = [];
          try { msgs = readJSON(MSG_FILE); } catch {}
          if (!Array.isArray(msgs)) msgs = [];
          const entry = { from: msg.from||'user', to: msg.to||'*', text: msg.text, time: new Date().toISOString() };
          msgs.push(entry); if (msgs.length > 200) msgs = msgs.slice(-200);
          writeJSON(MSG_FILE, msgs);
          broadcast({ type: 'message', ...entry });

          // 如果消息发给某个 Claude Agent，自动触发回复
          if (msg.to && msg.to !== '*') {
            const target = agents.get(msg.to);
            if (target && target.type === 'claude' && target.alive) {
              callClaude(msg.to, msg.text);
            }
          }
          break;
        }
        case 'messages_clear': {
          writeJSON(MSG_FILE, []);
          broadcast({ type: 'messages_init', data: [] });
          break;
        }
      }
    } catch (err) { console.error('[ERR]', err.message); }
  });

  ws.on('close', () => { clients.delete(ws); console.log(`[WS] -1 (${clients.size})`); });
});

// 通知所有 Claude Agent
function notifyClaudeAgents(text) {
  for (const [id, agent] of agents) {
    if (agent.type === 'claude' && agent.alive) {
      // 只记录到历史，不自动调用（避免循环）
      agent.history.push({ role: 'user', content: `[系统通知] ${text}` });
    }
  }
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) { if (ws.readyState === 1) ws.send(data); }
}

// ── 启动 ──
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  AgentHub  http://localhost:${PORT}\n`);
  console.log(`  Claude API: ${CLAUDE_API.baseUrl} (${CLAUDE_API.model})\n`);
  if (process.platform === 'win32') require('child_process').exec(`start http://localhost:${PORT}`);
});

process.on('SIGINT', () => { for (const [id] of agents) stopAgent(id); process.exit(0); });
