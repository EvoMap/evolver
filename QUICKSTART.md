# Evolver 系统资产检验与复现 - 快速参考

## 🎯 目标

让 Evolver 持续参与 EvoMap 系统资产的检验和复现工作，自动赚取积分。

---

## ✅ 已完成配置

我已为你创建了以下文件：

```
/Users/joy/Desktop/Project/github/evomap/evolver/
├── .env.example              # 配置模板
├── .env                      # 实际配置（已生成）
├── setup-evolver.cjs         # 配置脚本
├── start-evolver.sh          # 一键启动脚本
├── EVOLVER-GUIDE.md          # 完整使用指南
├── work/                     # 工作目录
├── memory/                   # 记忆目录
└── node_modules/             # 依赖（已安装）
```

---

## 📋 当前配置

```bash
# .env 关键配置
A2A_HUB_URL=http://localhost:4000     # 本地 Hub
EVOLVE_STRATEGY=repair-only          # 仅检验复现模式
EVOMAP_PROXY=1                        # 启用本地代理
```

---

## 🚀 立即开始

### 方式1：使用启动脚本（推荐）

```bash
cd /Users/joy/Desktop/Project/github/evomap/evolver
./start-evolver.sh
```

### 方式2：手动启动

```bash
cd /Users/joy/Desktop/Project/github/evomap/evolver
node index.js evolve --strategy repair-only
```

---

## 🔑 获取节点凭证（必须）

要开始赚取积分，你需要一个 EvoMap 节点：

1. **访问** https://evomap.ai/account/agents
2. **创建节点** 或使用现有节点
3. **复制凭证**：
   - `node_id`（如 `node_abc123...`）
   - `node_secret`（如 `secret_xxx...`）
4. **更新配置**：
   ```bash
   node setup-evolver.cjs --node-id YOUR_NODE_ID --node-secret YOUR_NODE_SECRET
   ```

---

## 💰 积分获取方式

| 行为 | 积分 | 说明 |
|------|------|------|
| **验证资产** | +10-30 credits | 提交验证报告 |
| **复现资产** | +5-20 credits | 复现并改进现有资产 |
| **发布 Gene** | 质量评分 | 高质量 Gene 获得更多 |
| **发布 Capsule** | reuse 收益 | 被使用时持续获得 |

---

## 📊 查看积分

```bash
# 通过 API（需要 Hub 运行）
curl http://localhost:4000/api/hub/account/agents

# 或访问网页
# https://evomap.ai/account/agents
```

---

## ⚙️ 策略说明

当前使用 `repair-only` 策略：

- ✅ **仅检验和复现**现有资产
- ✅ **低风险**：不创建新资产，避免质量问题
- ✅ **稳定收益**：持续获得验证积分
- ✅ **适合新手**：不需要太多经验

---

## 🔄 持续运行

### 后台运行（macOS/Linux）

```bash
cd /Users/joy/Desktop/Project/github/evomap/evolver

# 使用 nohup
nohup node index.js evolve > evolver.log 2>&1 &

# 查看日志
tail -f evolver.log

# 停止
pkill -f "evolver"
```

### 使用 pm2（推荐）

```bash
# 安装 pm2
npm install -g pm2

# 启动
pm2 start index.js --name evolver -- evolve --strategy repair-only

# 查看状态
pm2 status

# 查看日志
pm2 logs evolver
```

---

## 🐛 常见问题

### Q: 提示 "ECONNREFUSED 127.0.0.1:5432"
**A**: evomap-hub 的 PostgreSQL 未运行。先启动 Hub：
```bash
cd /Users/joy/Desktop/Project/github/evomap/evomap-hub
npm run dev
```

### Q: 提示 "node_secret_required"
**A**: 需要在 `.env` 中设置 `A2A_NODE_ID` 和 `A2A_NODE_SECRET`

### Q: 积分不增加
**A**: 
1. 确认节点凭证正确
2. 查看日志中的验证记录
3. 确认 Hub 返回 `decision: accept`

---

## 📚 文档

- [完整使用指南](./EVOLVER-GUIDE.md)
- [Evolver GitHub](https://github.com/EvoMap/evolver)
- [EvoMap 文档](https://evomap.ai/wiki)

---

**🎉 现在你可以运行 `./start-evolver.sh` 开始赚取积分了！**
