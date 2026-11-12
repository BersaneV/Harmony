CREATE TABLE users (
 id uuid PRIMARY KEY, username text UNIQUE NOT NULL, display_name text NOT NULL,
 password_hash text NOT NULL, is_admin boolean NOT NULL DEFAULT false,
 disabled boolean NOT NULL DEFAULT false, auth_version bigint NOT NULL DEFAULT 1,
 preferences jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 version bigint NOT NULL DEFAULT 1, refresh_hash text UNIQUE NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE used_refresh_tokens (hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id), expires_at timestamptz NOT NULL);
CREATE TABLE password_resets (hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE TABLE guilds (id uuid PRIMARY KEY, name text NOT NULL, owner_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE guild_members (guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), role text NOT NULL CHECK(role IN('owner','admin','member')), PRIMARY KEY(guild_id,user_id));
CREATE TABLE channels (id uuid PRIMARY KEY, guild_id uuid REFERENCES guilds(id) ON DELETE CASCADE, name text NOT NULL, kind text NOT NULL CHECK(kind IN('text','voice','dm','group')), last_seq bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), CHECK((guild_id IS NOT NULL AND kind IN('text','voice')) OR (guild_id IS NULL AND kind IN('dm','group'))));
CREATE INDEX channels_guild ON channels(guild_id);
CREATE TABLE channel_members (channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY(channel_id,user_id));
CREATE TABLE friends (id uuid PRIMARY KEY, requester_id uuid NOT NULL REFERENCES users(id), addressee_id uuid NOT NULL REFERENCES users(id), status text NOT NULL CHECK(status IN('pending','accepted')), created_at timestamptz NOT NULL DEFAULT now(), CHECK(requester_id<>addressee_id));
CREATE UNIQUE INDEX friends_pair ON friends(LEAST(requester_id,addressee_id),GREATEST(requester_id,addressee_id));
CREATE TABLE invites (hash text PRIMARY KEY, guild_id uuid REFERENCES guilds(id) ON DELETE CASCADE, created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, max_uses integer NOT NULL CHECK(max_uses BETWEEN 1 AND 100), uses integer NOT NULL DEFAULT 0);
CREATE TABLE messages (id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE, author_id uuid NOT NULL REFERENCES users(id), client_nonce uuid NOT NULL, content text NOT NULL, seq bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), edited_at timestamptz, deleted boolean NOT NULL DEFAULT false, request_hash text NOT NULL, UNIQUE(channel_id,seq), UNIQUE(channel_id,author_id,client_nonce));
CREATE INDEX messages_search ON messages USING gin(to_tsvector('simple',content));
CREATE TABLE reactions (message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), emoji text NOT NULL, PRIMARY KEY(message_id,user_id,emoji));
CREATE TABLE channel_reads (channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id), seq bigint NOT NULL, PRIMARY KEY(channel_id,user_id));
CREATE TABLE uploads (id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id), user_id uuid NOT NULL REFERENCES users(id), object_key text UNIQUE NOT NULL, name text NOT NULL, size bigint NOT NULL, content_type text NOT NULL, status text NOT NULL CHECK(status IN('pending','ready','rejected')), message_id uuid REFERENCES messages(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX uploads_owner ON uploads(user_id,status);
CREATE TABLE outbox (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id), event jsonb NOT NULL, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX outbox_pending ON outbox(id) WHERE delivered_at IS NULL;
CREATE TABLE audit (id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL, target_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE media_members (channel_id uuid NOT NULL REFERENCES channels(id), user_id uuid NOT NULL REFERENCES users(id), session_id uuid NOT NULL REFERENCES sessions(id), identity text NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(channel_id,session_id));
CREATE TABLE media_bans (channel_id uuid NOT NULL REFERENCES channels(id), user_id uuid NOT NULL REFERENCES users(id), until_at timestamptz NOT NULL, PRIMARY KEY(channel_id,user_id));
CREATE VIEW public_users AS SELECT id,username,display_name,is_admin,disabled,preferences,created_at FROM users;
ALTER TABLE messages ADD COLUMN change_seq bigint NOT NULL;
CREATE INDEX messages_changes ON messages(channel_id,change_seq);
CREATE TABLE media_mutes (channel_id uuid NOT NULL REFERENCES channels(id), user_id uuid NOT NULL REFERENCES users(id), PRIMARY KEY(channel_id,user_id));
