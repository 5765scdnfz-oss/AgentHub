# Development Guide

## 给接续开发的 Agent

本文件记录项目的技术细节和开发注意事项，方便换一个 Agent 继续开发。

## 技术栈

| 层 | 技术 | 文件 |
|---|---|---|
| 后端 | Node.js + ws + node-pty | `server.js` |
| 前端 | 原生 HTML/CSS/JS + xterm.js (CDN) | `index.html` |
| 共享存储 | JSON 文件 (memory/plan/progress/messages) | `shared/*.json` |
| 通信 | WebSocket | server.js ↔ index.html |

## 开发环境

```bash
# Node.js 版本
v24.14.0

# 依赖
ws ^8.18.0        # WebSocket 服务端
node-pty ^1.1.0   # 伪终端（支持 claude CLI）

# 启动
npm install
npm start          # → http://localhost:3456
```

## 文件说明

### server.js

后端核心，约 675 行，结构：

```
1. 初始化共享目录和文件
2. Agent 管理（createAgent / stopAgent）
   - 用 node-pty 创建 PowerShell/Bash 进程
   - 监听 stdout/stderr → broadcast 到所有 WebSocket 客户端
   - 监听进程退出 → 更新状态
3. HTTP 服务（只提供 index.html）
4. WebSocket 服务
   - 处理客户端消息（create/input/resize/stop/memory/plan/message）
   - 广播到所有连接的客户端
5. 启动服务器 + 自动打开浏览器
```

**关键函数：**
- `createAgent(id, opts)` — 创建 PTY 进程，opts 包含 role/label/cwd
- `stopAgent(id)` — 停止进程（Windows 用 taskkill）
- `broadcast(msg)` — 向所有 WebSocket 客户端广播消息
- `updateProgress(id, data)` — 更新 progress.json 并广播

### index.html

前端单文件，约 635 行，结构：

```
1. CSS（浅色毛玻璃风格）
2. HTML 结构
   - Welcome 欢迎页（模板选择）
   - Topbar（新建/布局/停止）
   - Main（终端网格 + 右侧边栏）
   - Statusbar
3. JavaScript
   - WebSocket 连接和消息处理
   - Agent 管理（addAgent/buildPanel/rmAgent）
   - Plan 面板（renderPlan/addPlanItem/cyclePlanStatus）
   - Progress 面板（renderProgress）
   - Memory 编辑器（带 debounce）
   - 消息系统
   - 快捷键（Ctrl+N/B/W）
```

**关键函数：**
- `addAgent(role, label)` — 创建 Agent 并发送到服务器
- `startPlanExecute()` — 一键启动 Plan+Execute 模式
- `renderPlan()` — 渲染计划面板
- `cyclePlanStatus(id)` — 切换计划项状态（todo→doing→done→todo）
- `renderProgress()` — 渲染进度看板

### shared/*.json

运行时数据，gitignore：

- `memory.json` — 共享记忆（键值对）
- `plan.json` — 计划面板数据（items 数组）
- `progress.json` — Agent 进度（agents 对象）
- `messages.json` — 消息队列

## 开发注意事项

### 1. Windows 兼容

- 默认 shell 是 `powershell.exe`
- `stopAgent` 用 `taskkill /F /T /PID` 而不是 `process.kill()`
- 路径用反斜杠或双转义

### 2. PTY 特性

- node-pty 的 `proc.write()` 直接写入 stdin
- `proc.onData()` 接收 stdout + stderr 合并输出
- `proc.resize(cols, rows)` 调整终端大小
- PTY 输出包含 ANSI 转义序列（颜色、光标控制）

### 3. WebSocket 消息格式

所有消息都是 JSON，必须包含 `type` 字段。
服务器广播时，所有客户端都会收到（包括发送者）。

### 4. 前端 xterm.js

- 从 CDN 加载（无需本地安装）
- FitAddon 自动适应容器大小
- ResizeObserver 监听容器变化并同步到 PTY
- onData 回调处理用户键盘输入

### 5. 共享存储

- 文件读写没有加锁（当前规模不需要）
- 多个客户端同时写入时，last-write-wins
- Plan 面板编辑有 debounce（400ms）

## 下一步开发建议

### ✅ 已完成：Plan → Execute 推送

`server.js` 的 `plan_update` / `plan_add_item` / `plan_update_item` 处理中已经会向 Executor 通知计划变化（`notifyClaudeAgents`），计划项切到 `doing` 时还会自动注入 Executor 终端（`injectToExecutor`）。

### 最优先：Execute → Plan 回写

在 `proc.onData` 中检测关键词：

```js
proc.onData(data => {
  broadcast({ type: 'output', id, data });
  
  // 检测完成关键词
  if (data.includes('✅') || data.includes('done')) {
    // 自动更新最近的 doing 项为 done
    autoUpdatePlanStatus(id, 'done');
  }
});
```

### 然后：多人身份

在 WebSocket connection 时要求用户输入名称：

```js
ws.on('message', raw => {
  let msg = JSON.parse(raw.toString());
  if (msg.type === 'set_user') {
    ws.userId = msg.userId;
    ws.userName = msg.userName;
  }
  // ...现有逻辑
});
```

## 调试

```bash
# 启动服务器，查看日志
node server.js

# 日志输出格式
[+] Agent a1 pid=12345    # Agent 创建
[-] Agent a1 exit=0       # Agent 退出
[WS] +1 (2)               # WebSocket 连接
[WS] -1 (1)               # WebSocket 断开
```

## 测试 Plan+Execute 流程

1. `npm start`
2. 点击「📋⚡ Plan+Execute」
3. 左侧出现两个终端（Planner + Executor）
4. 右侧面板出现 4 个预设计划项
5. 在 Planner 终端输入 `claude`，让它分析需求
6. 在 Executor 终端输入 `claude`，让它读取计划执行
7. 在 Plan 面板点击切换状态，观察两个终端的反应
