import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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

interface LocalDatabaseSchema {
  version: number;
  project_states: Record<string, ProjectState>;
  raw_logs: RawLog[];
  memory_vectors: MemoryVector[];
}

/**
 * LocalStorageAdapter (v1.2.1):
 * - Cross-process exclusive file locking (wx lockfile with stale-lock recovery)
 * - Strict schema validation on read (never silently wipes invalid structures)
 * - Full-batch lock_token ownership verification (rejects partial ownership)
 * - Atomic write-then-rename durability
 */
export class LocalStorageAdapter implements IMemoryStorageAdapter {
  public readonly providerName = 'local' as const;
  private filePath: string;
  private lockPath: string;

  constructor(customFilePath?: string) {
    this.filePath = path.resolve(
      customFilePath || process.env.LOCAL_STORAGE_PATH || './data/easybrain.memory.json'
    );
    this.lockPath = `${this.filePath}.lock`;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Acquires an exclusive inter-process lock around the entire read -> modify -> write cycle.
   */
  private async withFileLock<T>(fn: () => T | Promise<T>): Promise<T> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const maxWaitMs = 5000;
    const staleLockMs = 15000;
    const start = Date.now();
    let fd: number | null = null;

    while (fd === null) {
      try {
        fd = fs.openSync(this.lockPath, 'wx');
        fs.writeFileSync(fd, `${process.pid}:${Date.now()}`, 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') {
          throw err;
        }
        // Check for stale lock from crashed process
        try {
          const stat = fs.statSync(this.lockPath);
          if (Date.now() - stat.mtimeMs > staleLockMs) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          // Lock was released by another process
          continue;
        }

        if (Date.now() - start > maxWaitMs) {
          throw new Error(
            `Timed out waiting for exclusive local storage lock at ${this.lockPath}`
          );
        }
        await this.sleep(15 + Math.floor(Math.random() * 20));
      }
    }

    try {
      return await fn();
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        // Ignore
      }
    }
  }

  private readDb(): LocalDatabaseSchema {
    if (!fs.existsSync(this.filePath)) {
      return {
        version: 2,
        project_states: {},
        raw_logs: [],
        memory_vectors: [],
      };
    }

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Corrupted local EasyBrain database at ${this.filePath}. Preserving original file without overwriting: ${(err as Error).message}`
      );
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `Invalid local EasyBrain database structure at ${this.filePath}: root must be an object. Preserving original file.`
      );
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.raw_logs !== undefined && !Array.isArray(obj.raw_logs)) {
      throw new Error(
        `Invalid local EasyBrain database structure at ${this.filePath}: "raw_logs" must be an array. Preserving original file.`
      );
    }
    if (obj.memory_vectors !== undefined && !Array.isArray(obj.memory_vectors)) {
      throw new Error(
        `Invalid local EasyBrain database structure at ${this.filePath}: "memory_vectors" must be an array. Preserving original file.`
      );
    }
    if (
      obj.project_states !== undefined &&
      (typeof obj.project_states !== 'object' ||
        obj.project_states === null ||
        Array.isArray(obj.project_states))
    ) {
      throw new Error(
        `Invalid local EasyBrain database structure at ${this.filePath}: "project_states" must be an object. Preserving original file.`
      );
    }

    return {
      version: typeof obj.version === 'number' ? obj.version : 2,
      project_states: (obj.project_states as Record<string, ProjectState>) || {},
      raw_logs: (obj.raw_logs as RawLog[]) || [],
      memory_vectors: (obj.memory_vectors as MemoryVector[]) || [],
    };
  }

  private writeDb(db: LocalDatabaseSchema): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tempPath, this.filePath);
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) {
      return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private lexicalScore(queryText: string, targetText: string): number {
    const tokens = queryText
      .toLowerCase()
      .split(/[^a-z0-9\u00C0-\u024F]+/)
      .filter((t) => t.length >= 2);
    if (tokens.length === 0) return 0;
    const lowerTarget = targetText.toLowerCase();
    let hits = 0;
    for (const token of tokens) {
      if (lowerTarget.includes(token)) {
        hits += 1;
      }
    }
    return hits / tokens.length;
  }

  async getProjectState(projectId: string): Promise<ProjectState | null> {
    const db = this.readDb();
    const state = db.project_states[projectId];
    return state ? { ...state } : null;
  }

  async upsertProjectState(
    projectId: string,
    update: ProjectStateUpdate
  ): Promise<ProjectState> {
    return this.withFileLock(() => {
      const db = this.readDb();
      const existing = db.project_states[projectId];

      const nextState: ProjectState = {
        projectId,
        objective: update.objective ?? existing?.objective ?? '',
        stack: update.stack ?? existing?.stack ?? [],
        architecture: update.architecture ?? existing?.architecture ?? '',
        currentTask: update.currentTask ?? existing?.currentTask ?? '',
        completed: update.completed ?? existing?.completed ?? [],
        nextSteps: update.nextSteps ?? existing?.nextSteps ?? [],
        activeBlockers: update.activeBlockers ?? existing?.activeBlockers ?? [],
        importantDecisions:
          update.importantDecisions ?? existing?.importantDecisions ?? [],
        relevantFiles: update.relevantFiles ?? existing?.relevantFiles ?? [],
        sourceLogIds: update.sourceLogIds ?? existing?.sourceLogIds ?? [],
        version: existing ? existing.version + 1 : 1,
        updatedAt: new Date().toISOString(),
      };

      db.project_states[projectId] = nextState;
      this.writeDb(db);
      return { ...nextState };
    });
  }

  async insertRawLog(
    projectId: string,
    sessionId: string,
    role: MessageRole,
    content: string,
    metadata: Record<string, unknown>,
    tokenCount: number
  ): Promise<RawLog> {
    return this.withFileLock(() => {
      const db = this.readDb();
      const newLog: RawLog = {
        id: crypto.randomUUID(),
        project_id: projectId,
        session_id: sessionId,
        role,
        content,
        metadata: metadata || {},
        token_count: tokenCount,
        is_processed: false,
        locked_until: null,
        lock_token: null,
        processed_at: null,
        created_at: new Date().toISOString(),
      };

      db.raw_logs.push(newLog);
      this.writeDb(db);
      return { ...newLog };
    });
  }

  async getRawLogsByIds(projectId: string, logIds: string[]): Promise<RawLog[]> {
    if (!logIds || logIds.length === 0) return [];
    const db = this.readDb();
    const idSet = new Set(logIds);
    return db.raw_logs
      .filter((log) => log.project_id === projectId && idSet.has(log.id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((l) => ({ ...l }));
  }

  async getRecentUnprocessedLogs(
    projectId: string,
    limit: number,
    sessionId?: string
  ): Promise<RawLog[]> {
    if (limit <= 0) return [];
    const db = this.readDb();
    const filtered = db.raw_logs
      .filter(
        (log) =>
          log.project_id === projectId &&
          !log.is_processed &&
          (!sessionId || log.session_id === sessionId)
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return filtered.slice(-limit).map((l) => ({ ...l }));
  }

  async countUnprocessed(projectId: string, sessionId?: string): Promise<number> {
    const db = this.readDb();
    return db.raw_logs.filter(
      (log) =>
        log.project_id === projectId &&
        !log.is_processed &&
        (!sessionId || log.session_id === sessionId)
    ).length;
  }

  async claimUnprocessedLogs(params: ClaimBatchParams): Promise<RawLog[]> {
    return this.withFileLock(() => {
      const { projectId, sessionId, limit, leaseSeconds = 300, lockToken } = params;
      const db = this.readDb();
      const now = Date.now();
      const lockUntilIso = new Date(now + leaseSeconds * 1000).toISOString();

      const eligible = db.raw_logs
        .filter((log) => {
          if (log.project_id !== projectId || log.is_processed) return false;
          if (sessionId && log.session_id !== sessionId) return false;
          if (!log.locked_until) return true;
          return new Date(log.locked_until).getTime() < now;
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, limit);

      if (eligible.length === 0) {
        return [];
      }

      for (const log of eligible) {
        log.locked_until = lockUntilIso;
        log.lock_token = lockToken;
      }

      this.writeDb(db);
      return eligible.map((l) => ({ ...l }));
    });
  }

  async releaseClaimedLogs(
    projectId: string,
    rawLogIds: string[],
    lockToken?: string
  ): Promise<void> {
    if (!rawLogIds || rawLogIds.length === 0) return;
    return this.withFileLock(() => {
      const db = this.readDb();
      const idSet = new Set(rawLogIds);
      let modified = false;

      for (const log of db.raw_logs) {
        if (log.project_id === projectId && idSet.has(log.id) && !log.is_processed) {
          if (!lockToken || log.lock_token === lockToken) {
            log.locked_until = null;
            log.lock_token = null;
            modified = true;
          }
        }
      }

      if (modified) {
        this.writeDb(db);
      }
    });
  }

  async commitConsolidatedMemory(params: CommitMemoryParams): Promise<MemoryVector> {
    return this.withFileLock(() => {
      const db = this.readDb();
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const uniqueIds = Array.from(new Set(params.rawLogIds));
      const idSet = new Set(uniqueIds);

      if (uniqueIds.length === 0) {
        throw new Error('Cannot commit consolidated memory with empty rawLogIds.');
      }

      // Enforce FULL-BATCH lockToken ownership (rejects partial ownership or missing IDs)
      if (params.lockToken) {
        const ownedLogs = db.raw_logs.filter(
          (log) =>
            log.project_id === params.projectId &&
            idSet.has(log.id) &&
            !log.is_processed &&
            log.lock_token === params.lockToken &&
            (!log.locked_until || new Date(log.locked_until).getTime() >= now)
        );
        if (ownedLogs.length !== uniqueIds.length) {
          throw new Error(
            `Lock ownership validation failed: worker owns ${ownedLogs.length} of ${uniqueIds.length} requested logs.`
          );
        }
      }

      if (params.batchHash) {
        const existing = db.memory_vectors.find(
          (m) => m.project_id === params.projectId && m.batch_hash === params.batchHash
        );
        if (existing) {
          for (const log of db.raw_logs) {
            if (log.project_id === params.projectId && idSet.has(log.id)) {
              log.is_processed = true;
              log.processed_at = nowIso;
              log.locked_until = null;
            }
          }
          this.writeDb(db);
          return { ...existing };
        }
      }

      const memoryVector: MemoryVector = {
        id: crypto.randomUUID(),
        project_id: params.projectId,
        session_id: params.sessionId,
        summary: params.summary,
        key_entities: params.keyEntities,
        raw_log_ids: uniqueIds,
        embedding: params.embedding,
        embedding_model: params.embeddingModel || 'text-embedding-3-small',
        batch_hash: params.batchHash,
        token_count: params.tokenCount || Math.ceil(params.summary.length / 4),
        metadata: params.metadata || {},
        created_at: nowIso,
      };

      db.memory_vectors.push(memoryVector);

      for (const log of db.raw_logs) {
        if (log.project_id === params.projectId && idSet.has(log.id)) {
          log.is_processed = true;
          log.processed_at = nowIso;
          log.locked_until = null;
        }
      }

      this.writeDb(db);
      return { ...memoryVector };
    });
  }

  async searchSimilarVectors(params: SearchMemoryParams): Promise<VectorSearchResult[]> {
    const {
      projectId,
      queryEmbedding,
      queryText,
      sessionId,
      matchThreshold = 0.25,
      matchCount = 5,
    } = params;
    const db = this.readDb();

    const candidates = db.memory_vectors.filter(
      (mv) =>
        mv.project_id === projectId &&
        (!sessionId || mv.session_id === sessionId)
    );

    const scored: VectorSearchResult[] = [];

    if (queryEmbedding && queryEmbedding.length > 0 && candidates.length > 0) {
      for (const mv of candidates) {
        const similarity = this.cosineSimilarity(queryEmbedding, mv.embedding);
        if (similarity >= matchThreshold) {
          scored.push({
            id: mv.id,
            project_id: mv.project_id,
            session_id: mv.session_id,
            summary: mv.summary,
            key_entities: mv.key_entities,
            raw_log_ids: mv.raw_log_ids,
            metadata: (mv.metadata || {}) as Record<string, unknown>,
            similarity,
            created_at: mv.created_at,
          });
        }
      }
    } else if (queryText) {
      for (const mv of candidates) {
        const score = this.lexicalScore(
          queryText,
          `${mv.summary} ${mv.key_entities.join(' ')}`
        );
        if (score > 0) {
          scored.push({
            id: mv.id,
            project_id: mv.project_id,
            session_id: mv.session_id,
            summary: mv.summary,
            key_entities: mv.key_entities,
            raw_log_ids: mv.raw_log_ids,
            metadata: (mv.metadata || {}) as Record<string, unknown>,
            similarity: score,
            created_at: mv.created_at,
          });
        }
      }

      if (scored.length === 0) {
        const projectLogs = db.raw_logs.filter(
          (l) =>
            l.project_id === projectId &&
            (!sessionId || l.session_id === sessionId)
        );
        for (const log of projectLogs) {
          const score = this.lexicalScore(queryText, log.content);
          if (score > 0) {
            scored.push({
              id: log.id,
              project_id: log.project_id,
              session_id: log.session_id,
              summary: `[${log.role}] ${log.content}`,
              key_entities: [],
              raw_log_ids: [log.id],
              metadata: (log.metadata || {}) as Record<string, unknown>,
              similarity: score,
              created_at: log.created_at,
            });
          }
        }
      }
    }

    return scored
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, matchCount);
  }
}
