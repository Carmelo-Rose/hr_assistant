#!/bin/bash
# BOSS 招聘助手 — 一键启动（macOS，双击运行）
# 启动后端（同时托管控制台页面和油猴脚本），并自动打开浏览器。
# 首次使用：打开的页面里点“安装指引”，装好 Tampermonkey + 脚本即可。

cd "$(dirname "$0")/backend" || { echo "找不到 backend 目录"; exit 1; }

# 控制台页面需要先构建一次前端（生成 frontend/dist）
if [ ! -d "../frontend/dist" ]; then
  echo "⚠️  尚未构建前端控制台。请先运行：cd frontend && npm install && npm run build"
  echo "    （脚本仍会启动后端，但 http://localhost:8000 暂时只显示提示）"
fi

# 后端起来后再打开浏览器
( sleep 2; open "http://localhost:8000" ) &

echo "启动后端中… 关闭此窗口即停止服务。"
exec uv run uvicorn app.main:app --port 8000
