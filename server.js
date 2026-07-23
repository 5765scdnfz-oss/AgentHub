const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const chokidar = require('chokidar');

const PORT = 3456;
const SHARED = path.join(__dirname, 'shared');
const MEM_FILE = path.join(SHARED, 'memory.json');
const MSG_FILE = path.join(SHARED, 'messages.json');
const PLAN_FILE = path.join(SHARED, 'plan.json');
const PROGRESS_FILE = path.join(SHARED, 'progress.json');
const WORK_DIR = process.env.AGENTHUB_WORKDIR || path.join(__dirname, '..');

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

// ── Plan 变更推送开关 ──
let planPushEnabled = true;  // 默认开启

// ── Plan 变更监听 ──
let lastPlanSnapshot = null;  // 保存上一次的 plan 快照用于 diff
let planPushQueue = [];  // 变更队列
let planPushTimer = null;  // 防抖定时器

// ── 工具函数 ──
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return {}; } }
function writeJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── Plan 变更检测与推送 ──
function detectPlanChanges(newPlan) {
  if (!lastPlanSnapshot) {
    // 首次加载，保存快照
    lastPlanSnapshot = JSON.parse(JSON.stringify(newPlan));
    return [];
  }

  const changes = [];
  const oldItems = lastPlanSnapshot.items || [];
  const newItems = newPlan.items || [];

  // 检测新增项
  for (const newItem of newItems) {
    const oldItem = oldItems.find(i => i.id === newItem.id);
    if (!oldItem) {
      // 新增计划项
      changes.push({
        type: 'add',
        title: newItem.title,
        status: newItem.status,
      });
    } else if (oldItem.status !== newItem.status) {
      // 状态变更
      const statusMap = { todo: '待开始', doing: '进行中', done: '已完成' };
      changes.push({
        type: 'status_change',
        title: newItem.title,
        oldStatus: statusMap[oldItem.status] || oldItem.status,
        newStatus: statusMap[newItem.status] || newItem.status,
      });
    }
  }

  // 更新快照
  lastPlanSnapshot = JSON.parse(JSON.stringify(newPlan));
  return changes;
}

function formatPlanChange(change) {
  if (change.type === 'add') {
    return `[Plan 更新] 新增任务：${change.title}`;
  } else if (change.type === 'status_change') {
    return `[Plan 更新] "${change.title}" 状态：${change.oldStatus} → ${change.newStatus}`;
  }
  return null;
}

function pushPlanChangesToExecutor(changes) {
  if (!planPushEnabled || !changes.length) return;

  // 将变更添加到队列
  planPushQueue.push(...changes);

  // 清除之前的定时器（防抖）
  if (planPushTimer) {
    clearTimeout(planPushTimer);
  }

  // 设置新的定时器，100ms 内没有新变更才执行推送
  planPushTimer = setTimeout(() => {
    const changesToPush = [...planPushQueue];
    planPushQueue = [];

    if (!changesToPush.length) return;

    // 找到 Executor 终端
    for (const [id, agent] of agents) {
      if (agent.type === 'terminal' && agent.role === 'executor' && agent.alive) {
        // 格式化所有变更并推送
        for (const change of changesToPush) {
          const text = formatPlanChange(change);
          if (text) {
            // 只广播给前端显示，不写入 proc（proc.write 是真实键盘输入，会被 shell 当命令执行）
            // 使用光标保存/恢复，避免打断用户正在输入的内容
            broadcast({ type: 'output', id: agent.id, data: `\x1b[s\r\n\x1b[36m${text}\x1b[0m\r\n\x1b[u` });
          }
        }
        break;  // 只推送到第一个 Executor
      }
    }

    console.log(`[Plan Push] 推送了 ${changesToPush.length} 个变更`);
  }, 100);
}

