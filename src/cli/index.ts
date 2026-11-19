#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ProjectResolver, TieredMemoryClient } from '../index.js';

dotenv.config();

const args = process.argv.slice(2);
const command = args[0];

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

async function main() {
  if (command === 'init') {
    const projectPath = getArg('--project') || process.cwd();
    const ctx = ProjectResolver.resolveFromPath(projectPath, { autoInit: true });
    console.log(`✅ EasyBrain initialized for project: ${ctx.rootPath}`);
    console.log(`   Project ID : ${ctx.projectId}`);
    console.log(`   Local DB   : ${ctx.localDbPath}`);
    console.log('   Tip: Add ".easybrain/" to your project\'s .gitignore.');
    return;
  }

  if (command === 'doctor') {
    const projectPath = getArg('--project');
    const client = new TieredMemoryClient(projectPath ? { projectPath } : {});
    console.log('🩺 EasyBrain Doctor');
    console.log(`   Node.js         : ${process.version}`);
    console.log(`   Storage Engine  : ${client.providerName}`);
    console.log(
      `   Processing Mode : ${client.mode} (${
        client.mode === 'basic'
          ? 'Zero-API-Key / Lexical + Checkpoints'
          : 'AI Librarian + Vector Embeddings'
      })`
    );
    console.log(`   Project Scope   : ${client.projectId}`);
    if (client.rootPath) console.log(`   Project Root    : ${client.rootPath}`);
    return;
  }

  if (command === 'setup') {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packageRoot = path.resolve(currentDir, '..', '..');
    const mcpPath = path.resolve(packageRoot, 'dist', 'mcp', 'server.js');
    const skillPath = path.resolve(packageRoot, 'skills', 'easybrain', 'SKILL.md');
    console.log('🔌 EasyBrain MCP + Skill Setup Guide\n');
    console.log('1. Copy the Skill file into your IDE personal skills directory:');
    console.log(`   Source: ${skillPath}`);
    console.log('   - Antigravity : ~/.gemini/config/skills/easybrain/SKILL.md');
    console.log('   - Claude Code : ~/.claude/skills/easybrain/SKILL.md');
    console.log('   - Codex       : ~/.agents/skills/easybrain/SKILL.md\n');
    console.log('2. Add this MCP server block to your IDE config:');
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            easybrain: {
              command: 'node',
              args: [mcpPath],
              env: {
                STORAGE_PROVIDER: 'auto',
              },
            },
          },
        },
        null,
        2
      )
    );
    return;
  }

  console.log('EasyBrain CLI v1.2.1');
  console.log('Usage:');
  console.log('  easybrain init [--project <path>]   Initialize .easybrain/ in a project');
  console.log('  easybrain doctor [--project <path>] Check environment, storage & mode');
  console.log('  easybrain setup                     Print MCP & SKILL.md installation instructions');
}

main().catch((err) => {
  console.error('❌ EasyBrain CLI Error:', (err as Error).message);
  process.exit(1);
});
