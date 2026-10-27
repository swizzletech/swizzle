-- The team Release (RELEASE_TEAM_ID in packages/db/src/access.ts) holds production of the Default project; the first owner joins it at setup.
INSERT INTO "teams" ("id", "name", "normalized_name") VALUES ('00000000-0000-4000-8000-000000000002', 'Release', 'release');--> statement-breakpoint
INSERT INTO "environment_grants" ("project_id", "environment", "team_id", "role") VALUES ('00000000-0000-4000-8000-000000000001', 'production', '00000000-0000-4000-8000-000000000002', 'editor');
