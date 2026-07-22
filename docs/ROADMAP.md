# Roadmap

## Phase 1: Plan-Execute 打通（当前）

**目标：** Plan 面板和 Execute 终端之间自动同步，不用手动读写 JSON。

### 待实现

- [ ] **Plan → Execute 推送**：Plan 面板变更时，自动在 Execute 终端写入提示
  - Plan 新增项 → Execute 终端显示 `[Plan] 新增: xxx`
  - Plan 状态变更 → Execute 终端显示 `[Plan] xxx: todo → doing`
  
- [ ] **Execute → Plan 回写**：Execute 终端输出检测关键词，自动更新 Plan 状态
  - 检测到 "完成" / "done" / "✅" → 对应 Plan 项标记 done
  - 检测到 "错误" / "error" / "❌" → 对应 Plan 项标记 error
  
- [ ] **一键注入**：Plan 面板每个计划项加「发送到终端」按钮
  - 点击后自动在 Execute 终端输入该计划项的描述

- [ ] **Plan 模板**：预设常见工作流
  - 看板开发模板（数据/逻辑/渲染三层）
  - 月结处理模板（数据提取/对账/报表）
  - 报表生成模板（数据/格式/审核）

## Phase 2: 多人协作

**目标：** 多个用户可以同时在 Plan Room 讨论和编辑计划。

### 待实现

- [ ] **用户身份**：每个连接分配用户 ID 和名称
  - 首次连接时输入用户名
  - 消息和计划编辑显示来源

- [ ] **实时协作编辑**：多人同时编辑 Plan 面板
  - 冲突处理（乐观锁 / last-write-wins）
  - 实时显示谁在编辑哪一项

- [ ] **Plan Room 聊天**：增强消息系统
  - @mention 支持
  - 消息中引用计划项
  - AI Agent 自动回复

- [ ] **Claude 加入聊天室**：
  - Claude 作为 API 用户加入 Plan Room
  - 通过 Anthropic API 实现 Claude Agent
  - Claude 可以读取 Plan、Memory、Messages
  - Claude 可以发送消息、添加计划项
  - 本质：把 Claude 从"终端里的工具"变成"团队成员"

- [ ] **权限控制**：
  - Plan 编辑权限
  - Execute 控制权限
  - 只读观察者

- [ ] **Handoff 交接单**（已并入基础版）：
  - 当前任务 / 决策结论 / 执行标准 / 已知约束
  - 与 Plan 面板集成
  - 自动持久化到 shared/memory.json

## Phase 3: Agent 编排引擎

**目标：** 不只是终端，Agent 可以是任何自动化任务。

### 待实现

- [ ] **Agent 能力定义**：
  ```json
  {
    "type": "claude-code",
    "config": {"mode": "plan", "model": "opus"},
    "capabilities": ["read-files", "write-files", "run-commands"]
  }
  ```

- [ ] **自动触发**：
  - Plan 项状态变为 doing → 自动启动对应 Agent
  - Agent 完成 → 自动更新 Plan 状态
  - Agent 报错 → 自动通知 Plan Room

- [ ] **Agent 依赖链**：
  ```
  A (数据处理) → B (前端开发) → C (测试)
  A 完成后自动启动 B，B 完成后自动启动 C
  ```

- [ ] **非终端 Agent**：
  - HTTP API 调用 Agent
  - 文件处理 Agent
  - 数据库查询 Agent

## Phase 4: 产品化

**目标：** 从工具变成产品。

### 待实现

- [ ] **Tauri 桌面应用**：
  - 双击 exe 启动
  - 系统托盘常驻
  - 全局快捷键唤出
  - 自动更新

- [ ] **会话持久化**：
  - 保存/恢复 Plan + Memory + Messages
  - 历史会话列表
  - 会话导出

- [ ] **工作流市场**：
  - 社区分享工作流模板
  - 一键导入
  - 评分和评论

- [ ] **企业功能**：
  - 团队管理
  - 审计日志
  - API 集成

## 里程碑

| 里程碑 | 目标 | 预计时间 |
|---|---|---|
| v0.1 | Plan-Execute 自动同步 | 2周 |
| v0.2 | 多人协作基础版 | 1月 |
| v0.3 | Agent 编排引擎 | 2月 |
| v1.0 | Tauri 桌面应用 | 3月 |
