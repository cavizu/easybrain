#!/usr/bin/env node
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { TieredMemoryClient } from '../index.js';

dotenv.config({ quiet: true } as Parameters<typeof dotenv.config>[0]);

const server = new McpServer({
  name: 'easybrain-memory',
  version: '1.2.1',
});

function createClientForProject(projectPath?: string, projectId?: string): TieredMemoryClient {
  if (!projectPath && !projectId) {
    throw new Error(
      'Missing project scope: you must provide either "projectPath" (workspace root directory) or an explicit "projectId". EasyBrain never guesses cwd automatically.'
    );
  }
  return new TieredMemoryClient({
    projectPath,
    projectId,
  });
}

server.tool(
  'easybrain_bootstrap',
  'Retrieves the compact Project State Snapshot (objective, stack, decisions, current task, next steps) for a specific project at the start of a session.',
  {
    projectPath: z.string().optional().describe('Absolute path to the project root directory'),
    projectId: z.string().optional().describe('Explicit projectId (if not using projectPath)'),
    maxTokens: z.number().int().min(200).max(4000).optional().describe('Max token budget (default: 1000)'),
  },
  async ({ projectPath, projectId, maxTokens }) => {
    const client = createClientForProject(projectPath, projectId);
    const res = await client.bootstrap({ maxTokens });
    return {
      content: [{ type: 'text', text: res.formattedBootstrap }],
    };
  }
);

server.tool(
  'easybrain_save',
  'Saves a key decision/event into project memory AND/OR updates the structured Project State Checkpoint.',
  {
    projectPath: z.string().optional().describe('Absolute path to the project root directory'),
    projectId: z.string().optional().describe('Explicit projectId'),
    sessionId: z.string().optional().default('mcp-session').describe('Current chat/session identifier'),
    role: z.enum(['user', 'assistant', 'system', 'tool', 'agent']).optional().default('assistant'),
    content: z.string().optional().describe('Important message, decision, or note to archive'),
    checkpoint: z
      .object({
        objective: z.string().optional(),
        stack: z.array(z.string()).optional(),
        architecture: z.string().optional(),
        currentTask: z.string().optional(),
        completed: z.array(z.string()).optional(),
        nextSteps: z.array(z.string()).optional(),
        activeBlockers: z.array(z.string()).optional(),
        importantDecisions: z.array(z.string()).optional(),
        relevantFiles: z.array(z.string()).optional(),
      })
      .optional()
      .describe('Optional structured project state checkpoint update'),
  },
  async ({ projectPath, projectId, sessionId, role, content, checkpoint }) => {
    const client = createClientForProject(projectPath, projectId);
    const outputs: string[] = [];

    if (content && content.trim()) {
      const log = await client.ingestMessage(sessionId, role, content);
      outputs.push(
        `Saved raw memory (Log ID: ${log.id}, Provider: ${client.providerName}, Mode: ${client.mode}).`
      );
    }

    if (checkpoint && Object.keys(checkpoint).length > 0) {
      const state = await client.saveCheckpoint(checkpoint, { sessionId });
      outputs.push(
        `Updated Project State Checkpoint to v${state.version} for project ${state.projectId}.`
      );
    }

    if (outputs.length === 0) {
      throw new Error('Provide either "content" or "checkpoint" to save.');
    }

    return {
      content: [{ type: 'text', text: outputs.join('\n') }],
    };
  }
);

server.tool(
  'easybrain_recall',
  'Searches past project memories (semantic vectors in Enriched Mode or keyword search in Basic Mode) plus recent unconsolidated turns.',
  {
    projectPath: z.string().optional().describe('Absolute path to the project root directory'),
    projectId: z.string().optional().describe('Explicit projectId'),
    query: z.string().min(1).describe('Focused question or keywords to search in this project'),
    matchCount: z.number().int().min(1).max(20).optional().default(5),
    maxContextTokens: z.number().int().min(200).max(4000).optional().default(1500),
  },
  async ({ projectPath, projectId, query, matchCount, maxContextTokens }) => {
    const client = createClientForProject(projectPath, projectId);
    const res = await client.retrieveContext(query, {
      matchCount,
      maxContextTokens,
    });
    return {
      content: [
        {
          type: 'text',
          text:
            res.formattedContext ||
            `No matching memories found in project "${client.projectId}" for query: "${query}".`,
        },
      ],
    };
  }
);

server.tool(
  'easybrain_get_sources',
  'Fetches original verbatim raw logs by UUID pointers strictly within the specified project.',
  {
    projectPath: z.string().optional().describe('Absolute path to the project root directory'),
    projectId: z.string().optional().describe('Explicit projectId'),
    rawLogIds: z.array(z.string().uuid()).min(1).max(50).describe('Array of raw log UUIDs'),
  },
  async ({ projectPath, projectId, rawLogIds }) => {
    const client = createClientForProject(projectPath, projectId);
    const logs = await client.getRawLogs(rawLogIds);
    return {
      content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[EasyBrain MCP Error]', err);
  process.exit(1);
});
