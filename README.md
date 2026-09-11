# RepoVault

A personal catalog of open-source projects with **one-click execution** of run recipes. Never forget which project does what, or how you ran it last time.

## Stack

- Node.js + Express (REST API)
- SQLite via `node:sqlite` (built into Node 24+ - zero native deps, npm-only)

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
| DELETE | `/api/projects/:id` | Delete (cascades recipes/runs) |

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

### Runs (execution history)
| Method | Path | Description |
|---|---|---|
| GET | `/api/runs?recipe_id=&status=` | History (filterable) |
| GET | `/api/runs/:id` | Poll status + captured output |
| POST | `/api/runs/:id/kill` | Kill a running execution |

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
- Runs orphaned by a server restart are automatically marked failed.
- DB file: `data/repovault.db` (gitignored).
