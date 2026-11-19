<div align="center">

# 🧠 EasyBrain

**Per-project persistent memory engine, Official MCP Server & Agent Skill.**  
*Install once globally. Keep every project's memory isolated — 100% locally (Zero-API-Key) or in your personal Supabase (`pgvector`).*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org/)
[![MCP SDK](https://img.shields.io/badge/MCP-Official%20SDK-purple.svg)](#using-as-an-mcp-server--agent-skill)

---

🌐 **Languages / Idiomas**:  
**[ English 🇺🇸 ](README.md)** • **[ Português (Brasil) 🇧🇷 ](README.pt-BR.md)**

---

</div>

## 🔍 What is EasyBrain?

**EasyBrain** gives your AI coding agents (Antigravity, Claude Code, Codex, Cursor, Windsurf, or custom orchestrators) **persistent, isolated memory per project** without bloating your context window.

When you start a new chat in the same repository, your agent calls `easybrain_bootstrap` to load a compact **Project State Snapshot** (objective, stack, decisions, current task, next steps) in ~1,000 tokens instead of re-reading the entire codebase.

---

## ✨ Core Features (v1.2.1)

- **Strict Per-Project Isolation (`projectId`)**: Automatically resolves `.easybrain/project.json` per repository (supporting monorepos). Project A never leaks into Project B.
- **Two Processing Modes**:
  - **Basic Mode (Zero API Key / Zero Cost)**: Works out of the box with no `OPENAI_API_KEY`. Provides structured Project Checkpoints, instant `bootstrap`, lexical keyword recall, and verbatim source log tracking.
  - **Enriched Mode (AI Librarian + Semantic Vectors)**: Add any OpenAI-compatible key (OpenAI, Groq, DeepSeek, Ollama, OpenRouter) to automatically consolidate raw logs into dense episodic summaries and vector embeddings.
- **Dual Storage Engine**:
  - **Local Zero-Config (`STORAGE_PROVIDER=local`)**: Stores memory per project in `<project>/.easybrain/memory.json` with cross-process file locking (`.lock`), corruption-proof schema validation, and atomic write-then-rename durability.
  - **Personal Supabase (`STORAGE_PROVIDER=supabase`)**: Connects to your own Supabase (`PostgreSQL + pgvector` HNSW) with `project_id` isolation and strict `lock_token` atomic transactions.
- **Official MCP Server + `SKILL.md`**: Built with `@modelcontextprotocol/sdk` exposing 4 lean tools (`easybrain_bootstrap`, `easybrain_save`, `easybrain_recall`, `easybrain_get_sources`) paired with a standard `skills/easybrain/SKILL.md`.

---

## 🚀 Quickstart (Zero-Setup in 60 Seconds)

```bash
git clone https://github.com/cavizu/easybrain.git
cd easybrain
npm install
npm test
npm run demo
```

No database account and no API key are required to run `npm test` or `npm run demo` in Basic Mode.

---

## 💻 CLI Commands

```bash
# Initialize EasyBrain explicitly for a project (creates .easybrain/project.json)
npx easybrain init [--project <path>]

# Diagnose environment, active storage engine, processing mode, and project scope
npx easybrain doctor [--project <path>]

# Print ready-to-copy MCP server JSON config and Skill paths for your IDE
npx easybrain setup
```

---

## 🛠️ Using as an MCP Server + Agent Skill

Run the setup helper to see the exact paths for your machine:
```bash
npm run build
npx easybrain setup
```

1. **Install the Skill (`skills/easybrain/SKILL.md`)** into your IDE's personal skills folder:
   - **Antigravity**: `~/.gemini/config/skills/easybrain/SKILL.md`
   - **Claude Code**: `~/.claude/skills/easybrain/SKILL.md`
   - **Codex**: `~/.agents/skills/easybrain/SKILL.md`
2. **Register the MCP Server** in your IDE config (`claude_desktop_config.json`, `.cursor/mcp.json`, etc.):
```json
{
  "mcpServers": {
    "easybrain": {
      "command": "node",
      "args": ["/absolute/path/to/easybrain/dist/mcp/server.js"],
      "env": {
        "STORAGE_PROVIDER": "auto"
      }
    }
  }
}
```

---

## 🗄️ Optional: Connecting Your Personal Supabase

1. Open your Supabase **SQL Editor** and run [`sql/schema.sql`](sql/schema.sql).
2. Configure `.env`:
```ini
STORAGE_PROVIDER=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
# Optional for Enriched Mode:
OPENAI_API_KEY=sk-...
```

---

## 🐳 Docker & REST API (Optional)

You can also run EasyBrain as a standalone REST microservice:

```bash
docker compose up -d
curl http://127.0.0.1:3000/health
```

The REST API exposes the same endpoints as the client: `/health`, `/api/memory/bootstrap`, `/api/memory/checkpoint`, `/api/memory/ingest`, `/api/memory/retrieve`, and `/api/memory/logs/decompress`.

---

## 📜 License

MIT License — see [LICENSE](LICENSE).
