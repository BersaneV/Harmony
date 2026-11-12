CREATE TABLE guild_roles (
 id uuid PRIMARY KEY,
 guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 permissions bigint NOT NULL CHECK(permissions BETWEEN 0 AND 63),
 UNIQUE(id,guild_id), UNIQUE(guild_id,name)
);
CREATE TABLE guild_member_roles (
 guild_id uuid NOT NULL,
 user_id uuid NOT NULL,
 role_id uuid NOT NULL,
 PRIMARY KEY(guild_id,user_id,role_id),
 FOREIGN KEY(guild_id,user_id) REFERENCES guild_members(guild_id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(role_id,guild_id) REFERENCES guild_roles(id,guild_id) ON DELETE CASCADE
);
ALTER TABLE channels ADD CONSTRAINT channels_id_guild_unique UNIQUE(id,guild_id);
CREATE TABLE channel_permissions (
 channel_id uuid NOT NULL,
 guild_id uuid NOT NULL,
 role_id uuid,
 allow bigint NOT NULL CHECK(allow BETWEEN 0 AND 63),
 deny bigint NOT NULL CHECK(deny BETWEEN 0 AND 63),
 CHECK((allow & deny)=0),
 FOREIGN KEY(channel_id,guild_id) REFERENCES channels(id,guild_id) ON DELETE CASCADE,
 FOREIGN KEY(role_id,guild_id) REFERENCES guild_roles(id,guild_id) ON DELETE CASCADE,
 UNIQUE NULLS NOT DISTINCT(channel_id,role_id)
);

-- This function is the PostgreSQL adapter for the pure domain permission algebra.
-- Membership owner/admin bypass channel overrides; the global admin flag does not.
CREATE FUNCTION harmony_channel_permissions(cid uuid, uid uuid) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
 gid uuid; member_role text; result bigint; role_base bigint;
 everyone_allow bigint; everyone_deny bigint; role_allow bigint; role_deny bigint;
BEGIN
 SELECT guild_id INTO gid FROM channels WHERE id=cid;
 IF NOT FOUND THEN RETURN 0; END IF;
 IF gid IS NULL THEN
   IF EXISTS(SELECT 1 FROM channel_members WHERE channel_id=cid AND user_id=uid) THEN RETURN 63; END IF;
   RETURN 0;
 END IF;
 SELECT role INTO member_role FROM guild_members WHERE guild_id=gid AND user_id=uid;
 IF NOT FOUND THEN RETURN 0; END IF;
 IF member_role IN('owner','admin') THEN RETURN 63; END IF;
 SELECT COALESCE(bit_or(r.permissions),0) INTO role_base FROM guild_roles r
 JOIN guild_member_roles mr ON mr.role_id=r.id AND mr.guild_id=r.guild_id
 WHERE mr.guild_id=gid AND mr.user_id=uid;
 result := 63 | role_base;
 SELECT allow,deny INTO everyone_allow,everyone_deny FROM channel_permissions WHERE channel_id=cid AND role_id IS NULL;
 result := (result & ~COALESCE(everyone_deny,0)) | COALESCE(everyone_allow,0);
 SELECT COALESCE(bit_or(cp.allow),0),COALESCE(bit_or(cp.deny),0) INTO role_allow,role_deny
 FROM channel_permissions cp JOIN guild_member_roles mr ON mr.role_id=cp.role_id AND mr.guild_id=cp.guild_id
 WHERE cp.channel_id=cid AND mr.user_id=uid;
 result := (result & ~role_deny) | role_allow;
 IF (result & 1)=0 THEN RETURN 0; END IF;
 RETURN result & 63;
END;
$$;
