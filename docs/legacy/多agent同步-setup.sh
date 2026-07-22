#!/bin/bash
# ============================================================
# CC + Claude Desktop 全自动记忆同步 — 一键部署脚本
# 适用于 macOS，首次配置运行一次即可
# ============================================================

set -e

echo "=========================================="
echo " CC + Claude Desktop 记忆同步 部署工具"
echo "=========================================="
echo ""

# ---- 1. 确认项目路径 ----
DEFAULT_PROJECT="$HOME/Desktop/claude code"
read -p "项目路径 [默认: $DEFAULT_PROJECT]: " PROJECT_PATH
PROJECT_PATH="${PROJECT_PATH:-$DEFAULT_PROJECT}"

if [ ! -d "$PROJECT_PATH" ]; then
    echo "❌ 目录不存在: $PROJECT_PATH"
    exit 1
fi

echo "✅ 项目路径: $PROJECT_PATH"

# ---- 2. 创建 .shared/ 目录结构 ----
SHARED_DIR="$PROJECT_PATH/.shared"
mkdir -p "$SHARED_DIR"

# context.md — 项目背景摘要（给 Claude Desktop 快速上手）
if [ ! -f "$SHARED_DIR/context.md" ]; then
    cat > "$SHARED_DIR/context.md" << 'CONTEXT_EOF'
# 项目背景

> 此文件由 CC 导出脚本自动生成，不要手动编辑。

（首次运行 export_context.py 后会自动填充）
CONTEXT_EOF
    echo "✅ 创建 .shared/context.md"
else
    echo "⏭️  .shared/context.md 已存在，跳过"
fi

# handoff.md — 决策层→执行层交接单
if [ ! -f "$SHARED_DIR/handoff.md" ]; then
    cat > "$SHARED_DIR/handoff.md" << 'HANDOFF_EOF'
# 交接单

## 当前任务
（待填写）

## 决策结论
（由 Claude Pro / GPT Pro 讨论后填写）

## 执行标准
- [ ] （待填写）

## 已知约束
（待填写）

## 备注
HANDOFF_EOF
    echo "✅ 创建 .shared/handoff.md"
else
    echo "⏭️  .shared/handoff.md 已存在，跳过"
fi

# progress.md — 执行层反馈进度
if [ ! -f "$SHARED_DIR/progress.md" ]; then
    cat > "$SHARED_DIR/progress.md" << 'PROGRESS_EOF'
# 执行进度

> 此文件由 CC 会话收割自动更新。

## 最近执行
（尚无记录）

## 历史记录
PROGRESS_EOF
    echo "✅ 创建 .shared/progress.md"
else
    echo "⏭️  .shared/progress.md 已存在，跳过"
fi

# ---- 3. 部署导出脚本 ----
SCRIPTS_DIR="$PROJECT_PATH/scripts"
mkdir -p "$SCRIPTS_DIR"

cat > "$SCRIPTS_DIR/export_context.py" << 'EXPORT_EOF'
#!/usr/bin/env python3
"""
从 CC 的 memory/ 和 CLAUDE.md 导出精简版上下文到 .shared/context.md
供 Claude Desktop 通过 MCP 读取
"""

import os
import sys
import glob
import re
from datetime import datetime
from pathlib import Path

def find_project_root():
    """查找项目根目录（包含 CLAUDE.md 的目录）"""
    # 从脚本所在位置往上找
    current = Path(__file__).resolve().parent.parent
    if (current / "CLAUDE.md").exists():
        return current
    # 兜底：当前工作目录
    cwd = Path.cwd()
    if (cwd / "CLAUDE.md").exists():
        return cwd
    print("❌ 找不到项目根目录（需要包含 CLAUDE.md）")
    sys.exit(1)

def find_memory_dir(project_root):
    """查找 CC 的 memory 目录"""
    # macOS 路径编码：把路径中的 / 替换为 -，: 替换为 -
    # 例如 ~/Desktop/claude code → C--Users-username-Desktop-claude-code
    # 但实际目录名取决于 CC 的项目配置，这里自动探测

    claude_dir = Path.home() / ".claude" / "projects"
    if not claude_dir.exists():
        print("❌ 找不到 ~/.claude/projects/ 目录")
        return None

    # 尝试找到包含 memory/ 子目录的项目目录
    candidates = []
    for d in claude_dir.iterdir():
        if d.is_dir() and (d / "memory").is_dir():
            # 检查这个 memory 目录是否有内容
            mem_files = list((d / "memory").glob("*.md"))
            if mem_files:
                candidates.append((d, len(mem_files)))

    if not candidates:
        print("❌ 找不到包含 memory 文件的 CC 项目目录")
        return None

    # 选文件最多的那个
    candidates.sort(key=lambda x: x[1], reverse=True)
    memory_dir = candidates[0][0] / "memory"
    print(f"✅ 找到 memory 目录: {memory_dir}")
    return memory_dir

