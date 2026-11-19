#!/usr/bin/env node
import Fastify from 'fastify';
import dotenv from 'dotenv';
import { z } from 'zod';
import { TieredMemoryClient } from '../index.js';

dotenv.config();

const IngestSchema = z.object({
  projectId: z.string().min(1).max(256).default('default'),
  sessionId: z.string().min(1).max(256),
  role: z.enum(['user', 'assistant', 'system', 'tool', 'agent']),
  content: z.string().min(1).max(100000),
  metadata: z.record(z.unknown()).optional(),
});

const CheckpointSchema = z.object({
  projectId: z.string().min(1).max(256).default('default'),
  sessionId: z.string().min(1).max(256).optional(),
  objective: z.string().optional(),
  stack: z.array(z.string()).optional(),
  architecture: z.string().optional(),
  currentTask: z.string().optional(),
  completed: z.array(z.string()).optional(),
  nextSteps: z.array(z.string()).optional(),
  activeBlockers: z.array(z.string()).optional(),
  importantDecisions: z.array(z.string()).optional(),
  relevantFiles: z.array(z.string()).optional(),
});

const BootstrapSchema = z.object({
  projectId: z.string().min(1).max(256).default('default'),
  maxTokens: z.number().int().min(200).max(4000).optional(),
});

const LibrarianRunSchema = z.object({
  projectId: z.string().min(1).max(256).default('default'),
  sessionId: z.string().min(1).max(256).optional(),
  batchSize: z.number().int().min(1).max(200).optional(),
  maxBatchTokens: z.number().int().min(200).max(32000).optional(),
});

const RetrieveSchema = z.object({
  projectId: z.string().min(1).max(256).default('default'),
  sessionId: z.string().min(1).max(256).optional(),
  query: z.string().min(1).max(10000),
  matchThreshold: z.number().min(0).max(1).optional(),
  matchCount: z.number().int().min(1).max(50).optional(),
  includeRecentUnprocessed: z.boolean().optional(),
  recentMessagesLimit: z.number().int().min(0).max(50).optional(),
});

const DecompressSchema = z.object({
  projectId: z.string().min(1).max(256).default('default'),
  rawLogIds: z.array(z.string().uuid()).min(1).max(100),
});

export function buildServer(customClient?: TieredMemoryClient) {
  const server = Fastify({ logger: true });

  let memoryClient: TieredMemoryClient | undefined = customClient;
  let initError: string | null = null;

  if (!memoryClient) {
    try {
      memoryClient = new TieredMemoryClient();
    } catch (err) {
      initError = (err as Error).message;
      server.log.warn(`TieredMemoryClient initialization deferred: ${initError}`);
    }
  }

  server.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const configuredKey = process.env.API_KEY?.trim();
    if (!configuredKey) return;

    const authHeader = request.headers.authorization;
    const apiKeyHeader = request.headers['x-api-key'];
    const bearer =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : undefined;
    const provided =
      bearer || (typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : undefined);

    if (provided !== configuredKey) {
      return reply.status(401).send({ error: 'Unauthorized: Invalid or missing API_KEY' });
    }
  });

  server.get('/health', async (_request, reply) => {
    if (!memoryClient) {
      return reply.status(503).send({
        status: 'unhealthy',
        ready: false,
        error: initError || 'Client uninitialized',
        timestamp: new Date().toISOString(),
      });
    }
    return reply.status(200).send({
      status: 'healthy',
      ready: true,
      storageProvider: memoryClient.providerName,
      mode: memoryClient.mode,
      timestamp: new Date().toISOString(),
    });
  });

  server.post('/api/memory/bootstrap', async (request, reply) => {
    if (!memoryClient) return reply.status(503).send({ error: initError });
    const parsed = BootstrapSchema.safeParse(request.body || {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const res = await memoryClient.bootstrap(parsed.data);
    return reply.status(200).send(res);
  });

  server.post('/api/memory/checkpoint', async (request, reply) => {
    if (!memoryClient) return reply.status(503).send({ error: initError });
    const parsed = CheckpointSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { projectId, sessionId, ...update } = parsed.data;
    const state = await memoryClient.saveCheckpoint(update, { projectId, sessionId });
    return reply.status(200).send(state);
  });

  server.post('/api/memory/ingest', async (request, reply) => {
    if (!memoryClient) return reply.status(503).send({ error: initError });
    const parsed = IngestSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { projectId, sessionId, role, content, metadata } = parsed.data;
    const log = await memoryClient.ingestMessage(sessionId, role, content, metadata, projectId);
    return reply.status(201).send({ success: true, logId: log.id, projectId: log.project_id });
  });

  server.post('/api/memory/librarian/run', async (request, reply) => {
    if (!memoryClient) return reply.status(503).send({ error: initError });
    const parsed = LibrarianRunSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const result = await memoryClient.runLibrarian(parsed.data.sessionId, parsed.data);
    return reply.status(200).send(result);
  });

  server.post('/api/memory/retrieve', async (request, reply) => {
    if (!memoryClient) return reply.status(503).send({ error: initError });
    const parsed = RetrieveSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const { query, ...opts } = parsed.data;
    const context = await memoryClient.retrieveContext(query, opts);
    return reply.status(200).send(context);
  });

  server.post('/api/memory/logs/decompress', async (request, reply) => {
    if (!memoryClient) return reply.status(503).send({ error: initError });
    const parsed = DecompressSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const logs = await memoryClient.getRawLogs(parsed.data.rawLogIds, parsed.data.projectId);
    return reply.status(200).send({ logs });
  });

  return server;
}

const start = async () => {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';

  if (host !== '127.0.0.1' && host !== 'localhost' && !process.env.API_KEY?.trim()) {
    console.warn(
      '⚠️ Security Warning: HOST is exposed beyond localhost without API_KEY set in .env.'
    );
  }

  const server = buildServer();
  try {
    await server.listen({ port, host });
    console.log(`🚀 EasyBrain v1.2 API running at http://${host}:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

if (
  process.argv[1]?.endsWith('server.ts') ||
  process.argv[1]?.endsWith('server.js') ||
  process.argv[1]?.endsWith('easybrain-api')
) {
  start();
}