// ── Executor 完成标记反向同步（AGENTHUB-002）──
// Executor 终端里输入 `#DONE <计划项ID>` 并回车，识别后自动把该计划项标记为已完成
function detectTaskDone(agent, chunk) {
  agent.lineBuffer = (agent.lineBuffer || '') + chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const lines = agent.lineBuffer.split(/\r?\n/);
  agent.lineBuffer = lines.pop(); // 最后一段可能不完整，留到下次拼接

  for (const line of lines) {
    const m = line.match(/#DONE\s+(\S+)/);
    if (m) markPlanItemDone(agent, m[1]);
  }
}

function markPlanItemDone(agent, itemId) {
  const plan = readJSON(PLAN_FILE);
  const item = (plan.items || []).find(i => i.id === itemId);

  if (!item) {
    // 只广播给前端显示，不写入 proc（proc.write 是真实键盘输入，会被 shell 当命令执行）
    broadcast({ type: 'output', id: agent.id, data: `\x1b[s\r\n\x1b[31m[Plan 同步] 未找到计划项 ID: ${itemId}\x1b[0m\r\n\x1b[u` });
    return;
  }
  if (item.status === 'done') return; // 已是完成状态，无需重复处理

  item.status = 'done';
  writeJSON(PLAN_FILE, plan);
  lastPlanSnapshot = JSON.parse(JSON.stringify(plan)); // 避免 chokidar watcher 重复检测并再推送一次
  broadcast({ type: 'plan_update', data: plan });
  broadcast({ type: 'output', id: agent.id, data: `\x1b[s\r\n\x1b[32m[Plan 同步] "${item.title}" 已标记为完成\x1b[0m\r\n\x1b[u` });
  console.log(`[Task Done] ${itemId} -> done (by ${agent.label})`);
}

// 启动 plan.json 文件监听
function startPlanWatcher() {
  // 初始化快照
  try {
    const initialPlan = readJSON(PLAN_FILE);
    lastPlanSnapshot = JSON.parse(JSON.stringify(initialPlan));
    console.log('[Plan Watch] 初始化快照完成');
  } catch (err) {
    console.error('[Plan Watch] 初始化快照失败:', err.message);
  }

  const watcher = chokidar.watch(PLAN_FILE, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('change', (filePath) => {
    try {
      const newPlan = readJSON(PLAN_FILE);
      const changes = detectPlanChanges(newPlan);
      if (changes.length) {
        pushPlanChangesToExecutor(changes);
        console.log(`[Plan Watch] 检测到 ${changes.length} 个变更`);
      }
    } catch (err) {
      console.error('[Plan Watch] 处理变更失败:', err.message);
    }
  });

  console.log('[Plan Watch] 开始监听 plan.json');
  return watcher;
}

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

  const agent = { id, proc, alive: true, type: 'terminal', role: opts.role || 'general', label: opts.label || id, status: 'running', startedAt: Date.now(), lineBuffer: '' };
  agents.set(id, agent);
  updateProgress(id, { status: 'running', role: agent.role, label: agent.label });

  proc.onData(data => {
    broadcast({ type: 'output', id, data });
    if (data.includes('ERROR') || data.includes('error:') || data.includes('FAILED')) {
      agent.status = 'error'; updateProgress(id, { status: 'error' });
    }
    if (agent.role === 'executor') detectTaskDone(agent, data);
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

// 读取工作目录结构（给 Claude 提供本地文件上下文）
function getWorkspaceContext() {
  try {
    // 读取顶层目录结构
    const entries = fs.readdirSync(WORK_DIR, { withFileTypes: true });
    const structure = entries
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`)
      .join('\n');

    // 读取关键文件摘要
    const keyFiles = ['CLAUDE.md', 'MEMORY.md', 'RULES.md'];
    let fileContents = '';
    for (const f of keyFiles) {
      const fp = path.join(WORK_DIR, f);
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf-8').slice(0, 2000);
        fileContents += `\n--- ${f} ---\n${content}\n`;
      }
    }

    // 读取 vault/ 目录结构
    const vaultPath = path.join(WORK_DIR, 'vault');
    let vaultStructure = '';
    if (fs.existsSync(vaultPath)) {
      try {
        const vaultEntries = fs.readdirSync(vaultPath, { withFileTypes: true });
        vaultStructure = vaultEntries
          .map(e => e.isDirectory() ? `📁 vault/${e.name}/` : `📄 vault/${e.name}`)
          .join('\n');
      } catch {}
    }

    // 读取 FOR SHRIMP/skills/ 目录
    const skillsPath = path.join(WORK_DIR, 'FOR SHRIMP', 'skills');
    let skillsStructure = '';
    if (fs.existsSync(skillsPath)) {
      try {
        const walk = (dir, prefix = '') => {
          const items = [];
          const ents = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of ents) {
            if (e.isDirectory()) {
              items.push(`📁 ${prefix}${e.name}/`);
              items.push(...walk(path.join(dir, e.name), prefix + e.name + '/'));
            } else {
              items.push(`📄 ${prefix}${e.name}`);
            }
          }
          return items.slice(0, 50);  // 限制数量
        };
        skillsStructure = walk(skillsPath).join('\n');
      } catch {}
    }

    return `
## 工作目录 (${WORK_DIR})

### 顶层结构
${structure}

### vault/ 目录
${vaultStructure || '无'}

### skills/ 目录
${skillsStructure || '无'}

### 关键文件摘要
${fileContents || '无'}
`;
  } catch (err) {
    return `无法读取工作目录: ${err.message}`;
  }
}

// 读取指定文件（供 Claude 引用）
function readFile(relPath) {
  try {
    const fullPath = path.join(WORK_DIR, relPath);
    if (!fullPath.startsWith(WORK_DIR)) return '路径不允许';
    const content = fs.readFileSync(fullPath, 'utf-8');
    return content.slice(0, 5000);
  } catch (err) {
    return `读取失败: ${err.message}`;
  }
}

// 调用 Claude API
async function callClaude(agentId, userMessage) {
  const agent = agents.get(agentId);
  if (!agent || agent.type !== 'claude') return;

  // 构建上下文（精简版，避免 API 响应慢）
  const plan = readJSON(PLAN_FILE);
  const mem = readJSON(MEM_FILE);

  const planText = plan.items?.length
    ? plan.items.map(i => `${i.status === 'done' ? '✅' : i.status === 'doing' ? '🔄' : '⬜'} ${i.title}`).join('\n')
    : '暂无计划';

  // 根据角色不同的系统提示
  let systemPrompt;
  if (agent.role === 'planner') {
    systemPrompt = `你是 Planner Agent。收到用户需求后，立即拆解为计划项并添加，不要等确认。

当前计划：
${planText}

工作方式：
1. 收到需求 → 立即用 [PLAN_ADD] 添加所有计划项
2. 需要找文件 → 用 [SEARCH] 关键词
3. 需要读文件 → 用 [READ] 文件路径
4. 回复简洁，用中文，不要废话

命令格式：
- [PLAN_ADD] {"title":"xxx","assignee":"executor"}
- [SEARCH] 关键词
- [READ] 文件相对路径

重要：不要问用户确认，直接行动。计划项添加后 Executor 会自动执行。`;
  } else {
    systemPrompt = `你是 Executor Agent，负责执行计划中的任务。

当前计划：
${planText}

工作方式：
1. 收到任务 → 立即执行
2. 需要读文件 → 用 [READ] 文件路径
3. 完成后说明做了什么、结果如何
4. 回复简洁，用中文

命令格式：
- [READ] 文件相对路径

重要：不要问问题，直接执行。`;
  }

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
    const textBlock = data.content?.find(b => b.type === 'text');
    const thinkBlock = data.content?.find(b => b.type === 'thinking');
    let reply = textBlock?.text || thinkBlock?.thinking || '无响应';

    // 清理格式
    reply = reply.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();

    agent.history.push({ role: 'assistant', content: reply });

    // ── 分离：内部命令 vs 干净回复 ──
    const lines = reply.split('\n');
    const cleanLines = [];      // 发给用户的干净文字
    let needRecurse = false;    // 是否需要递归调用

    for (const line of lines) {
      const trimmed = line.trim();

      // [PLAN_ADD] — 静默处理，自动触发 Executor
      if (trimmed.startsWith('[PLAN_ADD]')) {
        try {
          const item = JSON.parse(trimmed.replace('[PLAN_ADD] ', ''));
          const plan = readJSON(PLAN_FILE);
          plan.items = plan.items || [];
          const newItem = { id: 'p' + Date.now(), title: item.title, status: 'todo', assignee: item.assignee || 'executor' };
          plan.items.push(newItem);
          writeJSON(PLAN_FILE, plan);
          broadcast({ type: 'plan_update', data: plan });
          // 自动触发 Executor 执行
          injectToExecutor(newItem);
        } catch {}
        continue;  // 不显示给用户
      }

      // [READ] — 静默读取文件
      if (trimmed.startsWith('[READ]')) {
        const filePath = trimmed.replace('[READ]', '').trim();
        if (filePath && !filePath.includes('/')) {
          // 文件路径，不是目录
          const content = readFile(filePath);
          agent.history.push({ role: 'user', content: `[文件内容: ${filePath}]\n${content}` });
          needRecurse = true;
        } else {
          // 目录路径，列出内容
          try {
            const dirPath = path.join(WORK_DIR, filePath || '');
            const entries = fs.readdirSync(dirPath, { withFileTypes: true });
            const listing = entries.slice(0, 30).map(e => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`).join('\n');
            agent.history.push({ role: 'user', content: `[目录: ${filePath}]\n${listing}` });
            needRecurse = true;
          } catch (e) {
            agent.history.push({ role: 'user', content: `[读取失败: ${e.message}]` });
            needRecurse = true;
          }
        }
        continue;  // 不显示给用户
      }

      // [SEARCH] — 静默搜索（Windows 兼容）
      if (trimmed.startsWith('[SEARCH]')) {
        const keyword = trimmed.replace('[SEARCH]', '').trim();
        try {
          const { execSync } = require('child_process');
          // Windows 用 dir /s /b，其他用 find
          const isWin = process.platform === 'win32';
          const cmd = isWin
            ? `cmd /c "dir /s /b "${WORK_DIR}\\*${keyword}*"" 2>nul | head -15`
            : `find "${WORK_DIR}" -name "*${keyword}*" 2>/dev/null | head -15`;
          const result = execSync(cmd, { encoding: 'utf-8', timeout: 8000 });
          agent.history.push({ role: 'user', content: `[搜索 "${keyword}" 结果]\n${result || '未找到'}` });
          needRecurse = true;
        } catch (e) {
          agent.history.push({ role: 'user', content: `[搜索失败: ${e.message}]` });
          needRecurse = true;
        }
        continue;
      }

      // 过滤掉格式标记行
      if (trimmed === '---' || trimmed === '```') continue;

      // 其他内容 = 干净回复
      cleanLines.push(line);
    }

    // ── 只把干净回复发给前端 ──
    const cleanReply = cleanLines.join('\n').trim();
    if (cleanReply) {
      broadcast({ type: 'output', id: agentId, data: cleanReply });
      broadcast({ type: 'message', from: agent.label, to: '*', text: cleanReply, time: new Date().toISOString() });
    }

    // 如果有文件读取/搜索，递归调用让 Claude 基于结果继续
    if (needRecurse) {
      callClaude(agentId, '请基于上面读取到的内容继续分析。');
      return;
    }

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

// 自动注入任务到 Executor Claude Agent
function injectToExecutor(planItem) {
  for (const [id, agent] of agents) {
    if (agent.type === 'claude' && agent.role === 'executor' && agent.alive) {
      callClaude(id, `请执行以下计划项: ${planItem.title}\n当前计划:\n${JSON.stringify(readJSON(PLAN_FILE), null, 2)}`);
      break;
    }
  }
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
const connectedUsers = new Map();
const fieldEditors = new Map();

wss.on('connection', ws => {
  clients.add(ws);
  ws.userId = Math.random().toString(36).slice(2, 9);
  ws.userName = '访客' + ws.userId.slice(0, 4);
  connectedUsers.set(ws, { id: ws.userId, name: ws.userName });
  console.log(`[WS] +1 (${clients.size})`);

  const sendFile = (file, type) => { try { ws.send(JSON.stringify({ type, data: readJSON(file) })); } catch {} };
  sendFile(MEM_FILE, 'memory_update');
  sendFile(MSG_FILE, 'messages_init');
  sendFile(PLAN_FILE, 'plan_update');
  sendFile(PROGRESS_FILE, 'progress_update');
  ws.send(JSON.stringify({ type: 'my_id', id: ws.userId }));
  broadcastUsers();

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
          if (idx >= 0) {
            const oldStatus = plan.items[idx].status;
            plan.items[idx] = { ...plan.items[idx], ...msg.updates };
            writeJSON(PLAN_FILE, plan);
            broadcast({ type: 'plan_update', data: plan });

            // 当计划项变为 doing 时，自动注入 Executor 终端
            if (msg.updates.status === 'doing' && oldStatus !== 'doing') {
              const item = plan.items[idx];
              injectToExecutor(item);
            }
          }
          break;
        }

        case 'plan_inject': {
          const plan = readJSON(PLAN_FILE);
          const item = (plan.items || []).find(i => i.id === msg.itemId);
          if (item) {
            for (const [id, agent] of agents) {
              if (agent.type === 'terminal' && agent.role === 'executor' && agent.alive) {
                // 只广播给前端显示，不写入 proc（proc.write 是真实键盘输入，会被 shell 当命令执行）
                broadcast({ type: 'output', id: agent.id, data: `\x1b[s\r\n\x1b[35m[Plan 注入] ${item.title}\x1b[0m\r\n\x1b[u` });
                break;
              }
            }
          }
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

        case 'plan_push_toggle': {
          // 切换 Plan 变更推送开关
          planPushEnabled = msg.enabled;
          broadcast({ type: 'plan_push_status', enabled: planPushEnabled });
          console.log(`[Plan Push] ${planPushEnabled ? '开启' : '关闭'}`);
          break;
        }
        case 'set_user': {
          ws.userName = (msg.name || '').trim().slice(0, 20) || ws.userName;
          connectedUsers.set(ws, { id: ws.userId, name: ws.userName });
          broadcastUsers();
          break;
        }
        case 'field_focus': {
          fieldEditors.set(msg.field, { id: ws.userId, name: ws.userName });
          broadcast({ type: 'field_editing', data: { field: msg.field, user: { id: ws.userId, name: ws.userName } } });
          break;
        }
        case 'field_blur': {
          if (fieldEditors.get(msg.field)?.id === ws.userId) {
            fieldEditors.delete(msg.field);
            broadcast({ type: 'field_editing', data: { field: msg.field, user: null } });
          }
          break;
        }
      }
    } catch (err) { console.error('[ERR]', err.message); }
  });

  ws.on('close', () => {
    clients.delete(ws);
    connectedUsers.delete(ws);
    for (const [field, editor] of fieldEditors) {
      if (editor.id === ws.userId) {
        fieldEditors.delete(field);
        broadcast({ type: 'field_editing', data: { field, user: null } });
      }
    }
    broadcastUsers();
    console.log(`[WS] -1 (${clients.size})`);
  });
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

function broadcastUsers() {
  const users = [...connectedUsers.values()];
  broadcast({ type: 'users_update', data: { users } });
}

// ── 启动 ──
server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  AgentHub  http://localhost:${PORT}\n`);
  console.log(`  Claude API: ${CLAUDE_API.baseUrl} (${CLAUDE_API.model})\n`);
  if (process.platform === 'win32') require('child_process').exec(`start http://localhost:${PORT}`);

  // 启动 plan.json 文件监听
  startPlanWatcher();
});

process.on('SIGINT', () => { for (const [id] of agents) stopAgent(id); process.exit(0); });
