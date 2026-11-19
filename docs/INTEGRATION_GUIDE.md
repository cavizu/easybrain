# 🔌 EasyBrain v1.2 Integration Guide

## 1. CLI Commands
```bash
npx easybrain init --project ./my-repo
npx easybrain doctor --project ./my-repo
npx easybrain setup
```

## 2. TypeScript SDK
```typescript
import { TieredMemoryClient } from 'easybrain';

const memory = new TieredMemoryClient({ projectPath: '/path/to/my-repo' });
await memory.saveCheckpoint({ objective: 'API v2', currentTask: 'Auth middleware' });
const boot = await memory.bootstrap();
console.log(boot.formattedBootstrap);
```

## 3. REST API / Docker
```bash
docker compose up -d
curl http://127.0.0.1:3000/health
```
