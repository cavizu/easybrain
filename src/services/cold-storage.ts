import { IMemoryStorageAdapter, MessageRole, RawLog } from '../types/index.js';

export class ColdStorageService {
  constructor(private storage: IMemoryStorageAdapter) {}

  public estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async ingestMessage(
    projectId: string,
    sessionId: string,
    role: MessageRole,
    content: string,
    metadata: Record<string, unknown> = {}
  ): Promise<RawLog> {
    if (!projectId || !sessionId || !role || content === undefined) {
      throw new Error('ingestMessage requires projectId, sessionId, role, and content.');
    }
    const tokenCount = this.estimateTokens(content);
    return this.storage.insertRawLog(
      projectId,
      sessionId,
      role,
      content,
      metadata,
      tokenCount
    );
  }

  async getRawLogsByIds(projectId: string, logIds: string[]): Promise<RawLog[]> {
    return this.storage.getRawLogsByIds(projectId, logIds);
  }

  async getRecentUnprocessedLogs(
    projectId: string,
    limit = 6,
    sessionId?: string
  ): Promise<RawLog[]> {
    return this.storage.getRecentUnprocessedLogs(projectId, limit, sessionId);
  }

  async countUnprocessed(projectId: string, sessionId?: string): Promise<number> {
    return this.storage.countUnprocessed(projectId, sessionId);
  }
}
