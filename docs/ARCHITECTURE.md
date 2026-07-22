# Architecture

## 系统架构

```
Browser                          Node.js Server
┌──────────────────────┐         ┌──────────────────────────┐
│  xterm.js terminals  │◄──WS──►│  WebSocket Server (ws)   │
│  Plan panel          │         │  PTY Manager (node-pty)  │
│  Progress dashboard  │         │  File Watcher            │
│  Memory editor       │         │  Message Router          │
│  Message panel       │         │                          │
└──────────────────────┘         │  ┌─ Shared Files ──────┐ │
                                 │  │ memory.json          │ │
                                 │  │ plan.json            │ │
                                 │  │ progress.json        │ │
                                 │  │ messages.json        │ │
                                 │  └──────────────────────┘ │
                                 └──────────────────────────┘
```

## 数据流

### 1. 终端 I/O

```
用户键盘输入 → xterm.js onData → WebSocket send
→ server proc.write(data) → PTY 进程 stdin

PTY 进程 stdout → proc.onData → WebSocket broadcast
→ 所有客户端 xterm.js write(data)
```

### 2. Plan 同步

```
Plan 面板编辑 → WebSocket plan_update → server
→ 写入 plan.json → broadcast plan_update → 所有客户端更新

Plan 面板状态切换 → WebSocket plan_update_item → server
→ 更新 plan.json 中对应项 → broadcast plan_update
```

### 3. 共享记忆

```
Memory 编辑器 input → debounce 400ms → WebSocket memory_write
→ server 写入 memory.json → broadcast memory_update → 所有客户端同步
```

### 4. Agent 状态

```
Agent 创建 → server createAgent() → pty.spawn()
→ 更新 progress.json → broadcast progress_update

Agent 输出 → proc.onData → 检测 ERROR/FAILED → 更新状态
Agent 退出 → proc.onExit → 更新 progress.json → broadcast
```

## WebSocket 协议

### 客户端 → 服务端

```json
{"type": "create_agent", "id": "a1", "opts": {"role": "planner", "label": "Planner"}}
{"type": "input", "id": "a1", "data": "dir\r"}
{"type": "resize", "id": "a1", "cols": 120, "rows": 30}
{"type": "stop", "id": "a1"}
{"type": "memory_write", "key": "task", "value": "看板优化"}
{"type": "plan_update", "data": {"items": [...]}}
{"type": "plan_add_item", "item": {"id": "p1", "title": "...", "status": "todo"}}
{"type": "plan_update_item", "itemId": "p1", "updates": {"status": "done"}}
{"type": "message", "from": "user", "to": "a1", "text": "..."}
```

### 服务端 → 客户端

```json
{"type": "output", "id": "a1", "data": "...终端输出..."}
{"type": "exit", "id": "a1", "code": 0}
{"type": "agent_created", "id": "a1"}
{"type": "memory_update", "data": {...}}
{"type": "plan_update", "data": {"items": [...]}}
{"type": "progress_update", "data": {"agents": {...}}}
{"type": "message", "from": "a1", "to": "a2", "text": "...", "time": "..."}
{"type": "messages_init", "data": [...]}
```

## Agent 角色

| 角色 | 用途 | UI 标签颜色 |
|---|---|---|
| `planner` | 规划、分析、设计 | 紫色 |
| `executor` | 执行、实现、验证 | 绿色 |
| `general` | 通用终端 | 蓝色 |

## Plan 状态机

```
todo (⬜ 待开始)
  ↓ 用户点击 / Agent 开始
doing (🔄 进行中)
  ↓ 用户点击 / Agent 完成
done (✅ 完成)
  ↓ 用户点击
todo (循环)
```

## Handoff 交接单

Handoff 是 Plan 面板的结构化补充，来源于 `多agent同步` skill 的 `.shared/handoff.md` 设计。

```
┌─ Handoff ─────────────────────┐
│ 📋 当前任务                    │
│ [contenteditable]             │
│                               │
│ 💡 决策结论                    │
│ [contenteditable]             │
│                               │
│ ✅ 执行标准                    │
│ [contenteditable]             │
│                               │
│ ⚠️ 已知约束                    │
│ [contenteditable]             │
└───────────────────────────────┘
```

- 存储位置：`shared/memory.json` 的 `handoff` 字段
- 编辑方式：contenteditable，失焦自动保存
- 用途：Planner 在开始规划前填写，Executor 执行时参考

## Claude 加入聊天室（规划中）

架构设想：

```
Plan Room
├── 👤 用户A (浏览器)
├── 👤 用户B (浏览器)
├── 🤖 Claude Agent (API)  ← Anthropic API
│   ├── 读取 Plan + Memory + Messages
│   ├── 分析、建议、添加计划项
│   └── 发送消息到聊天室
└── ⚡ Executor (终端)
```

实现方式：
1. 服务端新增 Claude Agent 类型（不走 PTY，走 API）
2. Claude Agent 监听 Plan Room 的消息
3. 收到新消息时调用 Anthropic API 生成回复
4. 回复发送到聊天室，所有用户可见

本质：Claude 从"终端里的工具"变成"团队成员"。

## 关键设计决策

### 为什么用 node-pty 而不是 child_process？

`claude` CLI 需要真正的 PTY（伪终端）才能正常运行。child_process 的 stdin/stdout 不是 TTY，会导致：
- 无法使用 readline（交互式输入）
- 无法显示进度条
- 无法使用 ANSI 颜色

### 为什么共享存储用 JSON 文件而不是数据库？

- Agent（Claude Code 终端）可以直接用 `type`/`cat` 读取
- 不需要额外依赖
- 文件系统天然持久化
- 对于当前规模足够

### 为什么前端用单文件 HTML？

- 零构建步骤，`npm start` 直接跑
- 开发迭代快
- 部署简单（复制文件即可）
- 对于当前复杂度足够
