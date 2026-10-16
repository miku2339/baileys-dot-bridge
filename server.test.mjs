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
  const imageCalls = [];
  const mediaCalls = [];
  const getMediaCalls = [];
  const groupInfoCalls = [];
  const pendingCalls = [];
  const bridge = {
    calls,
    imageCalls,
    mediaCalls,
    getMediaCalls,
    groupInfoCalls,
    pendingCalls,
    mediaResult: {
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimetype: "image/png",
      fileName: "incoming.png",
      mediaType: "image",
    },
    getStatus: () => ({ status: "disconnected", account: null, paired: false }),
    getQr: () => null,
    listChats: async ({ limit }) => [{ id: "chat@s.whatsapp.net", limit }],
    getMessages: async ({ chatId, limit, before }) => [{ chatId, limit, before }],
    getPendingReplies: async (args) => {
      pendingCalls.push(args);
      return [{
        id: "incoming-1",
        chatId: "12345@g.us",
        senderRole: "untrusted",
        fromMe: false,
        groupAllowed: true,
        mentionsBot: true,
        repliesToBot: false,
        mentionsAll: false,
        replyAllowed: true,
      }];
    },
    sendText: async (args) => { calls.push(args); return "message-1"; },
    sendImage: async (args) => { imageCalls.push(args); return "image-message-1"; },
    sendMedia: async (args) => { mediaCalls.push(args); return "media-message-1"; },
    getMedia: async (args) => { getMediaCalls.push(args); return bridge.mediaResult; },
    getGroupInfo: async (args) => {
      groupInfoCalls.push(args);
      return {
        subject: "Class",
        description: "Updates",
        announcementOnly: false,
        ownerPresent: true,
        botPresent: true,
        members: ["85260000000@s.whatsapp.net"],
      };
    },
  };
  return bridge;
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

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "baileys-dot-test-"));
  const bridge = options.bridge || mockBridge();
  const events = mockEvents();
  const server = await createApp({
    bridge,
    events,
    mediaStore: options.mediaStore,
    mediaDownloader: options.mediaDownloader,
    config: {
      publicUrl: PUBLIC_URL,
      dataDir,
      adminToken: ADMIN_TOKEN,
      allowInsecureHttp: true,
      allowLocalRedirects: true,
      ...(options.now ? { now: options.now } : {}),
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

test("image tool exposes bounded arguments, requires send scope, and dispatches exact values", async (t) => {
  const { base, bridge } = await fixture(t);
  const readGrant = await register(base, "whatsapp.read");
  const readTokens = await (await exchange(base, readGrant)).json();
  const denied = await rpc(base, readTokens.access_token, "tools/call", {
    name: "whatsapp_send_image",
    arguments: { chatId: "12345@s.whatsapp.net", imageBase64: "iVBORw0KGgo=", idempotencyKey: "image-request-1" },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate"), /scope="whatsapp\.send"/);
  assert.equal(bridge.imageCalls.length, 0);

  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  const listed = await rpc(base, sendTokens.access_token, "tools/list");
  const tools = (await listed.json()).result.tools;
  const imageTool = tools.find((tool) => tool.name === "whatsapp_send_image");
  assert.equal(imageTool.inputSchema.properties.imageBase64.maxLength, Math.ceil(5 * 1024 * 1024 / 3) * 4);
  assert.equal(imageTool.inputSchema.properties.caption.default, "");
  assert.deepEqual(imageTool.inputSchema.required, ["chatId", "idempotencyKey"]);
  assert.deepEqual(imageTool._meta, { "openai/fileParams": ["file"] });
  assert.deepEqual(imageTool.securitySchemes[0].scopes, ["whatsapp.send"]);
  assert.deepEqual(imageTool.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true });

  for (const argumentsValue of [
    { chatId: "12345@s.whatsapp.net", imageBase64: "iVBORw0KGgo=" },
    { chatId: "12345@s.whatsapp.net", imageBase64: "iVBORw0KGgo=", caption: "x".repeat(2001), idempotencyKey: "image-request-2" },
    { chatId: "12345@s.whatsapp.net", imageBase64: "iVBORw0KGgo=", idempotencyKey: "image-request-3", path: "/tmp/image.png" },
    { chatId: "12345@s.whatsapp.net", idempotencyKey: "image-request-5" },
    {
      chatId: "12345@s.whatsapp.net",
      imageBase64: "iVBORw0KGgo=",
      file: { download_url: "https://files.example.test/image.png", file_id: "file_image" },
      idempotencyKey: "image-request-6",
    },
  ]) {
    const invalid = await rpc(base, sendTokens.access_token, "tools/call", {
      name: "whatsapp_send_image",
      arguments: argumentsValue,
    });
    assert.equal(invalid.status, 200);
    assert.equal((await invalid.json()).error.code, -32602);
  }
  assert.equal(bridge.imageCalls.length, 0);

  const sent = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_send_image",
    arguments: {
      chatId: "12345@s.whatsapp.net",
      imageBase64: "iVBORw0KGgo=",
      caption: "photo",
      idempotencyKey: "image-request-4",
    },
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).result.structuredContent.messageId, "image-message-1");
  assert.deepEqual(bridge.imageCalls, [{
    chatId: "12345@s.whatsapp.net",
    imageBase64: "iVBORw0KGgo=",
    caption: "photo",
    idempotencyKey: "image-request-4",
  }]);
});

test("file-param image, video and document tools expose exact schemas and dispatch downloads", async (t) => {
  const downloads = [];
  const mediaDownloader = async (file, options) => {
    downloads.push({ file, options });
    const data = file.file_id === "file_image"
      ? Buffer.from("image-data")
      : file.file_id === "file_video"
        ? Buffer.from("....ftypisom")
        : Buffer.from(`${file.file_id}-data`);
    return {
      data,
      mimetype: file.mime_type || "application/octet-stream",
      fileName: file.file_name || "attachment.bin",
    };
  };
  const { base, bridge } = await fixture(t, { mediaDownloader });
  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  const listed = await rpc(base, sendTokens.access_token, "tools/list");
  const tools = (await listed.json()).result.tools;
  for (const name of ["whatsapp_send_image", "whatsapp_send_video", "whatsapp_send_document"]) {
    const tool = tools.find((item) => item.name === name);
    assert.deepEqual(tool._meta, { "openai/fileParams": ["file"] });
    assert.deepEqual(Object.keys(tool.inputSchema.properties.file.properties), ["download_url", "file_id", "mime_type", "file_name"]);
    assert.deepEqual(tool.inputSchema.properties.file.required, ["download_url", "file_id"]);
    assert.equal(tool.inputSchema.properties.file.additionalProperties, false);
    assert.deepEqual(tool.securitySchemes[0].scopes, ["whatsapp.send"]);
  }

  const imageFile = {
    download_url: "https://files.example.test/image.png?signature=secret",
    file_id: "file_image",
    mime_type: "image/png",
    file_name: "image.png",
  };
  const image = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_send_image",
    arguments: { chatId: "12345@s.whatsapp.net", file: imageFile, caption: "image", idempotencyKey: "file-image-1" },
  });
  assert.equal(image.status, 200);
  assert.equal((await image.json()).result.structuredContent.messageId, "image-message-1");
  assert.equal(bridge.imageCalls[0].imageBase64, Buffer.from("image-data").toString("base64"));

  for (const [name, kind, id, mime] of [
    ["whatsapp_send_video", "video", "file_video", "application/octet-stream"],
    ["whatsapp_send_document", "document", "file_document", "application/pdf"],
  ]) {
    const response = await rpc(base, sendTokens.access_token, "tools/call", {
      name,
      arguments: {
        chatId: "12345@s.whatsapp.net",
        file: { download_url: `https://files.example.test/${id}`, file_id: id, mime_type: mime, file_name: `${id}.bin` },
        idempotencyKey: `${id}-request`,
      },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.structuredContent.messageId, "media-message-1");
    assert.equal(bridge.mediaCalls.at(-1).kind, kind);
    if (kind === "video") {
      assert.equal(bridge.mediaCalls.at(-1).data.toString("ascii", 4, 8), "ftyp");
      assert.equal(bridge.mediaCalls.at(-1).mimetype, "video/mp4");
    } else {
      assert.equal(bridge.mediaCalls.at(-1).data.toString(), `${id}-data`);
    }
  }
  assert.deepEqual(downloads.map(({ options }) => options.maximum), [5 * 1024 * 1024, 20 * 1024 * 1024, 20 * 1024 * 1024]);

  const extra = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_send_document",
    arguments: {
      chatId: "12345@s.whatsapp.net",
      file: { download_url: "https://files.example.test/document", file_id: "file_bad", path: "/tmp/private" },
      idempotencyKey: "file-extra-1",
    },
  });
  assert.equal((await extra.json()).error.code, -32602);
  assert.equal(downloads.length, 3);
});

