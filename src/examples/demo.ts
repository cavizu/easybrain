import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import { TieredMemoryClient } from '../index.js';

dotenv.config();

async function runDemo() {
  console.log('===============================================================');
  console.log('🧠 EASYBRAIN v1.2: PER-PROJECT PERSISTENT MEMORY DEMO');
  console.log('===============================================================\n');

  const demoProjectPath = path.join(os.tmpdir(), `easybrain-demo-${Date.now()}`);
  const memory = new TieredMemoryClient({
    projectPath: demoProjectPath,
    autoConsolidateThreshold: 0,
  });

  console.log(`📦 Storage Engine : ${memory.providerName.toUpperCase()}`);
  console.log(`⚙️  Mode           : ${memory.mode.toUpperCase()} (${memory.mode === 'basic' ? 'Zero-API-Key' : 'AI Librarian + Vectors'})`);
  console.log(`📁 Project ID     : ${memory.projectId}\n`);

  // Step 1: Save a structured Project State Checkpoint
  console.log('--- STEP 1: Saving Project State Checkpoint ---');
  await memory.saveCheckpoint({
    objective: 'Build a high-throughput Pix payments microservice.',
    stack: ['Node.js', 'TypeScript', 'PostgreSQL', 'Redis'],
    architecture: 'Hexagonal architecture with ephemeral gateway.',
    currentTask: 'Implement disaster recovery and backup policies.',
    importantDecisions: ['RPO = 5 seconds, RTO = 15 minutes with multi-zone replication.'],
    nextSteps: ['Add integration tests for webhook retries.'],
    relevantFiles: ['src/payments/pix-gateway.ts', 'sql/schema.sql'],
  });
  console.log('✓ Saved Project State Snapshot (v1)\n');

  // Step 2: Bootstrap a brand-new chat session
  console.log('--- STEP 2: Session Bootstrap (New Chat Continuity) ---');
  const boot = await memory.bootstrap({ maxTokens: 1000 });
  console.log(boot.formattedBootstrap);
  console.log(`(Estimated Bootstrap Tokens: ~${boot.estimatedTokens})\n`);

  // Step 3: Ingest raw conversation turns
  console.log('--- STEP 3: Ingesting Raw Turns & Recall ---');
  await memory.ingestMessage(
    'session_1',
    'user',
    'Remember to configure Redis timeout to 5000ms for Pix idempotency keys.'
  );

  if (memory.mode === 'enriched') {
    const libRes = await memory.runLibrarian('session_1');
    console.log('Librarian Result:', libRes.status);
  }

  const recall = await memory.retrieveContext('What Redis timeout was configured for Pix?');
  console.log('\nRecalled Context:');
  console.log(recall.formattedContext);

  console.log('\n✅ EasyBrain v1.2 Demo completed successfully.');
}

runDemo().catch((err) => {
  console.error('Demo error:', err);
});
