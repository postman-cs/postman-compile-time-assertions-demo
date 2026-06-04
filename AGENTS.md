# postman-compile-time-assertions-demo — Agent Notes

## What this is

A demo of a pre-merge API contract gate. CI builds a small Flask service, starts it in the
runner, and replays a Postman contract collection (generated from `openapi/openapi.yaml`)
against the running process. A response that stops matching the spec reds the PR check. Every
run creates a throwaway Postman workspace and deletes it in an `always()` step, so the demo is
ephemeral and re-runnable. Full concept writeup: `README.md` and `docs/index.html`.

This is a concept-validation demo. It is not a production service.

## Map (what is where, and why)

| Path | Why it exists |
| --- | --- |
| `openapi/openapi.yaml` | The contract. Strict 2xx schemas; `price.currency` is a required enum (the drift target). |
| `app/app.py` | Flask service: `GET /health`, `POST /decisions`, `GET /decisions/{id}`. Seeds `dec_demo_0001`. |
| `app/upstreams.py` | Account + pricing upstream adapters. `UPSTREAM_MODE=stub` (default) or `http`. |
| `postman/flows/smoke.flow.yaml` | The curated smoke journey. Asserts the flow runs; never asserts `currency`. |
| `postman/mocks/*` | Local upstream mocks for the `UPSTREAM_MODE=http` variant only. |
| `Dockerfile`, `compose.yaml` | Build + run the service. `HOST_PORT` overrides the host port locally. |
| `compose.http-mocks.yaml` | Override that points the service at the local mock servers. |
| `scripts/resolve-postman-resources.rb` | Reads `.postman/resources.yaml`, exports cloud UIDs to `$GITHUB_ENV`. |
| `scripts/teardown-postman.mjs` | Deletes the run's workspace + mock. Has a `--name-prefix` sweep mode. |
| `.github/workflows/contract-gate.yml` | The demo: onboard -> build -> run smoke+contract -> teardown. |
| `.github/workflows/teardown.yml` | Manual backstop sweep for runs that died before their teardown step. |

## How the gate works

`contract-gate.yml` runs on every PR (and `workflow_dispatch`) as one job:

1. `postman-resolve-service-token-action` mints a service-account access token.
2. `postman-bootstrap-action` uploads the spec, generates the baseline/smoke/contract
   collections, injects the contract tests and a `00 - Resolve Secrets` item.
3. `postman-smoke-flow-action` rewrites the canonical Smoke collection from `smoke.flow.yaml`.
4. `postman-repo-sync-action` (`repo-write-mode: none`) creates the `ci` environment and writes
   `.postman/resources.yaml` to disk without committing it.
5. `docker compose up` builds and starts the service; the runner curls `/health` for readiness.
6. Postman CLI runs the smoke and contract cloud UIDs against `baseUrl=http://127.0.0.1:8080`.
7. An `always()` step tears down the workspace + mock; another stops the service.

Load-bearing details (do not drop these):

- Both collection runs pass `--env-var "CI=true"` so the injected `00 - Resolve Secrets` item
  early-returns instead of calling AWS and reding the run for a non-drift reason.
- Both runs pass `--env-var "baseUrl=http://127.0.0.1:8080"` to bind the generated `{{baseUrl}}`.
- Runs use cloud collection UIDs so the Postman CLI can emit JUnit (local v3 YAML is CLI-only).
- The workspace name is unique per run (`cta-demo-<run_id>-<run_attempt>`) so concurrent or
  re-run jobs never collide on the shared team.

## The negative proof

Dropping the required `price.currency` from the service response makes the contract run red
while smoke stays green (smoke never asserts `currency`). Toggle it with `DROP_CURRENCY=true`,
or open the `demo/contract-break` branch as a PR. Failure detail:
`OpenAPI schema validation failed ...`; failing test: `Response body matches OpenAPI schema`.

## Running from an agent harness

Validate the service (no credentials needed):

```sh
HOST_PORT=18080 docker compose up -d --build
curl -fsS http://127.0.0.1:18080/health
curl -fsS -X POST http://127.0.0.1:18080/decisions -H 'Content-Type: application/json' \
  -d '{"customerId":"cust_123","sku":"fiber_1g"}'
curl -fsS http://127.0.0.1:18080/decisions/dec_demo_0001
docker compose down -v
```

Exercise the full onboarding chain locally (needs a Postman service-account key for a
disposable, non-org team). Set `POSTMAN_API_KEY`, then drive each action's `dist/cli.cjs` with
`--kebab-key=value` flags in this order: resolve-service-token -> bootstrap -> smoke-flow ->
repo-sync (`--repo-write-mode=none`), using a unique `--project-name`. Outputs are JSON on
stdout, logs on stderr. Inspect the generated `.postman/resources.yaml` and the
`[Contract] ...` collection, then clean up:

```sh
node scripts/teardown-postman.mjs --workspace-id=<id> --mock-url=<url>
# or sweep strays by name:
node scripts/teardown-postman.mjs --name-prefix=cta-demo-
```

Always tear down what a run created. The non-org team is disposable, but leaving residue breaks
the next clean run.

## Credentials

- One secret, `POSTMAN_API_KEY`: a Postman service-account key for a disposable, non-org-mode
  team. The same key onboards and logs in the CLI. Do not set `POSTMAN_TEAM_ID` or
  `workspace-team-id` (this demo is non-org-mode; the team is derived from the key).
- Never print, commit, or paste the key into logs, fixtures, or docs.

## Conventions and constraints

- Nothing Postman-generated is committed. `.postman/` and `postman/collections|environments/`
  are gitignored; CI uploads them as artifacts instead.
- Keep the service tiny. The point is the gate, so do not grow `app/` into a real backend.
- The gate depends on the pinned `postman-cs/postman-*-action` releases (see the `uses:` refs in
  `contract-gate.yml`); bump those tags to upgrade. PR runs need the branch to live in this repo
  (a fork will not receive the secret).
- Inputs/outputs in the workflows use kebab-case, matching the actions.

## Anti-patterns

- Do not commit `.postman/resources.yaml` or generated collections.
- Do not switch the smoke flow to assert `currency`; that would break the independent-layers
  proof.
- Do not run the contract collection as a local v3 YAML path expecting JUnit; use cloud UIDs.
- Do not point the demo at an org-mode team; teardown deletes the workspace each run.
