-- ==============================================================================
-- EASYBRAIN v1.2: SUPABASE / POSTGRESQL SCHEMA (PER-PROJECT ISOLATION)
-- Compatible with Supabase & PostgreSQL 15+ (pgvector)
-- ==============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------------------------
-- 1. PROJECT STATE SNAPSHOTS: public.project_states
-- Stores compact structured state per project for instant session bootstrap.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.project_states (
    project_id TEXT PRIMARY KEY,
    objective TEXT DEFAULT '',
    stack JSONB DEFAULT '[]'::jsonb,
    architecture TEXT DEFAULT '',
    current_task TEXT DEFAULT '',
    completed JSONB DEFAULT '[]'::jsonb,
    next_steps JSONB DEFAULT '[]'::jsonb,
    active_blockers JSONB DEFAULT '[]'::jsonb,
    important_decisions JSONB DEFAULT '[]'::jsonb,
    relevant_files JSONB DEFAULT '[]'::jsonb,
    source_log_ids UUID[] DEFAULT ARRAY[]::UUID[],
    version INTEGER DEFAULT 1 NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT clock_timestamp() NOT NULL
);

-- ------------------------------------------------------------------------------
-- 2. COLD STORAGE: public.raw_logs
-- Append-only verbatim logs strictly isolated by project_id.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.raw_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL DEFAULT 'default',
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool', 'agent')),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    token_count INTEGER DEFAULT 0,
    is_processed BOOLEAN DEFAULT FALSE,
    locked_until TIMESTAMPTZ NULL,
    lock_token UUID NULL,
    processed_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE public.raw_logs ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE public.raw_logs ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ NULL;
ALTER TABLE public.raw_logs ADD COLUMN IF NOT EXISTS lock_token UUID NULL;

CREATE INDEX IF NOT EXISTS idx_raw_logs_project_pending
ON public.raw_logs (project_id, session_id, created_at ASC)
WHERE is_processed = FALSE;

CREATE INDEX IF NOT EXISTS idx_raw_logs_project_created
ON public.raw_logs (project_id, created_at DESC);

-- ------------------------------------------------------------------------------
-- 3. HOT STORAGE: public.memory_vectors
-- Distilled episodic summaries and vector embeddings strictly isolated by project_id.
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.memory_vectors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id TEXT NOT NULL DEFAULT 'default',
    session_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_entities JSONB DEFAULT '[]'::jsonb,
    raw_log_ids UUID[] DEFAULT ARRAY[]::UUID[],
    embedding vector(1536),
    embedding_model TEXT DEFAULT 'text-embedding-3-small',
    batch_hash TEXT UNIQUE NULL,
    token_count INTEGER DEFAULT 0,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT clock_timestamp() NOT NULL
);

ALTER TABLE public.memory_vectors ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE public.memory_vectors ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'text-embedding-3-small';
ALTER TABLE public.memory_vectors ADD COLUMN IF NOT EXISTS batch_hash TEXT UNIQUE NULL;

