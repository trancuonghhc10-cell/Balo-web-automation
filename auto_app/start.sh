#!/usr/bin/env bash
cd "$(dirname "$0")"

# Ensure Node.js & local binaries are in PATH
export PATH="/home/pccuong/.local/bin:$PATH"

# Activate Python Virtual Environment
source venv/bin/activate

echo "=========================================================="
echo "  akaAuto Ubuntu - Automation & Marketing Core"
echo "  Hệ thống điều khiển Zalo / Facebook Native Linux"
echo "  Tích hợp Zalo Direct API Engine (zca-js)"
echo "  Giao diện Web Dashboard: http://localhost:8000"
echo "  Truy cập từ LAN / điện thoại: http://$(hostname -I | awk '{print $1}'):8000"
echo "  Nhấn Ctrl+C để dừng server"
echo "=========================================================="

exec uvicorn main:app --host 0.0.0.0 --port 8000
