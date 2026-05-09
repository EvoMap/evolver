#!/bin/bash
# Evolver 一键启动脚本
# 用于系统资产检验和复现，持续赚取积分

set -e

EVOLVER_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$EVOLVER_DIR"

echo "🧬 Evolver 系统资产检验与复现"
echo "================================"
echo ""

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo "❌ 未找到 .env 文件"
    echo "   请先运行: node setup-evolver.cjs"
    echo "   或复制 .env.example 到 .env 并配置"
    exit 1
fi

# 检查节点凭证
if grep -q "A2A_NODE_ID=#" .env || grep -q "A2A_NODE_ID=$" .env; then
    echo "⚠️  未配置 A2A_NODE_ID"
    echo "   请在 .env 文件中设置你的 node_id"
    echo ""
fi

if grep -q "A2A_NODE_SECRET=#" .env || grep -q "A2A_NODE_SECRET=$" .env; then
    echo "⚠️  未配置 A2A_NODE_SECRET"
    echo "   请在 .env 文件中设置你的 node_secret"
    echo ""
fi

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo "📦 安装依赖..."
    npm install
    echo ""
fi

# 检查 Hub 连接
HUB_URL=$(grep "A2A_HUB_URL=" .env | cut -d'=' -f2)
if [ -n "$HUB_URL" ]; then
    echo "🔌 检查 Hub 连接: $HUB_URL"
    if curl -sf "$HUB_URL/health" > /dev/null 2>&1; then
        echo "   ✅ Hub 连接正常"
    else
        echo "   ⚠️  Hub 未运行或无法连接"
        echo "   请先启动 evomap-hub: cd /Users/joy/Desktop/Project/github/evomap/evomap-hub && npm run dev"
        echo ""
    fi
fi

# 启动 Evolver
echo ""
echo "🚀 启动 Evolver..."
echo "   策略: $(grep "EVOLVE_STRATEGY=" .env | cut -d'=' -f2 || echo 'repair-only')"
echo "   按 Ctrl+C 停止"
echo ""

exec node index.js evolve
