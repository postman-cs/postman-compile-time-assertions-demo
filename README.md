# postman-compile-time-assertions-demo

A small, self-contained demo of a **pre-merge API contract gate**: build the service
in the CI runner, start it, replay a Postman contract collection against the running
process, and fail the pull request if a response stops matching the OpenAPI spec.

"Compile-time assertion" here means a CI gate that fires before merge. It is not Python
type checking. The name comes from where the check runs: in your runner, on the compiled
artifact, before anything is deployed.

## Why this exists

A collection that replays the happy-path flow proves the flow you intended works. It does
not prove the compiled service behaves to spec. To assert runtime correctness you have to
run the collection against the actual running service.

You can do that against a deployed environment, and you should. But there is an earlier,
cheaper place to do it: the runner itself. Build the service, start it in a container, run
the contract collection against `localhost`, and you catch schema drift in seconds, on the
PR, before it ever reaches a gateway or APIM. That is the whole idea.

This repo is a worked example of that loop using the CSE-managed Postman onboarding actions.

## The loop

```
openapi/openapi.yaml                      the source of truth
        │
        ▼  (managed Postman actions, in CI)
[Baseline] [Smoke] [Contract] collections generated from the spec
        │
        ▼  (CI builds + starts the service)
docker compose up  →  http://127.0.0.1:8080
        │
        ▼  (Postman CLI replays cloud collections against the running service)
postman collection run <smoke>      curated journey, stays green
postman collection run <contract>   validates every response against the schema
        │
        ▼
red contract check  ⇒  the PR is blocked
        │
        ▼  (always() teardown)
workspace + mock deleted  ⇒  no residue, re-runnable from a clean slate
```

Each CI run creates its own throwaway Postman workspace (a unique name per run), uses it,
and deletes it in an `always()` step. Nothing generated is committed to the repo, so the
demo runs fresh every time.

## Two layers, one run

- **Smoke** is the curated, human-authored journey (`postman/flows/smoke.flow.yaml`). It
  asserts the journey runs end to end: a successful status, a response body, ids chaining
  from one call to the next. This is the shareable asset another team forks to learn the API.
- **Contract** is generated from the spec and validates every response body against the full
  OpenAPI schema. This is the drift detector and the thing that gates the merge.

They are independent, and the demo proves it. The `demo/contract-break` path drops the
required `price.currency` field from the service response. The contract run goes red because
it enforces the schema; smoke stays green because it never asserts `currency`.

## Do both, and why

Run the contract collection in two places:

1. **Pre-merge, in the runner (this gate).** Fast and cheap. It blocks the merge. It runs
   against `localhost` with stubbed upstreams, so it cannot see environment, IAM, network, or
   real-dependency failures.
2. **Post-deploy, against the live service.** Catches exactly the failures the gate cannot:
   gateway config, identity, networking, real upstream behavior.

They cover different failure classes. The pre-merge gate is necessary and it is not a
replacement for the post-deploy run. A red here tells you the problem is your code or your
spec, before you have spent a deploy finding out.

## Repository layout

```
app/
  app.py              Flask service (3 endpoints; UPSTREAM_MODE + DROP_CURRENCY toggles)
  upstreams.py        account + pricing upstream adapters (stub | http)
  requirements.txt
openapi/
  openapi.yaml        the contract: strict 2xx schemas, required price.currency enum
postman/
  flows/smoke.flow.yaml   curated smoke journey (POST decision -> GET decision)
  mocks/                  local upstream mocks for the UPSTREAM_MODE=http variant
Dockerfile
compose.yaml            stub-mode service (HOST_PORT overridable for local runs)
compose.http-mocks.yaml override for the http upstream variant
scripts/
  resolve-postman-resources.rb   reads resources.yaml -> exports cloud UIDs to CI
  teardown-postman.mjs           deletes the run's workspace + mock (and a sweep mode)
.github/workflows/
  contract-gate.yml     the demo: onboard -> build -> run -> teardown, on every PR
  teardown.yml          manual backstop sweep for runs that died before teardown
docs/index.html         a one-page explainer of the concept
```

## Run the demo (two clicks)

Prerequisite (one time): set the repo secret `POSTMAN_API_KEY` to a Postman service-account
key. Use a disposable, non-org-mode team — every run creates and deletes a workspace there.

