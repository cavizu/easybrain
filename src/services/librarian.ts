import crypto from 'node:crypto';
import { IMemoryStorageAdapter, LibrarianResult, RawLog } from '../types/index.js';
import { LLMProvider } from './llm-provider.js';
import { HotStorageService } from './hot-storage.js';

export interface LibrarianOptions {
  sessionId?: string;
  batchSize?: number;
  maxBatchTokens?: number;
  leaseSeconds?: number;
  metadata?: Record<string, unknown>;
}

export class LibrarianWorker {
  constructor(
    private storage: IMemoryStorageAdapter,
    private llmProvider: LLMProvider,
    private hotStorage: HotStorageService
  ) {}

  /**
   * Enforces maxBatchTokens strictly. If even the first log exceeds maxBatchTokens,
   * its transcript slice is truncated for the LLM while preserving the verbatim log in Cold Storage.
   */
  private capLogsByTokenBudget(
    logs: RawLog[],
    maxBatchTokens: number
  ): {
    selected: RawLog[];
    llmMessages: Array<{ role: string; content: string }>;
    overflowIds: string[];
  } {
    const selected: RawLog[] = [];
    const llmMessages: Array<{ role: string; content: string }> = [];
    const overflowIds: string[] = [];
    const maxChars = Math.max(40, maxBatchTokens * 4);
    let currentChars = 0;

    for (const log of logs) {
      const remainingChars = maxChars - currentChars;

      if (selected.length === 0) {
        const contentForLlm =
          log.content.length > remainingChars
            ? log.content.slice(0, Math.max(10, remainingChars - 14)) + '...[truncated]'
            : log.content;
        selected.push(log);
        llmMessages.push({ role: log.role, content: contentForLlm });
        currentChars += contentForLlm.length;
      } else if (log.content.length <= remainingChars) {
        selected.push(log);
        llmMessages.push({ role: log.role, content: log.content });
        currentChars += log.content.length;
      } else {
        overflowIds.push(log.id);
      }
    }

    return { selected, llmMessages, overflowIds };
  }

  async runLibrarian(
    projectId: string,
    options: LibrarianOptions = {}
  ): Promise<LibrarianResult> {
    const sessionId = options.sessionId || 'default';

    if (!this.llmProvider.isConfigured) {
      return {
        projectId,
        sessionId,
        status: 'SKIPPED_BASIC_MODE',
        processedCount: 0,
        rawLogIds: [],
      };
    }

    const batchSize = options.batchSize || 30;
    const maxBatchTokens = options.maxBatchTokens || 6000;
    const leaseSeconds = options.leaseSeconds || 300;
    const lockToken = crypto.randomUUID();

    const claimedLogs = await this.storage.claimUnprocessedLogs({
      projectId,
      sessionId: options.sessionId,
      limit: batchSize,
      leaseSeconds,
      lockToken,
    });

    if (!claimedLogs || claimedLogs.length === 0) {
      return {
        projectId,
        sessionId,
        status: 'NO_NEW_MESSAGES',
        processedCount: 0,
        rawLogIds: [],
      };
    }

    const { selected: logs, llmMessages, overflowIds } = this.capLogsByTokenBudget(
      claimedLogs,
      maxBatchTokens
    );

    if (overflowIds.length > 0) {
      await this.storage.releaseClaimedLogs(projectId, overflowIds, lockToken);
    }

    const rawLogIds = logs.map((log) => log.id);
    const batchHash = crypto
      .createHash('sha256')
      .update(`${projectId}:${rawLogIds.slice().sort().join(',')}`)
      .digest('hex');

    try {
      const synthesis = await this.llmProvider.summarizeInteractionBatch(llmMessages);

      const textToEmbed = `${synthesis.summary} Entities: ${synthesis.keyEntities.join(', ')}`;
      const embedding = await this.llmProvider.generateEmbedding(textToEmbed);

      const memoryVector = await this.hotStorage.commitConsolidatedMemory({
        projectId,
        sessionId: logs[0].session_id || sessionId,
        summary: synthesis.summary,
        keyEntities: synthesis.keyEntities,
        rawLogIds,
        embedding,
        embeddingModel: this.llmProvider.embeddingModel,
        batchHash,
        lockToken,
        tokenCount: Math.ceil(synthesis.summary.length / 4),
        metadata: {
          ...options.metadata,
          consolidated_message_count: logs.length,
          first_message_at: logs[0].created_at,
          last_message_at: logs[logs.length - 1].created_at,
        },
      });

      return {
        projectId,
        sessionId: logs[0].session_id || sessionId,
        status: 'PROCESSED',
        processedCount: logs.length,
        rawLogIds,
        summary: synthesis.summary,
        keyEntities: synthesis.keyEntities,
        memoryVectorId: memoryVector.id,
      };
    } catch (error) {
      await this.storage.releaseClaimedLogs(projectId, rawLogIds, lockToken);

      return {
        projectId,
        sessionId,
        status: 'FAILED',
        processedCount: 0,
        rawLogIds,
        error: (error as Error).message,
      };
    }
  }
}
