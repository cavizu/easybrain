# 🏛️ EasyBrain v1.2 Architecture

EasyBrain separates memory into **4 layers** strictly isolated by `projectId`:
1. **Project State Snapshot (`project_states`)**: Compact live state (`objective`, `stack`, `currentTask`, `importantDecisions`, `nextSteps`, `relevantFiles`) loaded at session start via `bootstrap`.
2. **Cold Storage (`raw_logs`)**: Append-only verbatim logs with `project_id`, `session_id`, and persistent lease locking (`locked_until`, `lock_token`).
3. **Librarian Worker (Optional Enriched Mode)**: Claims pending logs with a unique `lockToken`, summarizes batches within a token budget, generates vector embeddings, and commits atomically validating `lockToken` ownership.
4. **Hybrid Retrieval (`ContextRetriever`)**: Combines semantic vector search (Enriched Mode) or lexical keyword search (Basic Mode) with recent unconsolidated turns.