```sh
gh secret set POSTMAN_API_KEY --repo postman-cs/postman-compile-time-assertions-demo
```

Then:

1. **Green check.** Open a pull request (branch inside this repo so the run gets the secret;
   a fork will not). The **Contract Gate** check builds the service and runs the collections
   against it. Green means the running service matches the spec. You can also trigger it from
   the Actions tab with "Run workflow".
2. **Red check.** Open the `demo/contract-break` branch as a PR. The contract step fails on
   `OpenAPI schema validation failed for GET /decisions/{decisionId} ...`, the failing test is
   `Response body matches OpenAPI schema`, and smoke stays green.

Each run cleans up its own Postman workspace, so you can run it as many times as you like.

## Run it locally

```sh
# stub upstreams (default). Use HOST_PORT if 8080 is taken locally.
HOST_PORT=18080 docker compose up -d --build
curl -fsS http://127.0.0.1:18080/health
curl -fsS -X POST http://127.0.0.1:18080/decisions \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"cust_123","sku":"fiber_1g"}'
curl -fsS http://127.0.0.1:18080/decisions/dec_demo_0001
docker compose down -v
```

Reproduce the break locally:

```sh
DROP_CURRENCY=true HOST_PORT=18080 docker compose up -d --build
# POST/GET responses now omit price.currency; the contract validator would fail this.
```

## Mocking upstreams

The decision logic depends on two upstreams (account standing, pricing). Two ways to supply
them:

- **`UPSTREAM_MODE=stub` (default).** Deterministic in-process data in `app/upstreams.py`. No
  network on the request path. CI uses this so a flaky upstream can never be mistaken for real
  schema drift.
- **`UPSTREAM_MODE=http`.** The service calls `ACCOUNT_API_BASE_URL` and `PRICING_API_BASE_URL`.
  `postman/mocks/*` are local mock servers (runnable with `postman mock run <config>.json` or
  directly with `node`) that stand in for those upstreams. They bind `0.0.0.0` so the container
  reaches them through `host.docker.internal`:

  ```sh
  node postman/mocks/account-service.js &   # :9101
  node postman/mocks/pricing-service.js &   # :9102
  docker compose -f compose.yaml -f compose.http-mocks.yaml up -d --build
  ```

## How the onboarding chain is wired

`contract-gate.yml` runs the managed CSE actions in order, all on the one non-org key:

1. `postman-resolve-service-token-action` mints a service-account access token.
2. `postman-bootstrap-action` uploads the spec and generates the baseline, smoke, and contract
   collections. It also injects the contract test scripts and a `00 - Resolve Secrets` item.
3. `postman-smoke-flow-action` rewrites the canonical Smoke collection from the curated
   `flow.yaml`.
4. `postman-repo-sync-action` creates the `ci` environment and writes `.postman/resources.yaml`
   (with `repo-write-mode: none`, so it lands on disk for the resolver and the artifact upload
   without being committed).

Two details that matter:

- Both collection runs pass `--env-var "CI=true"`, which makes the injected `00 - Resolve
  Secrets` item early-return instead of calling AWS. Without it that item can red the run for a
  reason that has nothing to do with schema drift.
- Both runs pass `--env-var "baseUrl=http://127.0.0.1:8080"` to point the generated `{{baseUrl}}`
  requests at the local container. The collections run as cloud UIDs so the Postman CLI can emit
  JUnit (local v3 YAML collections only support the CLI reporter).

## Cleanup and re-runnability

The gate tears itself down. `scripts/teardown-postman.mjs` deletes the run's workspace (which
cascades its spec, collections, and environment) and its team-scoped mock. If a run is killed
before its teardown step, run the **Teardown Postman residue** workflow (or
`node scripts/teardown-postman.mjs --name-prefix=cta-demo-`) to sweep strays.

## Validated

This demo was exercised end to end against a disposable Postman team before publishing:

- The spec passes `postman-bootstrap-action`'s governance lint.
- `postman-smoke-flow-action` resolves 2 operations and emits 12 assertions.
- The generated contract collection inlines `dec_demo_0001` in the GET path, carries a JSON POST
  body, references `{{baseUrl}}`, and its embedded validator requires `price.currency`.
- Teardown deletes the workspace and mock with zero residue.

Built on Node 24, Flask, Docker Compose, and the Postman CLI (not Newman).