CREATE INDEX IF NOT EXISTS idx_memory_vectors_project_created
ON public.memory_vectors (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_embedding_hnsw
ON public.memory_vectors
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- ------------------------------------------------------------------------------
-- SECURITY: Enable Row Level Security (blocks accidental anon public access)
-- ------------------------------------------------------------------------------
ALTER TABLE public.project_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raw_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_vectors ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- RPC 1: claim_unprocessed_logs (Project-scoped + Persistent Lease Lock)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_unprocessed_logs(TEXT, INT);
DROP FUNCTION IF EXISTS public.claim_unprocessed_logs(TEXT, INT, INT, UUID);
DROP FUNCTION IF EXISTS public.claim_unprocessed_logs(TEXT, TEXT, INT, INT, UUID);

CREATE OR REPLACE FUNCTION public.claim_unprocessed_logs(
    p_project_id TEXT,
    p_session_id TEXT DEFAULT NULL,
    p_limit INT DEFAULT 50,
    p_lease_seconds INT DEFAULT 300,
    p_lock_token UUID DEFAULT gen_random_uuid()
)
RETURNS TABLE (
    id UUID,
    project_id TEXT,
    session_id TEXT,
    role TEXT,
    content TEXT,
    metadata JSONB,
    token_count INT,
    is_processed BOOLEAN,
    locked_until TIMESTAMPTZ,
    lock_token UUID,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH claimed AS (
        SELECT rl.id
        FROM public.raw_logs rl
        WHERE rl.project_id = p_project_id
          AND (p_session_id IS NULL OR rl.session_id = p_session_id)
          AND rl.is_processed = FALSE
          AND (rl.locked_until IS NULL OR rl.locked_until < clock_timestamp())
        ORDER BY rl.created_at ASC
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.raw_logs target
    SET
        locked_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
        lock_token = p_lock_token
    FROM claimed
    WHERE target.id = claimed.id
    RETURNING
        target.id,
        target.project_id,
        target.session_id,
        target.role,
        target.content,
        target.metadata,
        target.token_count,
        target.is_processed,
        target.locked_until,
        target.lock_token,
        target.processed_at,
        target.created_at;
END;
$$;

-- ------------------------------------------------------------------------------
-- RPC 2: commit_consolidated_memory (Atomic + Strict lock_token Ownership Check)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.commit_consolidated_memory(TEXT, TEXT, JSONB, UUID[], vector, INT, JSONB, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.commit_consolidated_memory(TEXT, TEXT, TEXT, JSONB, UUID[], vector, INT, JSONB, TEXT, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.commit_consolidated_memory(
    p_project_id TEXT,
    p_session_id TEXT,
    p_summary TEXT,
    p_key_entities JSONB,
    p_raw_log_ids UUID[],
    p_embedding vector(1536),
    p_token_count INT,
    p_metadata JSONB DEFAULT '{}'::jsonb,
    p_embedding_model TEXT DEFAULT 'text-embedding-3-small',
    p_batch_hash TEXT DEFAULT NULL,
    p_lock_token UUID DEFAULT NULL
)
RETURNS public.memory_vectors
LANGUAGE plpgsql
AS $$
DECLARE
    v_memory public.memory_vectors;
    v_expected_count INT;
    v_updated_count INT;
BEGIN
    SELECT COUNT(DISTINCT x) INTO v_expected_count FROM unnest(p_raw_log_ids) AS x;

    IF v_expected_count = 0 THEN
        RAISE EXCEPTION 'Cannot commit empty raw_log_ids batch';
    END IF;

    -- Verify FULL-BATCH lock ownership if lock_token was provided
    IF p_lock_token IS NOT NULL THEN
        UPDATE public.raw_logs
        SET
            is_processed = TRUE,
            processed_at = clock_timestamp(),
            locked_until = NULL
        WHERE id = ANY(p_raw_log_ids)
          AND project_id = p_project_id
          AND is_processed = FALSE
          AND lock_token = p_lock_token
          AND (locked_until IS NULL OR locked_until >= clock_timestamp());

        GET DIAGNOSTICS v_updated_count = ROW_COUNT;

        IF v_updated_count <> v_expected_count THEN
            RAISE EXCEPTION 'Lock ownership validation failed: updated % of % requested logs', v_updated_count, v_expected_count;
        END IF;
    ELSE
        UPDATE public.raw_logs
        SET
            is_processed = TRUE,
            processed_at = clock_timestamp(),
            locked_until = NULL
        WHERE id = ANY(p_raw_log_ids)
          AND project_id = p_project_id;
    END IF;

    INSERT INTO public.memory_vectors (
        project_id,
        session_id,
        summary,
        key_entities,
        raw_log_ids,
        embedding,
        token_count,
        metadata,
        embedding_model,
        batch_hash
    )
    VALUES (
        p_project_id,
        p_session_id,
        p_summary,
        p_key_entities,
        p_raw_log_ids,
        p_embedding,
        p_token_count,
        p_metadata,
        p_embedding_model,
        p_batch_hash
    )
    ON CONFLICT (batch_hash) DO UPDATE
    SET summary = EXCLUDED.summary
    RETURNING * INTO v_memory;

    RETURN v_memory;
END;
$$;

-- ------------------------------------------------------------------------------
-- RPC 3: match_memory_vectors (Strictly Project-scoped Semantic Search)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.match_memory_vectors(vector, FLOAT, INT, TEXT);
DROP FUNCTION IF EXISTS public.match_memory_vectors(TEXT, vector, FLOAT, INT, TEXT);

CREATE OR REPLACE FUNCTION public.match_memory_vectors(
    p_project_id TEXT,
    query_embedding vector(1536),
    match_threshold FLOAT DEFAULT 0.3,
    match_count INT DEFAULT 5,
    filter_session_id TEXT DEFAULT NULL
)
RETURNS TABLE (
    id UUID,
    project_id TEXT,
    session_id TEXT,
    summary TEXT,
    key_entities JSONB,
    raw_log_ids UUID[],
    metadata JSONB,
    similarity FLOAT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        mv.id,
        mv.project_id,
        mv.session_id,
        mv.summary,
        mv.key_entities,
        mv.raw_log_ids,
        mv.metadata,
        (1 - (mv.embedding <=> query_embedding))::FLOAT AS similarity,
        mv.created_at
    FROM public.memory_vectors mv
    WHERE mv.project_id = p_project_id
      AND (filter_session_id IS NULL OR mv.session_id = filter_session_id)
      AND (1 - (mv.embedding <=> query_embedding)) >= match_threshold
    ORDER BY mv.embedding <=> query_embedding ASC
    LIMIT match_count;
END;
$$;

-- ------------------------------------------------------------------------------
-- RPC 4: get_raw_logs_by_ids (Strictly Project-scoped Decompression)
-- ------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_raw_logs_by_ids(UUID[]);
DROP FUNCTION IF EXISTS public.get_raw_logs_by_ids(TEXT, UUID[]);

CREATE OR REPLACE FUNCTION public.get_raw_logs_by_ids(
    p_project_id TEXT,
    p_ids UUID[]
)
RETURNS TABLE (
    id UUID,
    project_id TEXT,
    session_id TEXT,
    role TEXT,
    content TEXT,
    metadata JSONB,
    token_count INT,
    is_processed BOOLEAN,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        rl.id,
        rl.project_id,
        rl.session_id,
        rl.role,
        rl.content,
        rl.metadata,
        rl.token_count,
        rl.is_processed,
        rl.processed_at,
        rl.created_at
    FROM public.raw_logs rl
    WHERE rl.project_id = p_project_id
      AND rl.id = ANY(p_ids)
    ORDER BY rl.created_at ASC;
END;
$$;
