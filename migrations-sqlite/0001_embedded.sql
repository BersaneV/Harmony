CREATE TABLE users (
 id BLOB PRIMARY KEY NOT NULL, username text UNIQUE NOT NULL, display_name text NOT NULL,
 password_hash text NOT NULL, is_admin boolean NOT NULL DEFAULT false,
 disabled boolean NOT NULL DEFAULT false, auth_version bigint NOT NULL DEFAULT 1,
 preferences TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE sessions (
 id BLOB PRIMARY KEY NOT NULL, user_id BLOB NOT NULL REFERENCES users(id),
 version bigint NOT NULL DEFAULT 1, refresh_hash text UNIQUE NOT NULL,
 expires_at TEXT NOT NULL, revoked_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE used_refresh_tokens (hash text PRIMARY KEY NOT NULL, session_id BLOB NOT NULL REFERENCES sessions(id), expires_at TEXT NOT NULL);
CREATE TABLE password_resets (hash text PRIMARY KEY NOT NULL, user_id BLOB NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE guilds (id BLOB PRIMARY KEY NOT NULL, name text NOT NULL, owner_id BLOB NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE guild_members (guild_id BLOB NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, user_id BLOB NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN('owner','admin','member')), PRIMARY KEY(guild_id,user_id));
CREATE TABLE channels (id BLOB PRIMARY KEY NOT NULL, guild_id BLOB REFERENCES guilds(id) ON DELETE CASCADE, name text NOT NULL, kind text NOT NULL CHECK(kind IN('text','voice','dm','group')), last_seq bigint NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), CHECK((guild_id IS NOT NULL AND kind IN('text','voice')) OR (guild_id IS NULL AND kind IN('dm','group'))));
CREATE INDEX channels_guild ON channels(guild_id);
CREATE TABLE channel_members (channel_id BLOB NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id BLOB NOT NULL REFERENCES users(id), PRIMARY KEY(channel_id,user_id));
CREATE TABLE friends (id BLOB PRIMARY KEY NOT NULL, requester_id BLOB NOT NULL REFERENCES users(id), addressee_id BLOB NOT NULL REFERENCES users(id), status text NOT NULL CHECK(status IN('pending','accepted')), created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), CHECK(requester_id<>addressee_id));
CREATE UNIQUE INDEX friends_pair ON friends(min(requester_id,addressee_id),max(requester_id,addressee_id));
CREATE TABLE invites (hash text PRIMARY KEY NOT NULL, guild_id BLOB REFERENCES guilds(id) ON DELETE CASCADE, created_by BLOB NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 100), uses integer NOT NULL DEFAULT 0);
CREATE TABLE messages (id BLOB PRIMARY KEY NOT NULL, channel_id BLOB NOT NULL REFERENCES channels(id) ON DELETE CASCADE, author_id BLOB NOT NULL REFERENCES users(id), client_nonce BLOB NOT NULL, content text NOT NULL, seq bigint NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), edited_at TEXT, deleted boolean NOT NULL DEFAULT false, request_hash text NOT NULL, UNIQUE(channel_id,seq), UNIQUE(channel_id,author_id,client_nonce));

