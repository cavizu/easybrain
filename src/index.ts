import dotenv from 'dotenv';
import { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './db/supabase.js';
import { LocalStorageAdapter } from './db/local-adapter.js';
import { SupabaseStorageAdapter } from './db/supabase-adapter.js';
import { ProjectResolver } from './core/project-resolver.js';
import { LLMProvider } from './services/llm-provider.js';
import { ColdStorageService } from './services/cold-storage.js';
import { HotStorageService } from './services/hot-storage.js';
import { LibrarianWorker, LibrarianOptions } from './services/librarian.js';
import { ContextRetriever, RetrieveContextOptions } from './services/retriever.js';
import {
  MessageRole,
  RawLog,
  MemoryConfig,
  LibrarianResult,
  RetrieveContextResponse,
  IMemoryStorageAdapter,
  ProjectState,
  ProjectStateUpdate,
  BootstrapResponse,
} from './types/index.js';

dotenv.config();

export * from './types/index.js';
export { ProjectResolver } from './core/project-resolver.js';
export { LocalStorageAdapter } from './db/local-adapter.js';
export { SupabaseStorageAdapter } from './db/supabase-adapter.js';
export { ColdStorageService } from './services/cold-storage.js';
export { HotStorageService } from './services/hot-storage.js';
export { LibrarianWorker } from './services/librarian.js';
export { ContextRetriever } from './services/retriever.js';
export { LLMProvider } from './services/llm-provider.js';

/**
 * TieredMemoryClient (v1.2.1):
 * Per-project persistent memory engine supporting:
 * - Local Zero-Config storage (<project>/.easybrain/memory.json) OR Personal Supabase (pgvector)
 * - Basic Mode (no API key needed: checkpoints, bootstrap, lexical search)
 * - Enriched Mode (Librarian summarization + vector embeddings)
 */
export class TieredMemoryClient {
  public readonly projectId: string;
  public readonly rootPath?: string;
  public storage: IMemoryStorageAdapter;
  public supabase?: SupabaseClient;
  public llmProvider: LLMProvider;
  public coldStorage: ColdStorageService;
  public hotStorage: HotStorageService;
  public librarian: LibrarianWorker;
  public retriever: ContextRetriever;
  private autoConsolidateThreshold: number;
  private activeConsolidations = new Set<string>();

  constructor(
    config?: Partial<MemoryConfig>,
    customDeps?: {
      storage?: IMemoryStorageAdapter;
      llmProvider?: LLMProvider;
    }
  ) {
    let resolvedLocalDbPath = config?.localStoragePath;
    if (config?.projectPath) {
      const ctx = ProjectResolver.resolveFromPath(config.projectPath);
      this.projectId = config.projectId || ctx.projectId;
      this.rootPath = ctx.rootPath;
      resolvedLocalDbPath = resolvedLocalDbPath || ctx.localDbPath;
    } else {
      this.projectId = config?.projectId || 'default';
    }

    if (customDeps?.storage) {
      this.storage = customDeps.storage;
    } else {
      const requestedProvider =
        config?.storageProvider ||
        (process.env.STORAGE_PROVIDER as MemoryConfig['storageProvider']) ||
        'auto';

      const hasSupabaseCreds = Boolean(
        (config?.supabaseUrl || process.env.SUPABASE_URL) &&
          (config?.supabaseKey ||
            process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.SUPABASE_KEY)
      );

      if (
        requestedProvider === 'supabase' ||
        (requestedProvider === 'auto' && hasSupabaseCreds)
      ) {
        this.supabase = getSupabaseClient(config?.supabaseUrl, config?.supabaseKey);
        this.storage = new SupabaseStorageAdapter(this.supabase);
      } else {
        this.storage = new LocalStorageAdapter(resolvedLocalDbPath);
      }
    }

    this.llmProvider =
      customDeps?.llmProvider ||
      new LLMProvider({
        apiKey: config?.openaiApiKey,
        baseURL: config?.openaiBaseUrl,
        librarianModel: config?.librarianModel,
        embeddingApiKey: config?.embeddingApiKey,
        embeddingBaseURL: config?.embeddingBaseUrl,
        embeddingModel: config?.embeddingModel,
        embeddingDimensions: config?.embeddingDimensions,
      });

    this.coldStorage = new ColdStorageService(this.storage);
    this.hotStorage = new HotStorageService(this.storage);
    this.librarian = new LibrarianWorker(
      this.storage,
      this.llmProvider,
      this.hotStorage
    );
    this.retriever = new ContextRetriever(
      this.llmProvider,
      this.hotStorage,
      this.coldStorage
    );

    const envThreshold = process.env.AUTO_CONSOLIDATE_THRESHOLD
      ? Number(process.env.AUTO_CONSOLIDATE_THRESHOLD)
      : 10;
    this.autoConsolidateThreshold =
      config?.autoConsolidateThreshold !== undefined
        ? config.autoConsolidateThreshold
        : envThreshold;
  }

  get providerName(): 'local' | 'supabase' {
    return this.storage.providerName;
  }

  get mode(): 'basic' | 'enriched' {
    return this.llmProvider.isConfigured ? 'enriched' : 'basic';
  }

  async bootstrap(options?: {
    projectId?: string;
    maxTokens?: number;
  }): Promise<BootstrapResponse> {
    const targetProject = options?.projectId || this.projectId;
    const maxTokens =
      options?.maxTokens || Number(process.env.BOOTSTRAP_MAX_TOKENS) || 1000;

    const [state, pendingCount] = await Promise.all([
      this.storage.getProjectState(targetProject),
      this.coldStorage.countUnprocessed(targetProject),
    ]);

    if (!state) {
      const emptyMsg = `[EasyBrain Bootstrap] No saved project state yet for project "${targetProject}". Pending raw logs: ${pendingCount}.`;
      return {
        projectId: targetProject,
        hasMemory: pendingCount > 0,
        storageProvider: this.providerName,
        mode: this.mode,
        state: null,
        recentUnprocessedCount: pendingCount,
        estimatedTokens: Math.ceil(emptyMsg.length / 4),
        formattedBootstrap: emptyMsg,
      };
    }

    const lines: string[] = [
      `=== EASYBRAIN PROJECT STATE (v${state.version} | Updated: ${state.updatedAt}) ===`,
    ];
    if (state.objective) lines.push(`Objective: ${state.objective}`);
    if (state.stack.length > 0) lines.push(`Stack: ${state.stack.join(', ')}`);
    if (state.architecture) lines.push(`Architecture: ${state.architecture}`);
    if (state.currentTask) lines.push(`Current Task: ${state.currentTask}`);
    if (state.importantDecisions.length > 0) {
      lines.push(
        `Important Decisions:\n${state.importantDecisions.map((d) => `- ${d}`).join('\n')}`
      );
    }
    if (state.completed.length > 0) {
      lines.push(`Completed:\n${state.completed.map((c) => `- ${c}`).join('\n')}`);
    }
    if (state.nextSteps.length > 0) {
      lines.push(`Next Steps:\n${state.nextSteps.map((n) => `- ${n}`).join('\n')}`);
    }
    if (state.activeBlockers.length > 0) {
      lines.push(
        `Active Blockers:\n${state.activeBlockers.map((b) => `- ${b}`).join('\n')}`
      );
    }
    if (state.relevantFiles.length > 0) {
      lines.push(`Relevant Files: ${state.relevantFiles.join(', ')}`);
    }
    lines.push(
      'Note: Memory is a continuity index. Verify current source files before editing.'
    );

    let formatted = lines.join('\n');
    const maxChars = Math.max(40, maxTokens * 4);
    if (formatted.length > maxChars) {
      formatted = formatted.slice(0, maxChars - 15) + '\n...[truncated]';
    }

    return {
      projectId: targetProject,
      hasMemory: true,
      storageProvider: this.providerName,
      mode: this.mode,
      state,
      recentUnprocessedCount: pendingCount,
      estimatedTokens: Math.ceil(formatted.length / 4),
      formattedBootstrap: formatted,
    };
  }

  async saveCheckpoint(
    update: ProjectStateUpdate,
    options?: { projectId?: string; sessionId?: string }
  ): Promise<ProjectState> {
    const targetProject = options?.projectId || this.projectId;
    const sessionId = options?.sessionId || 'checkpoint';

    const auditLog = await this.coldStorage.ingestMessage(
      targetProject,
      sessionId,
      'system',
      `[CHECKPOINT] ${JSON.stringify(update)}`,
      { type: 'checkpoint' }
    );

    const existing = await this.storage.getProjectState(targetProject);
    const mergedSourceIds = Array.from(
      new Set([...(existing?.sourceLogIds || []), auditLog.id])
    ).slice(-50);

    return this.storage.upsertProjectState(targetProject, {
      ...update,
      sourceLogIds: mergedSourceIds,
    });
  }

  async ingestMessage(
    sessionId: string,
    role: MessageRole,
    content: string,
    metadata?: Record<string, unknown>,
    projectId?: string
  ): Promise<RawLog> {
    const targetProject = projectId || this.projectId;
    const rawLog = await this.coldStorage.ingestMessage(
      targetProject,
      sessionId,
      role,
      content,
      metadata
    );

    const key = `${targetProject}:${sessionId}`;
    if (
      this.llmProvider.isConfigured &&
      this.autoConsolidateThreshold > 0 &&
      !this.activeConsolidations.has(key)
    ) {
      this.coldStorage
        .countUnprocessed(targetProject, sessionId)
        .then((pendingCount) => {
          if (
            pendingCount >= this.autoConsolidateThreshold &&
            !this.activeConsolidations.has(key)
          ) {
            this.activeConsolidations.add(key);
            this.runLibrarian(sessionId, { projectId: targetProject })
              .catch(() => {})
              .finally(() => {
                this.activeConsolidations.delete(key);
              });
          }
        })
        .catch(() => {});
    }

    return rawLog;
  }

  async runLibrarian(
    sessionId?: string,
    options?: LibrarianOptions & { projectId?: string }
  ): Promise<LibrarianResult> {
    const targetProject = options?.projectId || this.projectId;
    return this.librarian.runLibrarian(targetProject, {
      ...options,
      sessionId,
    });
  }

  async retrieveContext(
    userQuery: string,
    options?: RetrieveContextOptions & { projectId?: string }
  ): Promise<RetrieveContextResponse> {
    const targetProject = options?.projectId || this.projectId;
    return this.retriever.retrieveContext(targetProject, userQuery, options);
  }

  async getRawLogs(rawLogIds: string[], projectId?: string): Promise<RawLog[]> {
    const targetProject = projectId || this.projectId;
    return this.coldStorage.getRawLogsByIds(targetProject, rawLogIds);
  }

  async countUnprocessed(sessionId?: string, projectId?: string): Promise<number> {
    const targetProject = projectId || this.projectId;
    return this.coldStorage.countUnprocessed(targetProject, sessionId);
  }
}