def read_memory_files(memory_dir):
    """读取所有 memory 文件，按类型分组"""
    categories = {
        "project": [],   # 进行中项目
        "feedback": [],  # 工作规则
        "reference": [], # 参考资料
        "user": [],      # 用户信息
    }

    for md_file in sorted(memory_dir.glob("*.md")):
        if md_file.name == "MEMORY.md":
            continue  # 索引文件单独处理

        content = md_file.read_text(encoding="utf-8")

        # 提取 frontmatter 中的 type
        type_match = re.search(r"type:\s*(\w+)", content)
        file_type = type_match.group(1) if type_match else "reference"

        # 提取 frontmatter 中的 description
        desc_match = re.search(r"description:\s*(.+)", content)
        description = desc_match.group(1).strip() if desc_match else md_file.stem

        # 提取正文（去掉 frontmatter）
        body_match = re.search(r"---\s*\n(.+?)(?:\n---|\Z)", content, re.DOTALL)
        if "---" in content:
            parts = content.split("---", 2)
            body = parts[2].strip() if len(parts) > 2 else ""
        else:
            body = content.strip()

        entry = {
            "file": md_file.name,
            "description": description,
            "body": body[:500],  # 截断，避免太长
        }

        if file_type in categories:
            categories[file_type].append(entry)
        else:
            categories["reference"].append(entry)

    return categories

def read_claude_md(project_root):
    """读取 CLAUDE.md 的关键段落"""
    claude_md = project_root / "CLAUDE.md"
    if not claude_md.exists():
        return ""

    content = claude_md.read_text(encoding="utf-8")

    # 提取关键段落（铁律、工作方法论、Skill 体系、架构偏好）
    sections = []
    current_section = None
    current_lines = []

    for line in content.split("\n"):
        if line.startswith("## "):
            if current_section and current_lines:
                sections.append((current_section, "\n".join(current_lines)))
            current_section = line[3:].strip()
            current_lines = []
        elif current_section:
            current_lines.append(line)

    if current_section and current_lines:
        sections.append((current_section, "\n".join(current_lines)))

    # 只保留重要段落
    important = ["铁律", "工作方法论", "Skill 体系", "架构偏好", "飞书集成"]
    result = []
    for title, body in sections:
        if any(kw in title for kw in important):
            result.append(f"## {title}\n{body}")

    return "\n\n".join(result)

