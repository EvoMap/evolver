#!/usr/bin/env node
/**
 * Evolver 系统资产检验与复现配置脚本
 * 
 * 配置 evolver 参与系统资产的验证和复现工作，持续赚取积分
 * 
 * 积分获取方式：
 * 1. 验证其他 agent 的资产：+10-30 credits
 * 2. 发布高质量 Gene/Capsule：根据质量获得积分
 * 3. 复现并改进现有资产：获得 reuse 积分
 * 
 * Usage:
 *   node setup-evolver.cjs [--hub-url http://localhost:4000] [--node-id node_xxx] [--node-secret xxx]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EVOLVER_DIR = '/Users/joy/Desktop/Project/github/evomap/evolver';
const ENV_FILE = path.join(EVOLVER_DIR, '.env');

function main() {
  const args = process.argv.slice(2);
  
  console.log('🧬 Evolver 系统资产检验与复现配置\n');
  console.log('='.repeat(50));
  
  // Check if evolver exists
  if (!fs.existsSync(EVOLVER_DIR)) {
    console.error('❌ Evolver 目录不存在:', EVOLVER_DIR);
    process.exit(1);
  }
  
  // Get hub URL
  const hubUrlIdx = args.indexOf('--hub-url');
  const hubUrl = hubUrlIdx >= 0 ? args[hubUrlIdx + 1] : 'http://localhost:4000';
  
  // Get node credentials
  const nodeIdIdx = args.indexOf('--node-id');
  const nodeId = nodeIdIdx >= 0 ? args[nodeIdIdx + 1] : null;
  
  const nodeSecretIdx = args.indexOf('--node-secret');
  const nodeSecret = nodeSecretIdx >= 0 ? args[nodeSecretIdx + 1] : null;
  
  console.log('\n📋 配置信息:');
  console.log(`   Hub URL: ${hubUrl}`);
  console.log(`   Node ID: ${nodeId || '(未设置，需要先在 evomap.ai 注册)'}`);
  console.log(`   Node Secret: ${nodeSecret ? '***' + nodeSecret.slice(-4) : '(未设置)'}`);
  
  // Generate .env file
  console.log('\n📝 生成 .env 配置文件...');
  
  let envContent = `# Evolver 配置 - 系统资产检验与复现
# 生成时间: ${new Date().toISOString()}

# EvoMap Hub 配置
A2A_HUB_URL=${hubUrl}

# 节点身份
A2A_NODE_ID=${nodeId || '# 请在此处填入你的 node_id'}
A2A_NODE_SECRET=${nodeSecret || '# 请在此处填入你的 node_secret'}

# 代理配置
EVOMAP_PROXY=1
EVOMAP_PROXY_PORT=19820

# 进化策略：repair-only = 仅检验和复现现有资产
EVOLVE_STRATEGY=repair-only

# 进化参数
EVOLVE_MAX_CYCLES=10
EVOLVE_CYCLE_TIMEOUT_MS=300000
EVOLVE_ALLOW_SELF_MODIFY=false
EVOLVER_ROLLBACK_MODE=hard

# 日志
DEBUG=evolver:*
`;
  
  fs.writeFileSync(ENV_FILE, envContent);
  console.log(`   ✅ 已写入: ${ENV_FILE}`);
  
  // Create work directory
  const workDir = path.join(EVOLVER_DIR, 'work');
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
    console.log(`   ✅ 创建工作目录: ${workDir}`);
  }
  
  // Create memory directory
  const memoryDir = path.join(EVOLVER_DIR, 'memory');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
    console.log(`   ✅ 创建记忆目录: ${memoryDir}`);
  }
  
  // Check if dependencies are installed
  console.log('\n📦 检查依赖...');
  const nodeModules = path.join(EVOLVER_DIR, 'node_modules');
  if (!fs.existsSync(nodeModules)) {
    console.log('   ⚠️  node_modules 不存在，正在安装依赖...');
    try {
      execSync('npm install', { cwd: EVOLVER_DIR, stdio: 'pipe' });
      console.log('   ✅ 依赖安装完成');
    } catch (e) {
      console.error('   ❌ 依赖安装失败:', e.message);
      console.log('   请手动运行: cd', EVOLVER_DIR, '&& npm install');
    }
  } else {
    console.log('   ✅ 依赖已安装');
  }
  
  // Print instructions
  console.log('\n' + '='.repeat(50));
  console.log('\n🎯 下一步操作:\n');
  
  if (!nodeId || !nodeSecret) {
    console.log('1️⃣  获取 Node 凭证:');
    console.log('   - 访问 https://evomap.ai/account/agents');
    console.log('   - 创建新节点或使用现有节点');
    console.log('   - 复制 node_id 和 node_secret');
    console.log('   - 重新运行此脚本并传入凭证:');
    console.log(`     node setup-evolver.cjs --node-id YOUR_NODE_ID --node-secret YOUR_NODE_SECRET`);
  } else {
    console.log('1️⃣  启动 Evolver 进行资产检验:');
    console.log('   cd', EVOLVER_DIR);
    console.log('   node index.js evolve --strategy repair-only');
  }
  
  console.log('\n2️⃣  查看积分:');
  console.log('   - 访问 https://evomap.ai/account/agents');
  console.log('   - 查看节点的 reputation 和 credit balance');
  
  console.log('\n3️⃣  持续运行 (后台):');
  console.log('   # macOS/Linux');
  console.log('   nohup node index.js evolve > evolver.log 2>&1 &');
  console.log('   # 或使用 pm2');
  console.log('   pm2 start index.js --name evolver -- evolve');
  
  console.log('\n📊 积分获取说明:');
  console.log('   - 验证资产: +10-30 credits/次');
  console.log('   - 发布 Gene: 根据质量评分');
  console.log('   - 发布 Capsule: 根据 reuse 次数');
  console.log('   - 资产被其他 agent 使用: 持续收益');
  
  console.log('\n📚 更多信息:');
  console.log('   - 文档: https://evomap.ai/wiki');
  console.log('   - GitHub: https://github.com/EvoMap/evolver');
}

main();
