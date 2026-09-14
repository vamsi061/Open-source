-- RepoVault schema for Supabase (Postgres).
-- Creates all RepoVault tables: projects, categories, tags, project_tags, recipes.
-- Safe to re-run (idempotent: everything is "if not exists").
-- NOTE: run history is intentionally NOT stored — execution records live in
-- server memory only (see src/services/runner.js) and are lost on restart.

create table if not exists categories (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists projects (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  repo_url    text not null default '',
  description text not null default '',
  purpose     text not null default '',
  category_id bigint references categories(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table projects add column if not exists category_id bigint references categories(id) on delete set null;

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
  stdin       text not null default '',
  working_dir text not null default '',
  use_venv    smallint not null default 0,
  input_as_args smallint not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_recipes_project on recipes(project_id);
-- stdin: optional pre-fill default for the Run dialog (one answer per line).
-- Run-time input itself is NEVER persisted — it changes on every run.
alter table recipes add column if not exists stdin text not null default '';
-- input_as_args: when 1, Run-dialog input is appended to the command as quoted
-- CLI arguments (one per line, replacing stored args for that run) instead of stdin.
alter table recipes add column if not exists input_as_args smallint not null default 0;
create index if not exists idx_project_tags_tag on project_tags(tag_id);
create index if not exists idx_projects_category on projects(category_id);

