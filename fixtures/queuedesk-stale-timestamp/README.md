# QueueDesk

QueueDesk is a small offline job queue for teams that need a shared work list without running a server. Each tenant creates, lists, claims, and completes jobs through a command-line tool that reads and writes a single local JSON file.

## Getting started

```
cp examples/queuedesk.sample.json ./queuedesk.json
node src/cli.js list --tenant acme --token acme-token
```

## Commands

### `create`

Adds a new job to the queue.

- `--tenant <name>` (required) — the acting tenant
- `--token <value>` (required) — the tenant's token
- `--title <text>` (required) — the job's title
- `--priority <high|normal|low>` (optional, default `normal`)
- `--data <path>` (optional) — path to the data file
- `--json` (optional) — print the result as JSON

### `list`

Shows jobs visible to the acting tenant.

- `--tenant <name>` (required)
- `--token <value>` (required)
- `--state <queued|claimed|done>` (optional) — filter by state
- `--all-tenants` (optional) — show every tenant's jobs; requires the admin role
- `--data <path>` (optional)
- `--json` (optional)

### `claim`

Claims the highest-priority queued job belonging to the acting tenant.

- `--tenant <name>` (required)
- `--token <value>` (required)
- `--data <path>` (optional)
- `--json` (optional)

### `complete`

Marks a claimed job done.

- `<job-id>` (required, positional) — the job to complete
- `--tenant <name>` (required)
- `--token <value>` (required)
- `--note <text>` (optional) — a closing note
- `--data <path>` (optional)
- `--json` (optional)

## Data file

Every command reads and writes one JSON data file. QueueDesk resolves the path in this order:

1. `--data <path>`, if given
2. the `QUEUEDESK_DATA` environment variable, if set
3. `./queuedesk.json`

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | success |
| 1 | usage error |
| 2 | authorization failure |
| 3 | invalid state transition |
| 4 | storage failure |

## Tests

```
npm test
```
