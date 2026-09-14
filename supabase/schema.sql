-- RepoVault schema for Supabase (Postgres).
-- Coexists with existing tables (e.g. the Resource Vault data already in this project):
-- it only ADDS RepoVault tables and REUSES the existing "tags" table. Safe to re-run.
-- NOTE: run history is intentionally NOT stored — execution records live in
-- server memory only (see src/services/runner.js) and are lost on restart.

create table if not exists projects (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  repo_url    text not null default '',
  description text not null default '',
  purpose     text not null default '',
  created_at  timestamptz not null default now()
);

-- The "tags" table already exists in this project (uuid id, name, created_at) and
-- is shared with the Resource Vault app. It is reused as-is: no CREATE, no
-- constraint changes. RepoVault tolerates duplicate tag names in app code.
create table if not exists project_tags (
  project_id bigint not null references projects(id) on delete cascade,
  tag_id     uuid not null references tags(id) on delete cascade,
  primary key (project_id, tag_id)
);

create table if not exists recipes (
  id          bigint generated always as identity primary key,
  project_id  bigint not null references projects(id) on delete cascade,
  title       text not null,
  command     text not null,
  args        text not null default '',
  setup       text not null default '',
  env         text not null default '',
  working_dir text not null default '',
  use_venv    smallint not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_recipes_project on recipes(project_id);
create index if not exists idx_project_tags_tag on project_tags(tag_id);

