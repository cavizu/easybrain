import {
  IMemoryStorageAdapter,
  MemoryVector,
  VectorSearchResult,
  CommitMemoryParams,
  SearchMemoryParams,
} from '../types/index.js';

export class HotStorageService {
  constructor(private storage: IMemoryStorageAdapter) {}

  async commitConsolidatedMemory(params: CommitMemoryParams): Promise<MemoryVector> {
    return this.storage.commitConsolidatedMemory(params);
  }

  async searchSimilar(params: SearchMemoryParams): Promise<VectorSearchResult[]> {
    return this.storage.searchSimilarVectors(params);
  }
}
