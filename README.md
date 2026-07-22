# AgentHub

> **多人协作的 Agent 编排平台** — Plan 规划 + Execute 执行，并行打通

## 一句话描述

AgentHub 解决的核心问题：**规划（Plan）和执行（Execute）在 Claude Code 中是串行的，AgentHub 让它们并行运行，且支持多人协作规划。**

## 分支策略

| 分支 | 用途 | 状态 |
|---|---|---|
| `main` | 核心功能（Plan+Execute+多人协作），不依赖任何 AI 服务 | ✅ 开发中 |
| `claude-integration` | Claude 集成（Desktop MCP / API / 浏览器扩展） | 📋 待开发 |

**核心原则：** `main` 分支永远不依赖 Claude。Claude 集成在独立分支开发，稳定后合并。

## 为什么需要 AgentHub？

| 痛点 | 现有方案 | AgentHub |
|---|---|---|
| Plan 和 Execute 串行，来回切换 | Claude Code 单实例，退出 plan mode 才能执行 | 双终端并行，实时同步 |
| 多人无法同时参与规划 | 一个人操作，其他人等 | 多人 Plan Room，实时讨论 |
| 执行状态不可见 | 要切到终端看输出 | 进度看板，一眼看清 |
| 上下文不共享 | 复制粘贴 | 共享记忆，自动同步 |

## 产品愿景

```
┌─ Plan Room（多人 + AI 讨论室）──────────────────────────┐
│                                                         │
│  👤 用户A: 看板需要加汇率换算                            │
│  👤 用户B: 还要支持多币种                                │
│  🤖 Planner Agent: 识别出3个模块，已添加到计划           │
│     ☐ 汇率API对接                                       │
│     ☐ 多币种数据模型                                    │
│     ☐ 前端图表适配                                      │
│                                                         │
└─────────────────────────────────────────────────────────┘
              │ 自动同步
              ▼
┌─ Execute Agent（自动执行）──────────────────────────────┐
│                                                         │
│  ⚡ 执行中: 汇率API对接  ████████████░░░ 75%            │
│  ✅ 获取API密钥  ✅ 编写服务  🔄 集成中  ⏳ 测试        │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## 功能现状

### ✅ 已实现

- [x] 多终端并排（xterm.js + WebSocket + node-pty）
- [x] Plan + Execute 一键启动（双终端 + 计划面板 + 共享记忆）
- [x] 计划面板（添加/编辑/状态切换：待开始/进行中/完成）
- [x] 进度看板（实时显示 Agent 角色和状态）
- [x] 共享记忆（JSON 键值存储，所有终端实时同步）
- [x] Agent 间消息（点对点/广播）
- [x] 浅色毛玻璃 UI（backdrop-filter）
- [x] 桌面快捷方式一键启动

### 🔄 开发中

- [ ] Plan 变更自动推送到 Execute 终端
- [ ] Execute 完成自动回写到 Plan 面板
- [ ] 用户身份系统（多人区分）
- [ ] 实时协作（多人同时编辑计划）

### 📋 规划中

- [ ] 预设工作流模板（看板开发/月结/报表）
- [ ] Agent 能力定义（不只是终端，支持 API 调用等）
- [ ] 会话持久化（关闭后恢复）
- [ ] Tauri 桌面应用版本

## 快速开始

### 前置条件

- Node.js 18+（当前 v24.14.0）
- Windows / macOS / Linux

### 安装

```bash
git clone https://github.com/5765scdnfz-oss/AgentHub.git
cd AgentHub
npm install
```

### 启动

```bash
npm start
# 浏览器自动打开 http://localhost:3456
```

或 Windows 双击 `AgentHub.bat`

### 使用

1. 打开页面，点击「📋⚡ Plan+Execute」
2. 左侧出现两个终端：Planner + Executor
3. 右侧面板：📋 Plan / 📊 进度 / 🧠 记忆 / 💬 消息
4. 在 Plan 面板添加计划项
5. Planner 终端里输入 `claude` 进入规划模式
6. Executor 终端里输入 `claude` 进入执行模式
7. 两者通过共享记忆自动同步

## 技术架构

```
┌─ 浏览器 ──────────────────────────────────────────────┐
│  index.html (xterm.js + 原生 JS)                      │
│  ┌─ Terminal Grid ──┐  ┌─ Right Sidebar ────────────┐ │
│  │ xterm.js × N     │  │ Plan / Progress / Memory / │ │
│  │ (PTY 终端)       │  │ Messages                   │ │
│  └──────────────────┘  └────────────────────────────┘ │
│           ↕ WebSocket (ws)                             │
└────────────────────────────────────────────────────────┘
           ↕
┌─ Node.js Server ──────────────────────────────────────┐
│  server.js                                             │
│  ┌─ HTTP ──┐  ┌─ WebSocket ──┐  ┌─ PTY ─────────────┐│
│  │ Express  │  │ ws (广播)    │  │ node-pty × N      ││
│  └──────────┘  └──────────────┘  │ (PowerShell/Bash) ││
│                                  └───────────────────┘│
│  ┌─ Shared Files ────────────────────────────────────┐│
│  │ memory.json  plan.json  progress.json  messages   ││
│  └───────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────┘
```

### 关键技术选型

| 组件 | 选择 | 原因 |
|---|---|---|
| 终端 | xterm.js + node-pty | 真正的 PTY，支持 claude CLI |
| 通信 | WebSocket (ws) | 双向实时通信 |
| 共享存储 | JSON 文件 | 简单可靠，Agent 可直接读写 |
| UI | 原生 HTML/CSS/JS | 零构建步骤，即开即用 |
| 后端 | 纯 Node.js | 无框架依赖，轻量 |

## 项目结构

```
AgentHub/
├── server.js          # Node.js 后端（HTTP + WebSocket + PTY 管理）
├── index.html         # 前端 UI（xterm.js + 原生 JS，单文件）
├── package.json       # 依赖（ws + node-pty）
├── AgentHub.bat       # Windows 一键启动
├── agenthub.ico       # 应用图标
├── shared/            # 运行时共享数据（gitignore）
│   ├── memory.json    # 共享记忆
│   ├── plan.json      # 计划面板数据
│   ├── progress.json  # Agent 进度
│   └── messages.json  # 消息队列
├── docs/              # 文档
│   ├── ARCHITECTURE.md
│   ├── ROADMAP.md
│   └── DEV_GUIDE.md
└── README.md          # 本文件
```

## 差异化定位

**不是** VS Code 多终端的替代品。
**不是** Claude Code 的 UI 壳。

**是** 解决"规划和执行串行"这个具体痛点的工具：

- Claude Code: Plan → 等待 → Execute（串行）
- AgentHub: Plan ‖ Execute（并行）+ 多人协作

## License

MIT
