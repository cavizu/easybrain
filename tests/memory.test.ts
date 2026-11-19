import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  TieredMemoryClient,
  LocalStorageAdapter,
  LLMProvider,
} from '../src/index.js';

class MockLLMProvider extends LLMProvider {
  constructor() {
    super({ apiKey: 'test-mock-key' });
  }

  override async generateEmbedding(text: string): Promise<number[]> {
    const lower = text.toLowerCase();
    if (lower.includes('pix') || lower.includes('redis')) return [1, 0, 0, 0];
    if (lower.includes('rto') || lower.includes('backup')) return [0, 1, 0, 0];
    return [0.5, 0.5, 0, 0];
  }

  override async summarizeInteractionBatch(
    messages: Array<{ role: string; content: string }>
  ): Promise<{ summary: string; keyEntities: string[] }> {
    return {
      summary: `Consolidated (${messages.length} msgs): ${messages.map((m) => m.content).join(' | ')}`,
      keyEntities: ['Pix', 'Redis', 'PostgreSQL'],
    };
  }
}

test('1. Basic Mode (Zero API Key): Project Isolation (A vs B), Checkpoint & Bootstrap', async () => {
  const tempFile = path.join(os.tmpdir(), `easybrain-basic-${Date.now()}.json`);
  const storage = new LocalStorageAdapter(tempFile);
  const basicLlm = new LLMProvider({ apiKey: '' }); // No API key!

  const clientA = new TieredMemoryClient(
    { projectId: 'project-A', autoConsolidateThreshold: 0 },
    { storage, llmProvider: basicLlm }
  );
  const clientB = new TieredMemoryClient(
    { projectId: 'project-B', autoConsolidateThreshold: 0 },
    { storage, llmProvider: basicLlm }
  );

  assert.equal(clientA.mode, 'basic');

  // Save checkpoint and raw log in Project A
  await clientA.saveCheckpoint({
    objective: 'Project A Payment Gateway',
    stack: ['Node.js', 'PostgreSQL'],
    currentTask: 'Setup Pix webhooks',
  });
  const logA = await clientA.ingestMessage('chat-1', 'user', 'Use Redis timeout 5000ms for Project A.');

  // Bootstrap Project A succeeds
  const bootA = await clientA.bootstrap();
  assert.equal(bootA.hasMemory, true);
  assert.ok(bootA.formattedBootstrap.includes('Project A Payment Gateway'));

  // Bootstrap Project B must NOT see Project A
  const bootB = await clientB.bootstrap();
  assert.equal(bootB.hasMemory, false);
  assert.equal(bootB.state, null);

  // Recall in Project B must NOT see Project A logs
  const recallB = await clientB.retrieveContext('Redis timeout');
  assert.equal(recallB.items.length, 0);
  assert.equal(recallB.recentUnprocessedLogs.length, 0);

  // Decompression by ID from Project B must NOT return Project A's log
  const leakAttempt = await clientB.getRawLogs([logA.id]);
  assert.equal(leakAttempt.length, 0);

  // Lexical Recall in Project A works without any API key
  const recallA = await clientA.retrieveContext('Redis timeout');
  assert.ok(recallA.items.length >= 1);

  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
});

test('2. Enriched Mode: Strict Lock Token Ownership, Atomic Commit & Hybrid Retrieval', async () => {
  const tempFile = path.join(os.tmpdir(), `easybrain-enriched-${Date.now()}.json`);
  const storage = new LocalStorageAdapter(tempFile);
  const mockLlm = new MockLLMProvider();

  const client = new TieredMemoryClient(
    { projectId: 'project-enriched', autoConsolidateThreshold: 0 },
    { storage, llmProvider: mockLlm }
  );

  assert.equal(client.mode, 'enriched');

  const log1 = await client.ingestMessage('s1', 'user', 'Configure Pix with Redis.');
  const log2 = await client.ingestMessage('s1', 'assistant', 'Pix and Redis configured.');

  // Claim with worker 1
  const claimed = await storage.claimUnprocessedLogs({
    projectId: 'project-enriched',
    limit: 10,
    leaseSeconds: 60,
    lockToken: 'token-worker-1',
  });
  assert.equal(claimed.length, 2);

  // Stale worker with wrong token MUST fail to commit
  await assert.rejects(
    async () => {
      await storage.commitConsolidatedMemory({
        projectId: 'project-enriched',
        sessionId: 's1',
        summary: 'Stale summary',
        keyEntities: [],
        rawLogIds: [log1.id, log2.id],
        embedding: [1, 0, 0, 0],
        lockToken: 'token-stale-worker',
      });
    },
    /Lock ownership validation failed/
  );

  // Release with correct token and run Librarian normally
  await storage.releaseClaimedLogs('project-enriched', [log1.id, log2.id], 'token-worker-1');
  const libRes = await client.runLibrarian('s1');
  assert.equal(libRes.status, 'PROCESSED');
  assert.equal(libRes.processedCount, 2);

  // Add fresh unconsolidated turn + retrieve Hybrid Context
  await client.ingestMessage('s2', 'user', 'Changed server port to 8080.');
  const ctx = await client.retrieveContext('How is Pix configured?');
  assert.equal(ctx.items.length, 1);
  assert.equal(ctx.recentUnprocessedLogs.length, 1);
  assert.ok(ctx.formattedContext.includes('RELEVANT PROJECT MEMORY'));
  assert.ok(ctx.formattedContext.includes('8080'));

  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
});