test("get-media requires read scope and returns expiring image plus public attachment link", async (t) => {
  let now = 1_800_000_000_000;
  const { base, bridge, dataDir } = await fixture(t, { now: () => now });
  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  const denied = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_get_media",
    arguments: { chatId: "12345@s.whatsapp.net", messageId: "incoming-image" },
  });
  assert.equal(denied.status, 403);
  assert.equal(bridge.getMediaCalls.length, 0);

  const readGrant = await register(base, "whatsapp.read");
  const readTokens = await (await exchange(base, readGrant)).json();
  const listed = await rpc(base, readTokens.access_token, "tools/list");
  const tools = (await listed.json()).result.tools;
  assert.equal(tools.filter((tool) => tool.securitySchemes[0].scopes[0] === "whatsapp.read").length, 6);
  assert.equal(tools.filter((tool) => tool.securitySchemes[0].scopes[0] === "whatsapp.send").length, 4);
  const response = await rpc(base, readTokens.access_token, "tools/call", {
    name: "whatsapp_get_media",
    arguments: { chatId: "12345@s.whatsapp.net", messageId: "incoming-image" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.content[0].type, "image");
  assert.equal(body.result.content[0].mimeType, "image/png");
  assert.equal(body.result.content[1].type, "resource_link");
  assert.equal(body.result.structuredContent.size, 8);
  assert.equal(body.result.structuredContent.fileName, "incoming.png");
  assert.deepEqual(bridge.getMediaCalls, [{ chatId: "12345@s.whatsapp.net", messageId: "incoming-image" }]);

  const download = new URL(body.result.structuredContent.downloadUrl);
  const publicResponse = await fetch(`${base}${download.pathname}`, { headers: { cookie: "private=session" } });
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.equal(publicResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(publicResponse.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual(Buffer.from(await publicResponse.arrayBuffer()), bridge.mediaResult.data);
  assert.equal((await readFile(join(dataDir, "auth-state.json"), "utf8")).includes(download.pathname.split("/").pop()), false);

  for (const [mediaType, mimetype, fileName] of [
    ["video", "video/mp4", "incoming.mp4"],
    ["document", "application/pdf", "incoming.pdf"],
  ]) {
    bridge.mediaResult = {
      data: mediaType === "video" ? Buffer.from("....ftypisom") : Buffer.from(`${mediaType}-data`),
      mimetype,
      fileName,
      mediaType,
    };
    const linked = await rpc(base, readTokens.access_token, "tools/call", {
      name: "whatsapp_get_media",
      arguments: { chatId: "12345@s.whatsapp.net", messageId: `incoming-${mediaType}` },
    });
    const linkedBody = await linked.json();
    assert.deepEqual(linkedBody.result.content.map(({ type }) => type), ["resource_link"]);
    assert.equal(linkedBody.result.structuredContent.fileName, fileName);
  }

  now += 5 * 60 * 1000 + 1;
  const expired = await fetch(`${base}${download.pathname}`);
  assert.equal(expired.status, 404);
});

test("MCP accepts one 5 MiB image body after authentication and rejects oversized bodies", async (t) => {
  const { base, bridge } = await fixture(t);
  const image = Buffer.alloc(5 * 1024 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(image);
  const imageBase64 = image.toString("base64");
  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  const sent = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_send_image",
    arguments: { chatId: "12345@s.whatsapp.net", imageBase64, idempotencyKey: "image-request-large" },
  });
  assert.equal(sent.status, 200);
  assert.equal(bridge.imageCalls[0].imageBase64.length, Math.ceil(5 * 1024 * 1024 / 3) * 4);
  assert.equal(bridge.imageCalls[0].caption, "");

  const oversizedBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "whatsapp_send_image", arguments: { imageBase64: "A".repeat(imageBase64.length + 64 * 1024) } },
  });
  const unauthenticated = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversizedBody,
  });
  assert.equal(unauthenticated.status, 401);

  const oversized = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sendTokens.access_token}` },
    body: oversizedBody,
  });
  assert.equal(oversized.status, 413);
  assert.equal(bridge.imageCalls.length, 1);
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

test("group info uses read scope and returns only bounded group metadata", async (t) => {
  const { base, bridge } = await fixture(t);
  const sendGrant = await register(base, "whatsapp.send");
  const sendTokens = await (await exchange(base, sendGrant)).json();
  const denied = await rpc(base, sendTokens.access_token, "tools/call", {
    name: "whatsapp_get_group_info",
    arguments: { chatId: "120363012345678901@g.us" },
  });
  assert.equal(denied.status, 403);
  assert.equal(bridge.groupInfoCalls.length, 0);

  const readGrant = await register(base, "whatsapp.read");
  const readTokens = await (await exchange(base, readGrant)).json();
  const response = await rpc(base, readTokens.access_token, "tools/call", {
    name: "whatsapp_get_group_info",
    arguments: { chatId: "120363012345678901@g.us" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.structuredContent, {
    subject: "Class",
    description: "Updates",
    announcementOnly: false,
    ownerPresent: true,
    botPresent: true,
  });
  assert.deepEqual(bridge.groupInfoCalls, [{ chatId: "120363012345678901@g.us" }]);
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
