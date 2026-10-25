-- Dev workspace for `wrangler dev` with TAPPET_DEV_AUTH=1.
-- wrangler d1 execute tappet --local --file=seed-dev.sql
INSERT OR IGNORE INTO workspaces (id, name) VALUES ('ws_dev', 'My business');
INSERT OR IGNORE INTO users (id, email, name) VALUES ('user_dev', 'dev@localhost', 'Developer');
INSERT OR IGNORE INTO memberships (workspace_id, user_id, role) VALUES ('ws_dev', 'user_dev', 'owner');