def generate_context_md(project_root, memory_dir):
    """生成 .shared/context.md"""
    categories = read_memory_files(memory_dir)
    claude_sections = read_claude_md(project_root)

    lines = []
    lines.append("# 项目上下文（CC 自动生成）")
    lines.append(f"> 导出时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    # 进行中项目
    if categories["project"]:
        lines.append("## 进行中项目")
        lines.append("")
        for p in categories["project"]:
            lines.append(f"### {p['description']}")
            lines.append(p["body"][:300])
            lines.append("")

    # 工作规则
    if categories["feedback"]:
        lines.append("## 工作规则")
        lines.append("")
        for f in categories["feedback"]:
            lines.append(f"- **{f['description']}**")
        lines.append("")

    # 关键 CLAUDE.md 段落
    if claude_sections:
        lines.append("## 项目规范（摘自 CLAUDE.md）")
        lines.append("")
        lines.append(claude_sections)
        lines.append("")

    # 参考资料摘要
    if categories["reference"]:
        lines.append("## 参考资料")
        lines.append("")
        for r in categories["reference"]:
            lines.append(f"- {r['description']}")
        lines.append("")

    return "\n".join(lines)

def generate_progress_md(project_root, memory_dir):
    """生成 .shared/progress.md 的更新内容"""
    categories = read_memory_files(memory_dir)

    lines = []
    lines.append("# 执行进度")
    lines.append("")
    lines.append(f"> 最后更新: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    if categories["project"]:
        lines.append("## 项目状态")
        lines.append("")
        for p in categories["project"]:
            lines.append(f"### {p['description']}")
            lines.append(p["body"][:200])
            lines.append("")
    else:
        lines.append("（暂无进行中项目记录）")

    return "\n".join(lines)

def main():
    project_root = find_project_root()
    shared_dir = project_root / ".shared"
    shared_dir.mkdir(exist_ok=True)

    memory_dir = find_memory_dir(project_root)
    if not memory_dir:
        print("⚠️  未找到 memory 目录，将只导出 CLAUDE.md 内容")
        memory_dir = project_root / ".claude" / "memory"  # fallback

    # 导出 context.md
    context = generate_context_md(project_root, memory_dir)
    (shared_dir / "context.md").write_text(context, encoding="utf-8")
    print(f"✅ 已更新 .shared/context.md ({len(context)} 字符)")

    # 导出 progress.md
    progress = generate_progress_md(project_root, memory_dir)
    (shared_dir / "progress.md").write_text(progress, encoding="utf-8")
    print(f"✅ 已更新 .shared/progress.md ({len(progress)} 字符)")

    print("")
    print("导出完成。现在可以:")
    print("  1. Claude Desktop 通过 MCP 自动读取这些文件")
    print("  2. 手动复制 .shared/context.md 到 Claude/GPT Projects")

if __name__ == "__main__":
    main()
EXPORT_EOF

chmod +x "$SCRIPTS_DIR/export_context.py"
echo "✅ 部署 scripts/export_context.py"

# ---- 4. 配置 Claude Desktop MCP ----
CLAUDE_DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

# 确保目录存在
mkdir -p "$HOME/Library/Application Support/Claude"

# 读取现有配置（如果有的话）
if [ -f "$CLAUDE_DESKTOP_CONFIG" ]; then
    echo "⚠️  检测到已有 Claude Desktop 配置，将备份到 .bak"
    cp "$CLAUDE_DESKTOP_CONFIG" "${CLAUDE_DESKTOP_CONFIG}.bak"
fi

# 生成 MCP 配置
# 注意：这里用 Python 来处理 JSON，避免 jq 依赖
python3 << PYEOF
import json
import os

config_path = os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json")
project_path = "$PROJECT_PATH"

# 读取现有配置
config = {}
if os.path.exists(config_path):
    try:
        with open(config_path, "r") as f:
            config = json.load(f)
    except:
        config = {}

# 确保 mcpServers 存在
if "mcpServers" not in config:
    config["mcpServers"] = {}

# 添加 filesystem MCP server
config["mcpServers"]["project-files"] = {
    "command": "npx",
    "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        project_path
    ]
}

# 写回配置
with open(config_path, "w") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(f"✅ 已配置 Claude Desktop MCP -> {project_path}")
PYEOF

# ---- 5. 导出初始上下文 ----
echo ""
echo "正在导出初始上下文..."
python3 "$SCRIPTS_DIR/export_context.py"

# ---- 6. 提示 ----
echo ""
echo "=========================================="
echo " 部署完成！"
echo "=========================================="
echo ""
echo "接下来你需要手动完成："
echo ""
echo "  1. 打开 Claude Desktop（如果已安装）"
echo "     → 进入你的 Project"
echo "     → 点击 Project Instructions（或设置图标）"
echo "     → 粘贴以下内容："
echo ""
echo "  ┌────────────────────────────────────────┐"
echo "  │ 每次新会话开始时，先用 MCP 读取：      │"
echo "  │ 1. .shared/context.md（项目背景）       │"
echo "  │ 2. .shared/handoff.md（最新任务交接）   │"
echo "  │ 3. .shared/progress.md（执行层进度）    │"
echo "  │ 读完后简述当前状态，等用户指令。        │"
echo "  └────────────────────────────────────────┘"
echo ""
echo "  2. 重启 Claude Desktop 使 MCP 配置生效"
echo ""
echo "  3. 日常使用："
echo "     → CC 执行完任务后，运行: python3 scripts/export_context.py"
echo "     → 或让 CC 自动执行（已配置在会话收割中）"
echo "     → Claude Desktop 新会话会自动读取最新状态"
echo ""
echo "文件位置："
echo "  项目目录: $PROJECT_PATH"
echo "  共享目录: $PROJECT_PATH/.shared/"
echo "  导出脚本: $PROJECT_PATH/scripts/export_context.py"
echo "  MCP配置:  $CLAUDE_DESKTOP_CONFIG"
echo ""
