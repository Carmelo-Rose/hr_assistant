@echo off
REM BOSS 招聘助手 — 一键启动（Windows，双击运行）
REM 启动后端（同时托管控制台页面和油猴脚本），并自动打开浏览器。
REM 首次使用：打开的页面里点“安装指引”，装好 Tampermonkey + 脚本即可。

cd /d "%~dp0backend"

if not exist "..\frontend\dist" (
  echo [警告] 尚未构建前端控制台。请先运行: cd frontend ^&^& npm install ^&^& npm run build
  echo        ^(后端仍会启动，但 http://localhost:8000 暂时只显示提示^)
)

start "" http://localhost:8000

echo 启动后端中... 关闭此窗口即停止服务。
uv run uvicorn app.main:app --port 8000
