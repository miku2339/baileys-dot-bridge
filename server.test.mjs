import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { createApp } from "./server.mjs";

const ADMIN_TOKEN = "owner-test-token-which-is-long";
const PUBLIC_URL = "http://localhost:4391";
const RESOURCE_URL = `${PUBLIC_URL}/mcp`;
const REDIRECT_URI = "http://localhost/callback";

test("startup executes through the current release symlink", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "baileys-dot-entry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(directory, "server.mjs");
  await symlink(new URL("./server.mjs", import.meta.url), entry);
  const result = spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /startup failed/);
  assert.equal(result.stdout, "");
});

function mockBridge() {
  const calls = [];
  const pendingCalls = [];
  return {
    calls,
    pendingCalls,
    getStatus: () => ({ status: "disconnected", account: null, paired: false }),
    getQr: () => null,
    listChats: async ({ limit }) => [{ id: "chat@s.whatsapp.net", limit }],
    getMessages: async ({ chatId, limit, before }) => [{ chatId, limit, before }],
    getPendingReplies: async (args) => {
      pendingCalls.push(args);
      return [{ id: "incoming-1", chatId: "12345@g.us", senderRole: "untrusted", fromMe: false, groupAllowed: true, mentionsBot: true }];
    },
    sendText: async (args) => { calls.push(args); return "message-1"; },
  };
}

function mockEvents() {
  const calls = [];
  return {
    calls,
    list: (params) => {
      calls.push({ method: "list", params });
      return { events: [{ name: "whatsapp.message_received" }] };
    },
    subscribe: async (params, principal) => {
      calls.push({ method: "subscribe", params, principal });
      return { id: "subscription-1", refreshBefore: new Date(Date.now() + 60_000).toISOString(), cursor: null, truncated: false };
    },
    unsubscribe: async (params, principal) => {
      calls.push({ method: "unsubscribe", params, principal });
      return {};
    },
  };
}

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "baileys-dot-test-"));
  const bridge = mockBridge();
  const events = mockEvents();
  const server = await createApp({
    bridge,
    events,
    config: {
      publicUrl: PUBLIC_URL,
      dataDir,
      adminToken: ADMIN_TOKEN,
      allowInsecureHttp: true,
      allowLocalRedirects: true,
    },
    logger: {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { base, bridge, events, dataDir };
}

async function register(base, scopes = "whatsapp.read") {
  const registration = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = "v".repeat(64);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    scope: scopes,
    state: "test-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE_URL,
  });
  const consent = await fetch(authorize);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  const approval = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, admin_token: ADMIN_TOKEN }),
  });
  assert.equal(approval.status, 303);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), "test-state");
  assert.equal(callback.searchParams.get("iss"), PUBLIC_URL);
  return { clientId: client.client_id, code: callback.searchParams.get("code"), verifier };
}

async function exchange(base, grant, overrides = {}) {
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: grant.clientId,
      code: grant.code,
      redirect_uri: REDIRECT_URI,
      code_verifier: grant.verifier,
      resource: RESOURCE_URL,
      ...overrides,
    }),
  });
}

async function rpc(base, token, method, params, id = 1) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
}

test("private MCP rejects unauthenticated requests with OAuth discovery challenge", async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /oauth-protected-resource/);
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, RESOURCE_URL);
  assert.deepEqual(metadata.authorization_servers, [PUBLIC_URL]);
  assert.deepEqual(metadata.scopes_supported, ["whatsapp.read", "whatsapp.send", "events"]);
});

