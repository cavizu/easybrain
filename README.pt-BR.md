<div align="center">

# 🧠 EasyBrain

**Motor de memória persistente por projeto, Servidor MCP Oficial e Agent Skill.**  
*Instale uma vez globalmente. Mantenha a memória de cada projeto isolada — 100% local (sem chave de API) ou no seu próprio Supabase (`pgvector`).*

[![Licença: MIT](https://img.shields.io/badge/Licen%C3%A7a-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![MCP SDK](https://img.shields.io/badge/MCP-SDK%20Oficial-purple.svg)](#usando-como-servidor-mcp--agent-skill)

---

🌐 **Idiomas / Languages**:  
**[ English 🇺🇸 ](README.md)** • **[ Português (Brasil) 🇧🇷 ](README.pt-BR.md)**

---

</div>

## 🔍 O que é o EasyBrain?

O **EasyBrain** entrega **memória persistente e isolada por projeto** para agentes de IA e IDEs (Antigravity, Claude Code, Codex, Cursor, Windsurf ou orquestradores próprios), evitando o inchaço da janela de contexto.

Ao abrir uma nova conversa no mesmo repositório, o agente chama `easybrain_bootstrap` e recebe um **Snapshot de Estado do Projeto** compacto (objetivo, stack, decisões, tarefa atual, próximos passos) em cerca de 1.000 tokens, sem precisar varrer todos os arquivos do projeto.

---

## ✨ Principais Recursos (v1.2)

- **Isolamento Estrito por Projeto (`projectId`)**: Resolve automaticamente `.easybrain/project.json` por repositório (com suporte a monorepos). O Projeto A nunca mistura dados com o Projeto B.
- **Dois Modos de Operação**:
  - **Modo Básico (Sem Chave de API / Custo Zero)**: Funciona imediatamente sem `OPENAI_API_KEY`. Entrega Checkpoints estruturados, `bootstrap` instantâneo, busca textual por palavras-chave e rastreabilidade dos logs originais.
  - **Modo Enriquecido (Bibliotecário IA + Vetores Semânticos)**: Adicione uma chave compatível com OpenAI (OpenAI, Groq, DeepSeek, Ollama, OpenRouter) para consolidar conversas em resumos episódicos e busca vetorial por cosseno.
- **Duplo Motor de Armazenamento**:
  - **Local Zero-Config (`STORAGE_PROVIDER=local`)**: Salva em `<projeto>/.easybrain/memory.json` com gravação atômica (`.tmp` -> `rename`).
  - **Supabase Pessoal (`STORAGE_PROVIDER=supabase`)**: Conecta ao seu próprio Supabase (`PostgreSQL + pgvector` HNSW) com isolamento por `project_id` e validação estrita de `lock_token` em transação atômica.
- **Servidor MCP Oficial + `SKILL.md`**: Construído com `@modelcontextprotocol/sdk` expondo 4 ferramentas enxutas (`easybrain_bootstrap`, `easybrain_save`, `easybrain_recall`, `easybrain_get_sources`) acompanhadas da Skill padrão `skills/easybrain/SKILL.md`.

---

## 🚀 Início Rápido (Sem Configuração em 60 Segundos)

```bash
git clone https://github.com/cavizu/easybrain.git
cd easybrain
npm install
npm test
npm run demo
```

Não é necessário criar conta de banco de dados nem informar chave de API para rodar `npm test` ou `npm run demo` no Modo Básico.

---

## 🛠️ Usando como Servidor MCP + Agent Skill

Rode o assistente de configuração para ver os caminhos exatos na sua máquina:
```bash
npm run build
npx easybrain setup
```

1. **Copie a Skill (`skills/easybrain/SKILL.md`)** para a pasta pessoal de Skills da sua IDE:
   - **Antigravity**: `~/.gemini/config/skills/easybrain/SKILL.md`
   - **Claude Code**: `~/.claude/skills/easybrain/SKILL.md`
   - **Codex**: `~/.agents/skills/easybrain/SKILL.md`
2. **Adicione o servidor MCP** na configuração da sua IDE:
```json
{
  "mcpServers": {
    "easybrain": {
      "command": "node",
      "args": ["/caminho/absoluto/para/easybrain/dist/mcp/server.js"],
      "env": {
        "STORAGE_PROVIDER": "auto"
      }
    }
  }
}
```

---

## 🗄️ Opcional: Conectando seu Supabase Pessoal

1. No **SQL Editor** do seu Supabase, execute [`sql/schema.sql`](sql/schema.sql).
2. Configure o `.env`:
```ini
STORAGE_PROVIDER=supabase
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
# Opcional para Modo Enriquecido:
OPENAI_API_KEY=sk-...
```

---

## 📜 Licença

Licença MIT — veja [LICENSE](LICENSE).
