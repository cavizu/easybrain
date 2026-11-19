import { LLMProvider } from './llm-provider.js';
import { HotStorageService } from './hot-storage.js';
import { ColdStorageService } from './cold-storage.js';
import {
  RetrieveContextResponse,
  RetrievedContextItem,
  RawLog,
} from '../types/index.js';

export interface RetrieveContextOptions {
  sessionId?: string;
  matchThreshold?: number;
  matchCount?: number;
  includeRecentUnprocessed?: boolean;
  recentMessagesLimit?: number;
  maxContextTokens?: number;
}

export class ContextRetriever {
  constructor(
    private llmProvider: LLMProvider,
    private hotStorage: HotStorageService,
    private coldStorage?: ColdStorageService
  ) {}

  async retrieveContext(
    projectId: string,
    userQuery: string,
    options: RetrieveContextOptions = {}
  ): Promise<RetrieveContextResponse> {
    if (!projectId || !userQuery) {
      throw new Error('retrieveContext requires projectId and userQuery.');
    }

    const {
      sessionId,
      matchThreshold = 0.25,
      matchCount = 5,
      includeRecentUnprocessed = true,
      recentMessagesLimit = Number(process.env.RECENT_MESSAGES_LIMIT) || 6,
      maxContextTokens = 2000,
    } = options;

    const mode: 'basic' | 'enriched' = this.llmProvider.isConfigured
      ? 'enriched'
      : 'basic';

    const [queryEmbedding, recentUnprocessedLogs] = await Promise.all([
      mode === 'enriched'
        ? this.llmProvider.generateEmbedding(userQuery)
        : Promise.resolve(undefined),
      includeRecentUnprocessed && this.coldStorage
        ? this.coldStorage.getRecentUnprocessedLogs(
            projectId,
            recentMessagesLimit,
            sessionId
          )
        : Promise.resolve([] as RawLog[]),
    ]);

    const searchResults = await this.hotStorage.searchSimilar({
      projectId,
      queryEmbedding,
      queryText: userQuery,
      sessionId,
      matchThreshold,
      matchCount,
    });

    const items: RetrievedContextItem[] = searchResults.map((result) => ({
      memoryVectorId: result.id,
      summary: result.summary,
      keyEntities: Array.isArray(result.key_entities) ? result.key_entities : [],
      similarity: Number(result.similarity.toFixed(4)),
      createdAt: result.created_at,
      rawLogPointers: result.raw_log_ids || [],
    }));

    const formattedContext = this.buildContextPrompt(
      items,
      recentUnprocessedLogs,
      maxContextTokens
    );

    return {
      projectId,
      sessionId,
      query: userQuery,
      mode,
      items,
      recentUnprocessedLogs,
      formattedContext,
    };
  }

  private buildContextPrompt(
    items: RetrievedContextItem[],
    recentLogs: RawLog[],
    maxContextTokens: number
  ): string {
    const sections: string[] = [];
    const maxChars = Math.max(40, maxContextTokens * 4);

    if (items.length > 0) {
      const entries = items.map((item, i) => {
        const entities =
          item.keyEntities.length > 0
            ? ` [Tags: ${item.keyEntities.join(', ')}]`
            : '';
        const pointerInfo = `(Pointers: ${item.rawLogPointers.join(', ')})`;
        return `[Memory #${i + 1} | Score: ${(item.similarity * 100).toFixed(1)}%]${entities}\n${item.summary}\n${pointerInfo}`;
      });
      sections.push(`=== RELEVANT PROJECT MEMORY ===\n${entries.join('\n\n')}`);
    }

    if (recentLogs.length > 0) {
      const recentLines = recentLogs.map(
        (log) => `[${log.role.toUpperCase()}]: ${log.content}`
      );
      sections.push(`=== RECENT UNCONSOLIDATED TURNS ===\n${recentLines.join('\n')}`);
    }

    if (sections.length === 0) return '';

    const full = `${sections.join('\n\n')}\n===================================`;
    if (full.length <= maxChars) {
      return full;
    }

    const suffix = '\n...[truncated]';
    return full.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
  }
}