test("OAuth consent CSP permits only its registered ChatGPT callback origin", async (t) => {
  const { base } = await fixture(t);
  const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
  const registration = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: "none" }),
  });
  const client = await registration.json();
  const verifier = "c".repeat(64);
  const authorize = new URL(`${base}/oauth/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: callback,
    scope: "whatsapp.read",
    state: "csp-test",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: RESOURCE_URL,
  });
  const consent = await fetch(authorize);
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get("content-security-policy"), /form-action 'self' https:\/\/chatgpt\.com;/);

  const admin = await fetch(`${base}/admin`);
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get("content-security-policy"), /form-action 'self';/);
  assert.doesNotMatch(admin.headers.get("content-security-policy"), /chatgpt\.com/);
});

test("OAuth requires PKCE, exact redirect and one-use codes, then rotates refresh tokens", async (t) => {
  const { base, dataDir } = await fixture(t);
  const grant = await register(base, "whatsapp.read");

  const wrongRedirect = await exchange(base, grant, { redirect_uri: "http://localhost/wrong" });
  assert.equal(wrongRedirect.status, 400);
  assert.equal((await wrongRedirect.json()).error, "invalid_grant");

  const exchanged = await exchange(base, grant);
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const replay = await exchange(base, grant);
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");

  const refreshed = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: grant.clientId,
      refresh_token: tokens.refresh_token,
      resource: RESOURCE_URL,
    }),
  });
  assert.equal(refreshed.status, 200);
  const rotated = await refreshed.json();
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);

  const oldRefresh = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: grant.clientId,
      refresh_token: tokens.refresh_token,
      resource: RESOURCE_URL,
    }),
  });
  assert.equal(oldRefresh.status, 400);
  assert.equal((await oldRefresh.json()).error, "invalid_grant");

  const statePath = join(dataDir, "auth-state.json");
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  const persisted = await readFile(statePath, "utf8");
  assert.equal(persisted.includes(tokens.access_token), false);
  assert.equal(persisted.includes(tokens.refresh_token), false);
});

test("tool scopes and mandatory idempotency arguments are enforced", async (t) => {
  const { base, bridge } = await fixture(t);
  const readGrant = await register(base, "whatsapp.read");
  const readTokens = await (await exchange(base, readGrant)).json();
  const denied = await rpc(base, readTokens.access_token, "tools/call", {
    name: "whatsapp_send_text",
    arguments: { chatId: "12345@s.whatsapp.net", text: "hello", idempotencyKey: "request-1" },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate"), /scope="whatsapp\.send"/);
  assert.equal(bridge.calls.length, 0);

  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  const missingKey = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_send_text",
    arguments: { chatId: "12345@s.whatsapp.net", text: "hello" },
  });
  assert.equal(missingKey.status, 200);
  assert.equal((await missingKey.json()).error.code, -32602);
  assert.equal(bridge.calls.length, 0);

  const sent = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_send_text",
    arguments: { chatId: "12345@s.whatsapp.net", text: "hello", idempotencyKey: "request-1" },
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).result.structuredContent.messageId, "message-1");
  assert.equal(bridge.calls.length, 1);
});

test("pending group replies validate parameters, require read scope, and dispatch bounded queries", async (t) => {
  const { base, bridge } = await fixture(t);
  const readGrant = await register(base, "whatsapp.read");
  const readTokens = await (await exchange(base, readGrant)).json();

  const invalidScope = await rpc(base, readTokens.access_token, "tools/call", {
    name: "whatsapp_get_pending_replies",
    arguments: { scope: "private", after: 1 },
  });
  assert.equal(invalidScope.status, 200);
  assert.equal((await invalidScope.json()).error.code, -32602);
  assert.equal(bridge.pendingCalls.length, 0);

  const invalidAfter = await rpc(base, readTokens.access_token, "tools/call", {
    name: "whatsapp_get_pending_replies",
    arguments: { scope: "groups", after: 0, limit: 21 },
  });
  assert.equal(invalidAfter.status, 200);
  assert.equal((await invalidAfter.json()).error.code, -32602);
  assert.equal(bridge.pendingCalls.length, 0);

  const pending = await rpc(base, readTokens.access_token, "tools/call", {
    name: "whatsapp_get_pending_replies",
    arguments: { scope: "groups", after: 1_700_000_000_000 },
  });
  assert.equal(pending.status, 200);
  const pendingBody = await pending.json();
  assert.equal(pendingBody.result.structuredContent[0].id, "incoming-1");
  assert.deepEqual(bridge.pendingCalls, [{ scope: "groups", after: 1_700_000_000_000, limit: 20 }]);

  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  const denied = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_get_pending_replies",
    arguments: { scope: "groups", after: 1 },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate"), /scope="whatsapp\.read"/);
  assert.equal(bridge.pendingCalls.length, 1);
});

test("event methods use WhatsApp read scope and preserve one authenticated principal", async (t) => {
  const { base, events } = await fixture(t);
  const readGrant = await register(base, "whatsapp.read");
  const readTokens = await (await exchange(base, readGrant)).json();

  const listed = await rpc(base, readTokens.access_token, "events/list", { cursor: null });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).result.events[0].name, "whatsapp.message_received");

  const subscribeParams = {
    name: "whatsapp.message_received",
    arguments: { ownerGroups: true },
    delivery: { mode: "webhook", url: "https://hooks.example.test/events", secret: "fixture-secret" },
    cursor: null,
  };
  const subscribed = await rpc(base, readTokens.access_token, "events/subscribe", subscribeParams);
  assert.equal(subscribed.status, 200);
  assert.equal((await subscribed.json()).result.id, "subscription-1");

  const unsubscribeParams = { id: "subscription-1" };
  const unsubscribed = await rpc(base, readTokens.access_token, "events/unsubscribe", unsubscribeParams);
  assert.equal(unsubscribed.status, 200);
  assert.deepEqual((await unsubscribed.json()).result, {});

  assert.deepEqual(events.calls.map(({ method, params }) => ({ method, params })), [
    { method: "list", params: { cursor: null } },
    { method: "subscribe", params: subscribeParams },
    { method: "unsubscribe", params: unsubscribeParams },
  ]);
  assert.equal(typeof events.calls[1].principal, "string");
  assert.equal(events.calls[1].principal, events.calls[2].principal);

  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  for (const [method, params] of [
    ["events/list", {}],
    ["events/subscribe", subscribeParams],
    ["events/unsubscribe", unsubscribeParams],
  ]) {
    const denied = await rpc(base, sendTokens.access_token, method, params);
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get("www-authenticate"), /scope="whatsapp\.read"/);
    assert.equal((await denied.json()).error.message, "Insufficient scope");
  }
  assert.equal(events.calls.length, 3);
});

test("admin session is Secure HttpOnly and operations require single-use CSRF", async (t) => {
  const { base } = await fixture(t);
  const login = await fetch(`${base}/admin/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ admin_token: ADMIN_TOKEN }),
  });
  assert.equal(login.status, 303);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(";", 1)[0];

  const admin = await fetch(`${base}/admin`, { headers: { cookie } });
  const html = await admin.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);

  const rejected = await fetch(`${base}/admin/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: "wrong-csrf" }),
  });
  assert.equal(rejected.status, 403);

  const logout = await fetch(`${base}/admin/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(logout.status, 303);

  const replay = await fetch(`${base}/admin/logout`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(replay.status, 401);
});
