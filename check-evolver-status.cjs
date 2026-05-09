#!/usr/bin/env node
/**
 * Evolver 状态检查脚本
 * 
 * 查看 Evolver 运行状态、积分和最新活动
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const EVOLVER_DIR = '/Users/joy/Desktop/Project/github/evomap/evolver';

function checkProcess() {
  console.log('📊 Evolver 状态检查\n');
  console.log('='.repeat(50));
  
  // Check if process is running
  try {
    const ps = execSync('ps aux | grep -v grep | grep "evolver" | grep -v "Cursor\|degit"', { encoding: 'utf8' });
    console.log('\n✅ Evolver 进程状态:');
    console.log(ps);
  } catch (e) {
    console.log('\n❌ Evolver 未运行');
    console.log('   启动: node index.js /evolve');
    return false;
  }
  
  return true;
}

function checkLog() {
  const logPath = path.join(EVOLVER_DIR, 'evolver.log');
  if (fs.existsSync(logPath)) {
    const stats = fs.statSync(logPath);
    console.log(`\n📝 日志文件:`);
    console.log(`   路径: ${logPath}`);
    console.log(`   大小: ${(stats.size / 1024).toFixed(1)} KB`);
    console.log(`   修改: ${stats.mtime.toLocaleString()}`);
    
    // Show last few lines
    try {
      const tail = execSync(`tail -20 "${logPath}"`, { encoding: 'utf8' });
      console.log('\n📜 最新日志 (最后 20 行):');
      console.log(tail);
    } catch (e) {
      console.log('   (无法读取日志)');
    }
  } else {
    console.log('\n⚠️  未找到日志文件');
  }
}

function checkEnv() {
  const envPath = path.join(EVOLVER_DIR, '.env');
  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    console.log('\n⚙️  当前配置:');
    
    const hubUrl = env.match(/A2A_HUB_URL=(.+)/);
    const nodeId = env.match(/A2A_NODE_ID=(.+)/);
    const strategy = env.match(/EVOLVE_STRATEGY=(.+)/);
    
    if (hubUrl) console.log(`   Hub URL: ${hubUrl[1]}`);
    if (nodeId) console.log(`   Node ID: ${nodeId[1]}`);
    if (strategy) console.log(`   策略: ${strategy[1]}`);
    
    if (!nodeId || nodeId[1].includes('#')) {
      console.log('\n⚠️  未配置 Node ID');
    }
  }
}

function checkWorkDir() {
  const workDir = path.join(EVOLVER_DIR, 'work');
  const memoryDir = path.join(EVOLVER_DIR, 'memory');
  
  console.log('\n📁 工作目录:');
  console.log(`   work/: ${fs.existsSync(workDir) ? '✅' : '❌'}`);
  console.log(`   memory/: ${fs.existsSync(memoryDir) ? '✅' : '❌'}`);
}

function main() {
  const running = checkProcess();
  checkLog();
  checkEnv();
  checkWorkDir();
  
  console.log('\n' + '='.repeat(50));
  console.log('\n💡 常用命令:');
  console.log('   查看状态: node check-evolver-status.cjs');
  console.log('   查看日志: tail -f evolver.log');
  console.log('   停止 Evolver: pkill -f "node index.js /evolve"');
  console.log('   重启: node index.js /evolve');
  console.log('   查看积分: curl http://localhost:4000/api/hub/account/agents');
}

main();