CREATE TABLE reactions (message_id BLOB NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id BLOB NOT NULL REFERENCES users(id), emoji text NOT NULL, PRIMARY KEY(message_id,user_id,emoji));
CREATE TABLE channel_reads (channel_id BLOB NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id BLOB NOT NULL REFERENCES users(id), seq bigint NOT NULL, PRIMARY KEY(channel_id,user_id));
CREATE TABLE uploads (id BLOB PRIMARY KEY NOT NULL, channel_id BLOB NOT NULL REFERENCES channels(id), user_id BLOB NOT NULL REFERENCES users(id), object_key text UNIQUE NOT NULL, name text NOT NULL, size bigint NOT NULL, content_type text NOT NULL, status text NOT NULL CHECK(status IN('pending','ready','rejected')), message_id BLOB REFERENCES messages(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX uploads_owner ON uploads(user_id,status);
CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id BLOB NOT NULL REFERENCES channels(id), event TEXT NOT NULL, delivered_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX outbox_pending ON outbox(id) WHERE delivered_at IS NULL;
CREATE TABLE audit (id BLOB PRIMARY KEY NOT NULL, actor_id BLOB REFERENCES users(id), action text NOT NULL, target_id BLOB, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE media_members (channel_id BLOB NOT NULL REFERENCES channels(id), user_id BLOB NOT NULL REFERENCES users(id), session_id BLOB NOT NULL REFERENCES sessions(id), identity text NOT NULL, issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), PRIMARY KEY(channel_id,session_id));
CREATE TABLE media_bans (channel_id BLOB NOT NULL REFERENCES channels(id), user_id BLOB NOT NULL REFERENCES users(id), until_at TEXT NOT NULL, PRIMARY KEY(channel_id,user_id));
CREATE VIEW public_users AS SELECT id,username,display_name,is_admin,disabled,preferences,created_at FROM users;
ALTER TABLE messages ADD COLUMN change_seq bigint NOT NULL DEFAULT 0;
CREATE INDEX messages_changes ON messages(channel_id,change_seq);
CREATE TABLE media_mutes (channel_id BLOB NOT NULL REFERENCES channels(id), user_id BLOB NOT NULL REFERENCES users(id), PRIMARY KEY(channel_id,user_id));
ALTER TABLE uploads ADD COLUMN temporary_cleaned boolean NOT NULL DEFAULT false;
CREATE TABLE guild_roles (
 id BLOB PRIMARY KEY NOT NULL,
 guild_id BLOB NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 permissions bigint NOT NULL CHECK(permissions BETWEEN 0 AND 63),
 UNIQUE(id,guild_id), UNIQUE(guild_id,name)
);
CREATE TABLE guild_member_roles (
 guild_id BLOB NOT NULL,
 user_id BLOB NOT NULL,
 role_id BLOB NOT NULL,
 PRIMARY KEY(guild_id,user_id,role_id),
 FOREIGN KEY(guild_id,user_id) REFERENCES guild_members(guild_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(role_id,guild_id) REFERENCES guild_roles(id,guild_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX channels_id_guild_unique ON channels(id,guild_id);
CREATE TABLE channel_permissions (
 channel_id BLOB NOT NULL,
 guild_id BLOB NOT NULL,
 role_id BLOB,
 role_key BLOB GENERATED ALWAYS AS (COALESCE(role_id,zeroblob(16))) STORED,
 allow bigint NOT NULL CHECK(allow BETWEEN 0 AND 63),
 deny bigint NOT NULL CHECK(deny BETWEEN 0 AND 63),
 CHECK((allow & deny)=0),
 FOREIGN KEY(channel_id,guild_id) REFERENCES channels(id,guild_id) ON DELETE CASCADE,
 FOREIGN KEY(role_id,guild_id) REFERENCES guild_roles(id,guild_id) ON DELETE CASCADE,
 UNIQUE(channel_id,role_key)
);

-- Durable, fenced processing of immutable originals. Objects are private S3 keys.
CREATE TABLE media_jobs (
 upload_id BLOB PRIMARY KEY NOT NULL REFERENCES uploads(id),
 pipeline_version integer NOT NULL DEFAULT 1 CHECK(pipeline_version=1),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','ready','unsupported','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 attempt_id BLOB,
 lease_until TEXT,
 available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 metadata TEXT,
 error_code text,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX media_jobs_pending ON media_jobs(available_at,upload_id) WHERE status IN ('queued','processing');
CREATE TABLE media_attempts (
 id BLOB PRIMARY KEY NOT NULL,
 upload_id BLOB NOT NULL REFERENCES media_jobs(upload_id),
 reserved_bytes bigint NOT NULL CHECK(reserved_bytes>=0),
 state text NOT NULL CHECK(state IN ('active','published','garbage')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE media_derivatives (
 attempt_id BLOB NOT NULL REFERENCES media_attempts(id),
 kind text NOT NULL CHECK(kind IN ('thumbnail','faststart')),
 object_key text UNIQUE NOT NULL,
 content_type text NOT NULL,
 size bigint NOT NULL DEFAULT 0 CHECK(size>=0),
 width integer,
 height integer,
 ready boolean NOT NULL DEFAULT false,
 PRIMARY KEY(attempt_id,kind)
);

-- SQLite serializes writers through BEGIN IMMEDIATE in every multi-step mutation.
-- This view implements the same permission algebra as the domain and former PG adapter.
CREATE VIEW effective_channel_permissions AS
WITH role_overrides AS (
 SELECT cp.channel_id,mr.user_id,
  (max(cp.allow & 1)|max(cp.allow & 2)|max(cp.allow & 4)|max(cp.allow & 8)|max(cp.allow & 16)|max(cp.allow & 32)) AS allow_mask,
  (max(cp.deny & 1)|max(cp.deny & 2)|max(cp.deny & 4)|max(cp.deny & 8)|max(cp.deny & 16)|max(cp.deny & 32)) AS deny_mask
 FROM channel_permissions cp JOIN guild_member_roles mr ON mr.role_id=cp.role_id AND mr.guild_id=cp.guild_id
 GROUP BY cp.channel_id,mr.user_id
), guild_effective AS (
 SELECT c.id AS channel_id,gm.user_id,gm.role,
  (((63 & ~COALESCE(e.deny,0)) | COALESCE(e.allow,0)) & ~COALESCE(r.deny_mask,0)) | COALESCE(r.allow_mask,0) AS mask
 FROM channels c JOIN guild_members gm ON gm.guild_id=c.guild_id
 LEFT JOIN channel_permissions e ON e.channel_id=c.id AND e.role_id IS NULL
 LEFT JOIN role_overrides r ON r.channel_id=c.id AND r.user_id=gm.user_id
)
SELECT channel_id,user_id,CASE WHEN role IN ('owner','admin') THEN 63 WHEN (mask & 1)=0 THEN 0 ELSE mask & 63 END AS permissions FROM guild_effective
UNION ALL
SELECT c.id,cm.user_id,63 FROM channels c JOIN channel_members cm ON cm.channel_id=c.id WHERE c.guild_id IS NULL;
CREATE VIEW harmony_storage_usage AS
SELECT (SELECT COALESCE(sum(size),0) FROM uploads WHERE status='ready' OR (status='pending' AND julianday(expires_at)>julianday('now')))
 +(SELECT COALESCE(sum(reserved_bytes),0) FROM media_attempts)
 +(SELECT COALESCE(sum(d.size),0) FROM media_derivatives d JOIN media_attempts a ON a.id=d.attempt_id WHERE a.state='published') AS used_bytes;
CREATE VIRTUAL TABLE messages_fts USING fts5(content,content='messages',content_rowid='rowid',tokenize='unicode61 remove_diacritics 0');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
 INSERT INTO messages_fts(rowid,content) VALUES(new.rowid,new.content);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
 INSERT INTO messages_fts(messages_fts,rowid,content) VALUES('delete',old.rowid,old.content);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
 INSERT INTO messages_fts(messages_fts,rowid,content) VALUES('delete',old.rowid,old.content);
 INSERT INTO messages_fts(rowid,content) VALUES(new.rowid,new.content);
END;
