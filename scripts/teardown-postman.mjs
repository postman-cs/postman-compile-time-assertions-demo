#!/usr/bin/env node
// Postman resource teardown for the compile-time-assertions demo.
//
// The demo is ephemeral: every run creates a fresh workspace (unique name), a
// spec, three collections, an environment, and one team-scoped mock. Deleting
// the workspace cascades its specs/collections/environments, but the mock is
// team-scoped and must be deleted on its own. This script does both so a run
// leaves no residue and the demo can be run again from a clean slate.
//
// Two modes:
//   --workspace-id=<id> [--mock-url=<url>] [--monitor-id=<uid>]
//       Targeted teardown of exactly what one run created (used in CI, always()).
//   --name-prefix=<prefix>
//       Backstop sweep: delete every workspace whose name starts with <prefix>
//       plus that workspace's mocks. Cleans up runs that died before their own
//       teardown. Safe because the demo's workspace names are unique to it.
//
// Auth: POSTMAN_API_KEY (the non-org service-account key). Deletes use the
// X-Api-Key header. Per-item failures are reported, not fatal, so an always()
// CI step never masks the real job result.

const API_HOST = "https://api.getpostman.com";

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith("--")) out[arg.slice(2)] = true;
  }
  return out;
}

function headers(apiKey) {
  return { "Content-Type": "application/json", "X-Api-Key": apiKey };
}

async function httpDelete(path, apiKey) {
  const res = await fetch(`${API_HOST}${path}`, { method: "DELETE", headers: headers(apiKey) });
  if (res.status === 404) return { status: "not-found" };
  if (!res.ok) return { status: "error", detail: `${res.status} ${await safeText(res)}` };
  return { status: "deleted" };
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 200); } catch { return ""; }
}

async function getJson(path, apiKey) {
  try {
    const res = await fetch(`${API_HOST}${path}`, { method: "GET", headers: headers(apiKey) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function listMocks(apiKey) {
  const data = await getJson("/mocks", apiKey);
  const mocks = Array.isArray(data?.mocks) ? data.mocks : [];
  return mocks
    .map((m) => ({
      uid: String(m?.uid ?? "").trim(),
      mockUrl: String(m?.mockUrl ?? "").trim(),
      workspace: String(m?.workspace ?? "").trim(),
    }))
    .filter((m) => m.uid);
}

async function listWorkspaces(apiKey) {
  const data = await getJson("/workspaces", apiKey);
  const ws = Array.isArray(data?.workspaces) ? data.workspaces : [];
  return ws
    .map((w) => ({ id: String(w?.id ?? "").trim(), name: String(w?.name ?? "").trim() }))
    .filter((w) => w.id);
}

function log(item) {
  const tag = item.status === "deleted" ? "deleted" : item.status === "not-found" ? "absent" : "ERROR";
  console.log(`[${tag}] ${item.kind} ${item.ref}${item.detail ? ` -- ${item.detail}` : ""}`);
}

async function deleteWorkspaceWithMocks(apiKey, workspaceId, results, knownMocks) {
  const mocks = (knownMocks ?? (await listMocks(apiKey))).filter((m) => m.workspace === workspaceId);
  for (const mock of mocks) {
    const r = await httpDelete(`/mocks/${mock.uid}`, apiKey);
    const item = { kind: "mock", ref: mock.mockUrl || mock.uid, ...r };
    log(item); results.push(item);
  }
  const r = await httpDelete(`/workspaces/${workspaceId}`, apiKey);
  const item = { kind: "workspace", ref: workspaceId, ...r };
  log(item); results.push(item);
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = (process.env.POSTMAN_API_KEY ?? "").trim();
  if (!apiKey) {
    console.error("POSTMAN_API_KEY is required");
    process.exit(2);
  }

  const results = [];

  if (args["monitor-id"]) {
    const r = await httpDelete(`/monitors/${args["monitor-id"]}`, apiKey);
    const item = { kind: "monitor", ref: String(args["monitor-id"]), ...r };
    log(item); results.push(item);
  }

  if (args["workspace-id"]) {
    // Targeted: delete the run's mock(s), then the workspace. Match both the
    // exact mock-url and any mock scoped to this workspace, so a team-index lag
    // on the URL lookup can never orphan a mock.
    const wsId = String(args["workspace-id"]);
    const mockUrl = args["mock-url"] ? String(args["mock-url"]) : "";
    const mocks = await listMocks(apiKey);
    const targets = mocks.filter((m) => m.workspace === wsId || (mockUrl && m.mockUrl === mockUrl));
    if (mockUrl && targets.length === 0) {
      const item = { kind: "mock", ref: mockUrl, status: "not-found", detail: "no /mocks entry matched (cascades with workspace delete)" };
      log(item); results.push(item);
    }
    for (const mock of targets) {
      const r = await httpDelete(`/mocks/${mock.uid}`, apiKey);
      const item = { kind: "mock", ref: mock.mockUrl || mock.uid, uid: mock.uid, ...r };
      log(item); results.push(item);
    }
    const r = await httpDelete(`/workspaces/${wsId}`, apiKey);
    const item = { kind: "workspace", ref: wsId, ...r };
    log(item); results.push(item);
  } else if (args["name-prefix"]) {
    const prefix = String(args["name-prefix"]);
    const [workspaces, mocks] = await Promise.all([listWorkspaces(apiKey), listMocks(apiKey)]);
    const matched = workspaces.filter((w) => w.name.startsWith(prefix));
    console.log(`sweep: ${matched.length} workspace(s) match prefix "${prefix}"`);
    for (const w of matched) {
      await deleteWorkspaceWithMocks(apiKey, w.id, results, mocks);
    }
  } else if (!args["monitor-id"]) {
    console.error("provide --workspace-id=<id> (targeted) or --name-prefix=<prefix> (sweep)");
    process.exit(2);
  }

  const errored = results.filter((r) => r.status === "error").length;
  const deleted = results.filter((r) => r.status === "deleted").length;
  console.log(`teardown summary: ${deleted} deleted, ${errored} errored`);
  // Best-effort: never fail the always() CI step on a teardown hiccup unless asked.
  if (errored > 0 && args.strict) process.exit(1);
}

main().catch((err) => {
  console.error(`teardown failed: ${err?.message ?? err}`);
  process.exit(1);
});
