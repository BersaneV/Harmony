-- Durable, fenced processing of immutable originals. Objects are private S3 keys.
CREATE TABLE media_jobs (
 upload_id uuid PRIMARY KEY REFERENCES uploads(id),
 pipeline_version integer NOT NULL DEFAULT 1 CHECK(pipeline_version=1),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','unsupported','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 attempt_id uuid,
 lease_until timestamptz,
 available_at timestamptz NOT NULL DEFAULT now(),
 metadata jsonb,
 error_code text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_jobs_pending ON media_jobs(available_at,upload_id) WHERE status IN ('queued','processing');
CREATE TABLE media_attempts (
 id uuid PRIMARY KEY,
 upload_id uuid NOT NULL REFERENCES media_jobs(upload_id),
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes>=0),
 state text NOT NULL CHECK(state IN ('active','published','garbage')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE media_derivatives (
 attempt_id uuid NOT NULL REFERENCES media_attempts(id),
 kind text NOT NULL CHECK(kind IN ('thumbnail','faststart')),
 object_key text UNIQUE NOT NULL,
 content_type text NOT NULL,
 size bigint NOT NULL DEFAULT 0 CHECK(size>=0),
 width integer,
 height integer,
 ready boolean NOT NULL DEFAULT false,
 PRIMARY KEY(attempt_id,kind)
);
-- Include uncollected garbage/reservations: a failed PUT must not escape the quota.
CREATE FUNCTION harmony_storage_used() RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (SELECT COALESCE(sum(size),0)::bigint FROM uploads WHERE status='ready' OR (status='pending' AND expires_at>now()))
      + (SELECT COALESCE(sum(reserved_bytes),0)::bigint FROM media_attempts)
      + (SELECT COALESCE(sum(d.size),0)::bigint FROM media_derivatives d JOIN media_attempts a ON a.id=d.attempt_id WHERE a.state='published');
$$;
INSERT INTO media_jobs(upload_id,status) SELECT id,CASE WHEN content_type LIKE 'image/%' OR content_type LIKE 'video/%' OR content_type LIKE 'audio/%' THEN 'queued' ELSE 'unsupported' END FROM uploads WHERE status='ready';
