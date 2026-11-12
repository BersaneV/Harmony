-- Keep PostgreSQL simple-parser lexemes instead of silently changing search
-- semantics to SQLite's default punctuation tokenizer. Rust fills/rebuilds them.
ALTER TABLE messages ADD COLUMN search_lexemes TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN search_index_version INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER messages_fts_insert;
DROP TRIGGER messages_fts_delete;
DROP TRIGGER messages_fts_update;
DROP TABLE messages_fts;
CREATE VIRTUAL TABLE messages_fts USING fts5(search_lexemes,content='messages',content_rowid='rowid',tokenize='ascii');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
 INSERT INTO messages_fts(rowid,search_lexemes) VALUES(new.rowid,new.search_lexemes);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
 INSERT INTO messages_fts(messages_fts,rowid,search_lexemes) VALUES('delete',old.rowid,old.search_lexemes);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF search_lexemes ON messages BEGIN
 INSERT INTO messages_fts(messages_fts,rowid,search_lexemes) VALUES('delete',old.rowid,old.search_lexemes);
 INSERT INTO messages_fts(rowid,search_lexemes) VALUES(new.rowid,new.search_lexemes);
END;
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
