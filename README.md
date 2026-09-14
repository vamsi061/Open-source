# RepoVault

A personal catalog of open-source projects with **one-click execution** of run recipes. Never forget which project does what, or how you ran it last time.

## Stack

- Node.js + Express (REST API)
- **Supabase (Postgres)** — all projects, recipes, tags and run history are stored in the cloud
- `@supabase/supabase-js` for data access

## Setup

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. In the Supabase Dashboard → **SQL Editor**, paste the contents of `supabase/schema.sql` and run it. This creates all tables.
3. Copy the keys from **Project Settings → API** into `.env`:

   ```bash
   cp .env.example .env
   # then edit .env:
   # SUPABASE_URL=https://<project-ref>.supabase.co
   # SUPABASE_SERVICE_ROLE_KEY=<service-role key>
   ```

   The **service role key** is used server-side only (it bypasses Row Level Security) — never expose it in a browser app.
4. Install and run:

```bash
npm install
npm start          # API on http://localhost:4000
```

### Migrating an existing local catalog

If you have data in the old local SQLite DB (`data/repovault.db`), push it to Supabase once:

```bash
node scripts/migrate-sqlite-to-supabase.js
```

IDs are remapped during migration, so run it only once (and preferably against empty tables), then delete `data/`.

## Run

```bash
npm install
npm start          # API on http://localhost:4000
```

## API

### Projects
| Method | Path | Description |
|---|---|---|
| GET | `/api/projects?q=pdf` | List / search (matches name, description, purpose, repo URL, tags) |
| GET | `/api/projects/:id` | Detail incl. tags + recipes |
| POST | `/api/projects` | Create `{name, repo_url, description, purpose, tags:[]}` |
| PUT | `/api/projects/:id` | Update |
| DELETE | `/api/projects/:id` | Delete (cascades recipes) |

### Recipes (how to run a project)
| Method | Path | Description |
|---|---|---|
| GET | `/api/recipes?project_id=1` | List recipes |
| POST | `/api/recipes` | Create `{project_id, title, command, args, setup, working_dir, env}` — `command` accepts multiple lines (run in order), `args` is appended to the command line |
| PUT | `/api/recipes/:id` | Update |
| DELETE | `/api/recipes/:id` | Delete |
| POST | `/api/recipes/:id/run` | **⭐ One-click execute** — body `{input?, args?}`: stdin text for interactive scripts, per-run args override |
| POST | `/api/recipes/:id/kill` | Stop latest running execution |
| GET | `/api/recipes/:id/runs` | Run history for a recipe |

### Runs (execution — in memory only)
| Method | Path | Description |
|---|---|---|
| GET | `/api/runs?recipe_id=&status=` | Recent runs (filterable) |
| GET | `/api/runs/:id` | Poll status + captured output |
| POST | `/api/runs/:id/kill` | Kill a running execution |

Run records live in server memory only — they are **not** stored in Supabase and are cleared when the server restarts.

### Tags / Health
- `GET /api/tags` - all tags with usage counts
- `GET /api/health` - `{ok:true}`

## Example: full flow

```bash
# 1. Register a project
curl -X POST localhost:4000/api/projects -H 'Content-Type: application/json' \
  -d '{"name":"Nginx Proxy Manager","repo_url":"https://github.com/NginxProxyManager/nginx-proxy-manager","purpose":"Reverse proxy with UI","tags":["proxy","network"]}'

# 2. Save how you run it
curl -X POST localhost:4000/api/recipes -H 'Content-Type: application/json' \
  -d '{"project_id":1,"title":"Start server","command":"npm run dev","setup":"npm install","working_dir":"/root/nginx-proxy-manager"}'

# 3. One-click run (returns run_id)  ->  POST /api/recipes/1/run
# 4. Check output                    ->  GET /api/runs/1
# 5. Months later: what was it for?  ->  GET /api/projects?q=proxy
```

## Notes

- Commands run via `/bin/bash -c` in the recipe's `working_dir` (or repo dir). Output capped at ~200KB per run.
- Stdin: `POST /api/recipes/:id/run` accepts `{input: "..."}` (one answer per line), piped to the script. With no input, stdin is closed (EOF) so scripts that call `input()` fail fast instead of hanging in `running` forever. In the UI, use the ⌨ button to type answers at run time.
- `setup` runs before `command` in the same shell (e.g. `npm install`).
- `env` accepts `KEY=value` lines, applied to the run's environment.
- Run history is kept in server memory only (last ~500 runs) and is lost on restart — executions are never stored in Supabase.
- Stored in Supabase: projects (GitHub repos), tags, and recipes only.
