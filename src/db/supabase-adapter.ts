import { SupabaseClient } from '@supabase/supabase-js';
import {
  IMemoryStorageAdapter,
  MessageRole,
  RawLog,
  MemoryVector,
  VectorSearchResult,
  ProjectState,
  ProjectStateUpdate,
  ClaimBatchParams,
  CommitMemoryParams,
  SearchMemoryParams,
} from '../types/index.js';

/**
 * SupabaseStorageAdapter:
 * Implements EasyBrain v1.2 storage over a user's personal Supabase (PostgreSQL + pgvector)
 * with strict project_id isolation, project_states snapshots, and atomic lock_token RPCs.
 */
export class SupabaseStorageAdapter implements IMemoryStorageAdapter {
  public readonly providerName = 'supabase' as const;

  constructor(public readonly supabase: SupabaseClient) {}

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const { data, error } = await this.supabase
      .from('project_states')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch project state: ${error.message}`);
    }
    if (!data) return null;

    return {
      projectId: data.project_id,
      objective: data.objective || '',
      stack: data.stack || [],
      architecture: data.architecture || '',
      currentTask: data.current_task || '',
      completed: data.completed || [],
      nextSteps: data.next_steps || [],
      activeBlockers: data.active_blockers || [],
      importantDecisions: data.important_decisions || [],
      relevantFiles: data.relevant_files || [],
      sourceLogIds: data.source_log_ids || [],
      version: data.version || 1,
      updatedAt: data.updated_at,
    };
  }

  async upsertProjectState(
    projectId: string,
    update: ProjectStateUpdate
  ): Promise<ProjectState> {
    const existing = await this.getProjectState(projectId);
    const nextVersion = existing ? existing.version + 1 : 1;

    const payload = {
      project_id: projectId,
      objective: update.objective ?? existing?.objective ?? '',
      stack: update.stack ?? existing?.stack ?? [],
      architecture: update.architecture ?? existing?.architecture ?? '',
      current_task: update.currentTask ?? existing?.currentTask ?? '',
      completed: update.completed ?? existing?.completed ?? [],
      next_steps: update.nextSteps ?? existing?.nextSteps ?? [],
      active_blockers: update.activeBlockers ?? existing?.activeBlockers ?? [],
      important_decisions:
        update.importantDecisions ?? existing?.importantDecisions ?? [],
      relevant_files: update.relevantFiles ?? existing?.relevantFiles ?? [],
      source_log_ids: update.sourceLogIds ?? existing?.sourceLogIds ?? [],
      version: nextVersion,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from('project_states')
      .upsert(payload, { onConflict: 'project_id' })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Failed to upsert project state: ${error.message}`);
    }

    return {
      projectId: data.project_id,
      objective: data.objective || '',
      stack: data.stack || [],
      architecture: data.architecture || '',
      currentTask: data.current_task || '',
      completed: data.completed || [],
      nextSteps: data.next_steps || [],
      activeBlockers: data.active_blockers || [],
      importantDecisions: data.important_decisions || [],
      relevantFiles: data.relevant_files || [],
      sourceLogIds: data.source_log_ids || [],
      version: data.version || 1,
      updatedAt: data.updated_at,
    };
  }

  async insertRawLog(
    projectId: string,
    sessionId: string,
    role: MessageRole,
    content: string,
    metadata: Record<string, unknown>,
    tokenCount: number
  ): Promise<RawLog> {
    const { data, error } = await this.supabase
      .from('raw_logs')
      .insert({
        project_id: projectId,
        session_id: sessionId,
        role,
        content,
        metadata,
        token_count: tokenCount,
        is_processed: false,
      })
      .select('*')
      .single();

    if (error) {
      throw new Error(`Cold Storage Ingestion Error: ${error.message}`);
    }

    return data as RawLog;
  }

  async getRawLogsByIds(projectId: string, logIds: string[]): Promise<RawLog[]> {
    if (!logIds || logIds.length === 0) return [];

    const { data, error } = await this.supabase.rpc('get_raw_logs_by_ids', {
      p_project_id: projectId,
      p_ids: logIds,
    });

    if (error) {
      throw new Error(`Failed to retrieve raw logs: ${error.message}`);
    }

    return (data || []) as RawLog[];
  }

  async getRecentUnprocessedLogs(
    projectId: string,
    limit: number,
    sessionId?: string
  ): Promise<RawLog[]> {
    if (limit <= 0) return [];

    let query = this.supabase
      .from('raw_logs')
      .select('*')
      .eq('project_id', projectId)
      .eq('is_processed', false);

    if (sessionId) {
      query = query.eq('session_id', sessionId);
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(`Failed to fetch recent unprocessed logs: ${error.message}`);
    }

    return ((data || []) as RawLog[]).reverse();
  }

  async countUnprocessed(projectId: string, sessionId?: string): Promise<number> {
    let query = this.supabase
      .from('raw_logs')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('is_processed', false);

    if (sessionId) {
      query = query.eq('session_id', sessionId);
    }

    const { count, error } = await query;

    if (error) {
      throw new Error(`Failed to count unprocessed logs: ${error.message}`);
    }

    return count || 0;
  }

  async claimUnprocessedLogs(params: ClaimBatchParams): Promise<RawLog[]> {
    const { projectId, sessionId, limit, leaseSeconds = 300, lockToken } = params;

    const { data, error } = await this.supabase.rpc('claim_unprocessed_logs', {
      p_project_id: projectId,
      p_session_id: sessionId || null,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
      p_lock_token: lockToken,
    });

    if (error) {
      throw new Error(`Failed to claim unprocessed logs (RPC): ${error.message}`);
    }

    return (data || []) as RawLog[];
  }

  async releaseClaimedLogs(
    projectId: string,
    rawLogIds: string[],
    lockToken?: string
  ): Promise<void> {
    if (!rawLogIds || rawLogIds.length === 0) return;

    let query = this.supabase
      .from('raw_logs')
      .update({ locked_until: null, lock_token: null })
      .eq('project_id', projectId)
      .in('id', rawLogIds)
      .eq('is_processed', false);

    if (lockToken) {
      query = query.eq('lock_token', lockToken);
    }

    await query;
  }

  async commitConsolidatedMemory(params: CommitMemoryParams): Promise<MemoryVector> {
    const tokenCount = params.tokenCount || Math.ceil(params.summary.length / 4);

    const { data, error } = await this.supabase.rpc('commit_consolidated_memory', {
      p_project_id: params.projectId,
      p_session_id: params.sessionId,
      p_summary: params.summary,
      p_key_entities: params.keyEntities,
      p_raw_log_ids: params.rawLogIds,
      p_embedding: params.embedding,
      p_token_count: tokenCount,
      p_metadata: params.metadata || {},
      p_embedding_model: params.embeddingModel || 'text-embedding-3-small',
      p_batch_hash: params.batchHash || null,
      p_lock_token: params.lockToken || null,
    });

    if (error || !data) {
      throw new Error(
        `Atomic commit_consolidated_memory RPC failed: ${error?.message || 'Empty result'}`
      );
    }

    return data as MemoryVector;
  }

  async searchSimilarVectors(params: SearchMemoryParams): Promise<VectorSearchResult[]> {
    const {
      projectId,
      queryEmbedding,
      queryText,
      sessionId,
      matchThreshold = 0.3,
      matchCount = 5,
    } = params;

    if (queryEmbedding && queryEmbedding.length > 0) {
      const { data, error } = await this.supabase.rpc('match_memory_vectors', {
        p_project_id: projectId,
        query_embedding: queryEmbedding,
        match_threshold: matchThreshold,
        match_count: matchCount,
        filter_session_id: sessionId || null,
      });

      if (error) {
        throw new Error(`Semantic search RPC failed: ${error.message}`);
      }

      return (data || []) as VectorSearchResult[];
    }

    // Basic Mode lexical fallback in Supabase
    if (queryText) {
      let query = this.supabase
        .from('raw_logs')
        .select('*')
        .eq('project_id', projectId)
        .ilike('content', `%${queryText}%`)
        .order('created_at', { ascending: false })
        .limit(matchCount);

      if (sessionId) {
        query = query.eq('session_id', sessionId);
      }

      const { data, error } = await query;
      if (error) {
        throw new Error(`Lexical search failed: ${error.message}`);
      }

      return ((data || []) as RawLog[]).map((log) => ({
        id: log.id,
        project_id: log.project_id,
        session_id: log.session_id,
        summary: `[${log.role}] ${log.content}`,
        key_entities: [],
        raw_log_ids: [log.id],
        metadata: (log.metadata || {}) as Record<string, unknown>,
        similarity: 1.0,
        created_at: log.created_at,
      }));
    }

    return [];
  }
}
