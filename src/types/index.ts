/**
 * Type definitions for EasyBrain v1.2 (Per-Project Persistent Memory & MCP Skill).
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'agent';

export type StorageProviderType = 'local' | 'supabase' | 'auto';

export interface ProjectContext {
  projectId: string;
  rootPath?: string;
  sessionId?: string;
  clientId?: string;
}

export interface ProjectState {
  projectId: string;
  objective: string;
  stack: string[];
  architecture: string;
  currentTask: string;
  completed: string[];
  nextSteps: string[];
  activeBlockers: string[];
  importantDecisions: string[];
  relevantFiles: string[];
  sourceLogIds: string[];
  version: number;
  updatedAt: string;
}

export type ProjectStateUpdate = Partial<
  Omit<ProjectState, 'projectId' | 'version' | 'updatedAt'>
>;

export interface BootstrapResponse {
  projectId: string;
  hasMemory: boolean;
  storageProvider: 'local' | 'supabase';
  mode: 'basic' | 'enriched';
  state: ProjectState | null;
  recentUnprocessedCount: number;
  estimatedTokens: number;
  formattedBootstrap: string;
}

export interface RawLog {
  id: string;
  project_id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
  token_count?: number;
  is_processed: boolean;
  locked_until?: string | null;
  lock_token?: string | null;
  processed_at?: string | null;
  created_at: string;
}

export interface MemoryVector {
  id: string;
  project_id: string;
  session_id: string;
  summary: string;
  key_entities: string[];
  raw_log_ids: string[];
  embedding: number[];
  embedding_model?: string;
  batch_hash?: string;
  token_count?: number;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface VectorSearchResult {
  id: string;
  project_id: string;
  session_id: string;
  summary: string;
  key_entities: string[];
  raw_log_ids: string[];
  metadata: Record<string, unknown>;
  similarity: number;
  created_at: string;
}

export interface LibrarianResult {
  projectId: string;
  sessionId: string;
  status: 'PROCESSED' | 'NO_NEW_MESSAGES' | 'SKIPPED_BASIC_MODE' | 'FAILED';
  processedCount: number;
  rawLogIds: string[];
  summary?: string;
  keyEntities?: string[];
  memoryVectorId?: string;
  error?: string;
}

export interface RetrievedContextItem {
  memoryVectorId: string;
  summary: string;
  keyEntities: string[];
  similarity: number;
  createdAt: string;
  rawLogPointers: string[];
}

export interface RetrieveContextResponse {
  projectId: string;
  sessionId?: string;
  query: string;
  mode: 'basic' | 'enriched';
  items: RetrievedContextItem[];
  recentUnprocessedLogs: RawLog[];
  formattedContext: string;
}

export interface MemoryConfig {
  /** Explicit projectId (optional if projectPath is provided) */
  projectId?: string;
  /** Project root directory path for auto-resolving .easybrain/project.json */
  projectPath?: string;
  /** 'local' (per-project zero-config), 'supabase' (personal cloud pgvector), or 'auto' */
  storageProvider?: StorageProviderType;
  /** Custom local file path override */
  localStoragePath?: string;
  /** Personal Supabase URL */
  supabaseUrl?: string;
  /** Personal Supabase Service Role Key */
  supabaseKey?: string;
  /** Optional LLM API key (omit for Basic Zero-Cost Mode) */
  openaiApiKey?: string;
  /** Optional Base URL (Groq, Ollama, OpenRouter, DeepSeek) */
  openaiBaseUrl?: string;
  librarianModel?: string;
  embeddingApiKey?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  autoConsolidateThreshold?: number;
}

export interface ClaimBatchParams {
  projectId: string;
  sessionId?: string;
  limit: number;
  leaseSeconds?: number;
  lockToken: string;
}

export interface CommitMemoryParams {
  projectId: string;
  sessionId: string;
  summary: string;
  keyEntities: string[];
  rawLogIds: string[];
  embedding: number[];
  embeddingModel?: string;
  batchHash?: string;
  lockToken?: string;
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}

export interface SearchMemoryParams {
  projectId: string;
  queryEmbedding?: number[];
  queryText?: string;
  sessionId?: string;
  matchThreshold?: number;
  matchCount?: number;
}

export interface IMemoryStorageAdapter {
  readonly providerName: 'local' | 'supabase';
  getProjectState(projectId: string): Promise<ProjectState | null>;
  upsertProjectState(projectId: string, update: ProjectStateUpdate): Promise<ProjectState>;
  insertRawLog(
    projectId: string,
    sessionId: string,
    role: MessageRole,
    content: string,
    metadata: Record<string, unknown>,
    tokenCount: number
  ): Promise<RawLog>;
  getRawLogsByIds(projectId: string, logIds: string[]): Promise<RawLog[]>;
  getRecentUnprocessedLogs(projectId: string, limit: number, sessionId?: string): Promise<RawLog[]>;
  countUnprocessed(projectId: string, sessionId?: string): Promise<number>;
  claimUnprocessedLogs(params: ClaimBatchParams): Promise<RawLog[]>;
  releaseClaimedLogs(projectId: string, rawLogIds: string[], lockToken?: string): Promise<void>;
  commitConsolidatedMemory(params: CommitMemoryParams): Promise<MemoryVector>;
  searchSimilarVectors(params: SearchMemoryParams): Promise<VectorSearchResult[]>;
}
