import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventSubscriptions, __test } from "./events.mjs";

const CHAT_A = "85261234567@s.whatsapp.net";
const CHAT_B = "120363012345678901@g.us";
const OWNER_LID = "85260000001@lid";
const SECRET_KEY = Buffer.alloc(32, 251);
const SECRET = `whsec_${SECRET_KEY.toString("base64")}`;

async function fixture(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-events-"));
  const manager = new EventSubscriptions({
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    logger: { error() {} },
    ...options,
  });
  return {
    dataDir,
    manager,
    async cleanup() {
      await manager.stop().catch(() => {});
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

function subscription(chatIds, url = "https://hooks.example.test/events") {
  return {
    name: "whatsapp.message_received",
    arguments: { chatIds },
    delivery: { mode: "webhook", url, secret: SECRET },
    cursor: null,
  };
}

function ownerGroupSubscription(url = "https://hooks.example.test/events") {
  return {
    name: "whatsapp.message_received",
    arguments: { ownerGroups: true },
    delivery: { mode: "webhook", url, secret: SECRET },
    cursor: null,
  };
}

function echoVerification(request) {
  const body = JSON.parse(request.body);
  if (body.type === "verification") return { status: 200, body: JSON.stringify({ challenge: body.challenge }) };
  return { status: 204, body: "" };
}

function message(overrides = {}) {
  return {
    id: "wamid-1",
    chatId: CHAT_A,
    senderId: "85269876543@s.whatsapp.net",
    text: "hello",
    timestamp: "2026-10-16T01:00:00.000Z",
    fromMe: false,
    type: "notify",
    pushName: "Sender",
    ...overrides,
  };
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}

test("lists one webhook event with a required exact-chat allowlist", async () => {
  const context = await fixture();
  try {
    const result = context.manager.list();
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].name, "whatsapp.message_received");
    assert.deepEqual(result.events[0].delivery, ["webhook"]);
    assert.equal(result.events[0].inputSchema.required, undefined);
    assert.deepEqual(result.events[0].inputSchema.anyOf, [
      { required: ["chatIds"] },
      { required: ["ownerGroups"], properties: { ownerGroups: { const: true } } },
    ]);
    assert.equal(result.events[0].inputSchema.properties.chatIds.maxItems, 20);
    assert.equal(result.events[0].inputSchema.properties.ownerGroups.type, "boolean");
    assert.deepEqual(result.events[0].payloadSchema.properties.senderRole.enum, ["owner", "untrusted"]);
    assert.equal(result.events[0].payloadSchema.required.includes("senderRole"), true);
    assert.equal(result.events[0].payloadSchema.required.includes("groupAllowed"), true);
    assert.equal(result.events[0].payloadSchema.required.includes("mentionsBot"), true);
    assert.equal(result.events[0].payloadSchema.required.includes("repliesToBot"), true);
    assert.equal(result.events[0].payloadSchema.required.includes("mentionsAll"), true);
    assert.equal(result.events[0].payloadSchema.required.includes("replyAllowed"), true);
    assert.equal(result.events[0].payloadSchema.required.includes("mediaType"), true);
    assert.equal(result.events[0].payloadSchema.required.includes("media"), true);
  } finally {
    await context.cleanup();
  }
});

test("rejects literal and DNS-resolved private, reserved, IPv6 and mapped callback addresses", async () => {
  const blocked = [
    "https://127.0.0.1/hook",
    "https://10.0.0.1/hook",
    "https://169.254.169.254/hook",
    "https://192.0.2.1/hook",
    "https://[::1]/hook",
    "https://[fc00::1]/hook",
    "https://[fe80::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
  ];
  for (const url of blocked) {
    const context = await fixture({ transport: async () => assert.fail("transport must not run") });
    try {
      await assert.rejects(context.manager.subscribe(subscription([CHAT_A], url), "owner"), (error) => {
        assert.equal(error.code, -32015);
        return true;
      });
    } finally {
      await context.cleanup();
    }
  }

  const context = await fixture({
    dnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "::ffff:10.0.0.8", family: 6 },
    ],
    transport: async () => assert.fail("transport must not run when any DNS answer is unsafe"),
  });
  try {
    await assert.rejects(context.manager.subscribe(subscription([CHAT_A]), "owner"), { code: -32015 });
  } finally {
    await context.cleanup();
  }
});

test("activates only after an exact callback challenge echo", async () => {
  const context = await fixture({
    transport: async () => ({ status: 200, body: JSON.stringify({ challenge: "wrong" }) }),
  });
  try {
    await context.manager.start();
    await assert.rejects(context.manager.subscribe(subscription([CHAT_A]), "owner"), (error) => {
      assert.equal(error.code, -32015);
      assert.equal(error.data.reason, "challenge_failed");
      return true;
    });
    assert.equal(context.manager.stats().subscriptions, 0);
  } finally {
    await context.cleanup();
  }
});

test("resolves every request and pins the validated address while preserving the TLS hostname", async () => {
  const lookups = ["93.184.216.34", "8.8.8.8"];
  const requests = [];
  const context = await fixture({
    dnsLookup: async () => [{ address: lookups.shift(), family: 4 }],
    transport: async (request) => {
      requests.push(request);
      return echoVerification(request);
    },
  });
  try {
    await context.manager.start();
    await context.manager.subscribe(subscription([CHAT_A]), "owner");
    await context.manager.publish(message());
    await waitUntil(() => requests.length === 2);
    assert.equal(requests[0].address, "93.184.216.34");
    assert.equal(requests[1].address, "8.8.8.8");
    assert.equal(requests[1].servername, "hooks.example.test");
  } finally {
    await context.cleanup();
  }
});

test("signs exact body bytes with Standard Webhooks headers", async () => {
  const requests = [];
  const context = await fixture({
    now: () => 1_800_000_000_000,
    transport: async (request) => {
      requests.push(request);
      return echoVerification(request);
    },
  });
  try {
    await context.manager.start();
    const created = await context.manager.subscribe(subscription([CHAT_A]), "owner");
    await context.manager.publish(message());
    await waitUntil(() => requests.length === 2);
    const delivery = requests[1];
    const parsed = JSON.parse(delivery.body);
    const timestamp = delivery.headers["webhook-timestamp"];
    const expected = createHmac("sha256", SECRET_KEY)
      .update(`${parsed.eventId}.${timestamp}.${delivery.body}`)
      .digest("base64");
    assert.equal(delivery.headers["webhook-id"], parsed.eventId);
    assert.equal(delivery.headers["webhook-signature"], `v1,${expected}`);
    assert.equal(delivery.headers["X-MCP-Subscription-Id"], created.id);
    assert.equal(delivery.headers["Content-Length"], String(Buffer.byteLength(delivery.body)));
  } finally {
    await context.cleanup();
  }
});

test("subscription identity is canonical and refresh updates one stored subscription", async () => {
  const context = await fixture({ transport: echoVerification });
  try {
    await context.manager.start();
    const first = await context.manager.subscribe(subscription([CHAT_B, CHAT_A]), "owner");
    const secondRequest = subscription([CHAT_A, CHAT_B]);
    secondRequest.arguments.ownerGroups = false;
    const second = await context.manager.subscribe(secondRequest, "owner");
    assert.equal(first.id, second.id);
    assert.equal(context.manager.stats().subscriptions, 1);
    await context.manager.unsubscribe({
      name: "whatsapp.message_received",
      arguments: { chatIds: [CHAT_B, CHAT_A] },
      delivery: { mode: "webhook", url: "https://hooks.example.test/events" },
    }, "other-owner");
    assert.equal(context.manager.stats().subscriptions, 1);
    await context.manager.unsubscribe({
      name: "whatsapp.message_received",
      arguments: { chatIds: [CHAT_A, CHAT_B] },
      delivery: { mode: "webhook", url: "https://hooks.example.test/events" },
    }, "owner");
    assert.equal(context.manager.stats().subscriptions, 0);
  } finally {
    await context.cleanup();
  }
});

test("grants finite TTLs with a 24-hour default and seven-day cap", async () => {
  const now = 1_800_000_000_000;
  const context = await fixture({ now: () => now, transport: echoVerification });
  try {
    await context.manager.start();
    const base = subscription([CHAT_A]);
    const defaultTtl = await context.manager.subscribe(base, "owner");
    const unlimitedRequest = await context.manager.subscribe({ ...base, ttlMs: null }, "owner");
    const capped = await context.manager.subscribe({ ...base, ttlMs: 8 * 24 * 60 * 60 * 1000 }, "owner");
    const minimum = await context.manager.subscribe({ ...base, ttlMs: 1_000 }, "owner");
    assert.equal(Date.parse(defaultTtl.refreshBefore) - now, 24 * 60 * 60 * 1000);
    assert.equal(Date.parse(unlimitedRequest.refreshBefore) - now, 7 * 24 * 60 * 60 * 1000);
    assert.equal(Date.parse(capped.refreshBefore) - now, 7 * 24 * 60 * 60 * 1000);
    assert.equal(Date.parse(minimum.refreshBefore) - now, 60 * 1000);
  } finally {
    await context.cleanup();
  }
});

test("isolates chat filters and filters own, status and history messages before persistence", async () => {
  const deliveries = [];
  const context = await fixture({
    transport: async (request) => {
      const body = JSON.parse(request.body);
      if (body.type === "verification") return echoVerification(request);
      deliveries.push({ subscriptionId: request.headers["X-MCP-Subscription-Id"], body });
      return { status: 204, body: "" };
    },
  });
  try {
    await context.manager.start();
    const a = await context.manager.subscribe(subscription([CHAT_A], "https://a.example.test/hook"), "owner");
    await context.manager.subscribe(subscription([CHAT_B], "https://b.example.test/hook"), "owner");
    await context.manager.publish(message());
    await waitUntil(() => deliveries.length === 1);
    assert.equal(deliveries[0].subscriptionId, a.id);
    assert.equal(deliveries[0].body.data.chatId, CHAT_A);
    assert.equal(deliveries[0].body.data.mediaType, null);
    assert.equal(deliveries[0].body.data.media, null);
    assert.equal(deliveries[0].body.data.groupAllowed, false);
    assert.equal(deliveries[0].body.data.mentionsBot, false);
    assert.equal(deliveries[0].body.data.repliesToBot, false);
    assert.equal(deliveries[0].body.data.mentionsAll, false);
    assert.equal(deliveries[0].body.data.replyAllowed, false);
    assert.deepEqual(await context.manager.publish(message({ id: "own", fromMe: true })), { queued: 0, dropped: 0, filtered: true });
    assert.deepEqual(await context.manager.publish(message({ id: "history", type: "history" })), { queued: 0, dropped: 0, filtered: true });
    assert.deepEqual(await context.manager.publish(message({ id: "status", chatId: "status@broadcast" })), { queued: 0, dropped: 0, filtered: true });
    assert.equal(deliveries.length, 1);
  } finally {
    await context.cleanup();
  }
});

test("requires an explicit event scope", async () => {
  const context = await fixture({ transport: echoVerification });
  try {
    await assert.rejects(context.manager.subscribe({
      ...ownerGroupSubscription(),
      arguments: {},
    }, "owner"), { code: -32602 });
    await assert.rejects(context.manager.subscribe({
      ...ownerGroupSubscription(),
      arguments: { ownerGroups: false },
    }, "owner"), { code: -32602 });
    await assert.rejects(context.manager.subscribe({
      ...ownerGroupSubscription(),
      arguments: { chatIds: [] },
    }, "owner"), { code: -32602 });
  } finally {
    await context.cleanup();
  }
});

test("restores owner-group subscriptions and matches only trusted mentions or bot replies", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-events-owner-groups-"));
  const first = new EventSubscriptions({
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: echoVerification,
    logger: { error() {} },
  });
  await first.start();
  await first.subscribe(ownerGroupSubscription(), "owner");
  await first.stop();

  const deliveries = [];
  const second = new EventSubscriptions({
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      deliveries.push(JSON.parse(request.body));
      return { status: 204, body: "" };
    },
    logger: { error() {} },
  });
  try {
    await second.start();
    assert.equal(second.stats().subscriptions, 1);
    assert.deepEqual(await second.publish(message({
      id: "allowed-mention",
      chatId: CHAT_B,
      senderId: OWNER_LID,
      senderRole: "untrusted",
      groupAllowed: true,
      mentionsBot: true,
      replyAllowed: true,
    })), { queued: 1, dropped: 0 });
    assert.deepEqual(await second.publish(message({
      id: "allowed-reply",
      chatId: CHAT_B,
      senderId: OWNER_LID,
      senderRole: "untrusted",
      groupAllowed: true,
      mentionsBot: false,
      repliesToBot: true,
      replyAllowed: true,
    })), { queued: 1, dropped: 0 });
    assert.deepEqual(await second.publish(message({
      id: "group-not-allowed",
      chatId: CHAT_B,
      senderId: OWNER_LID,
      groupAllowed: false,
      mentionsBot: true,
      replyAllowed: false,
    })), { queued: 0, dropped: 0 });
    assert.deepEqual(await second.publish(message({
      id: "bot-not-mentioned",
      chatId: CHAT_B,
      senderId: OWNER_LID,
      groupAllowed: true,
      mentionsBot: false,
      repliesToBot: false,
      replyAllowed: false,
    })), { queued: 0, dropped: 0 });
    assert.deepEqual(await second.publish(message({
      id: "mention-all-not-allowed",
      chatId: CHAT_B,
      senderId: OWNER_LID,
      groupAllowed: true,
      mentionsBot: true,
      mentionsAll: true,
      replyAllowed: false,
    })), { queued: 0, dropped: 0 });
    assert.deepEqual(await second.publish(message({
      id: "missing-participant",
      chatId: CHAT_B,
      senderId: null,
      groupAllowed: true,
      mentionsBot: true,
      replyAllowed: true,
    })), { queued: 0, dropped: 0 });
    assert.deepEqual(await second.publish(message({
      id: "private-cannot-use-group-scope",
      chatId: OWNER_LID,
      senderId: OWNER_LID,
      groupAllowed: true,
      mentionsBot: true,
      replyAllowed: true,
    })), { queued: 0, dropped: 0 });
    await waitUntil(() => deliveries.length === 2);
    assert.deepEqual(deliveries.map(({ data }) => data.id), ["allowed-mention", "allowed-reply"]);
    assert.equal(deliveries[0].data.chatId, CHAT_B);
    assert.equal(deliveries[0].data.senderRole, "untrusted");
    assert.equal(deliveries[0].data.groupAllowed, true);
    assert.equal(deliveries[0].data.mentionsBot, true);
    assert.equal(deliveries[0].data.repliesToBot, false);
    assert.equal(deliveries[0].data.replyAllowed, true);
    assert.equal(deliveries[1].data.mentionsBot, false);
    assert.equal(deliveries[1].data.repliesToBot, true);
    assert.equal(deliveries[1].data.replyAllowed, true);
  } finally {
    await second.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("normalizes the bridge's millisecond and media-only message shape", async () => {
  const legacyGroup = "1234567890-1234567890@g.us";
  let delivered;
  const context = await fixture({
    transport: async (request) => {
      const body = JSON.parse(request.body);
      if (body.type === "verification") return echoVerification(request);
      delivered = body;
      return { status: 204, body: "" };
    },
  });
  try {
    await context.manager.start();
    await context.manager.subscribe(subscription([legacyGroup]), "owner");
    await context.manager.publish(message({
      id: "media-message",
      chatId: legacyGroup,
      senderId: null,
      text: null,
      timestamp: 1_800_000_000_123,
      direction: "incoming",
      mediaType: "image",
      media: { mimetype: "image/jpeg", fileName: null },
    }));
    await waitUntil(() => delivered !== undefined);
    assert.equal(delivered.data.timestamp, "2027-01-15T08:00:00.123Z");
    assert.equal(delivered.data.text, null);
    assert.equal(delivered.data.senderId, legacyGroup);
    assert.equal(delivered.data.mediaType, "image");
    assert.deepEqual(delivered.data.media, { mimetype: "image/jpeg", fileName: null });
  } finally {
    await context.cleanup();
  }
});

test("passes owner role only for bridge-verified direct LID messages and defaults to untrusted", async () => {
  const deliveries = [];
  const context = await fixture({
    transport: async (request) => {
      const body = JSON.parse(request.body);
      if (body.type === "verification") return echoVerification(request);
      deliveries.push(body.data);
      return { status: 204, body: "" };
    },
  });
  try {
    await context.manager.start();
    await context.manager.subscribe(subscription([OWNER_LID, CHAT_B]), "owner");
    await context.manager.publish(message({
      id: "verified-owner",
      chatId: OWNER_LID,
      senderId: OWNER_LID,
      senderRole: "owner",
    }));
    await context.manager.publish(message({
      id: "missing-role",
      chatId: OWNER_LID,
      senderId: OWNER_LID,
      pushName: "Owner",
    }));
    await context.manager.publish(message({
      id: "mismatched-sender",
      chatId: OWNER_LID,
      senderId: "85260000002@lid",
      senderRole: "owner",
    }));
    await context.manager.publish(message({
      id: "group-cannot-own",
      chatId: CHAT_B,
      senderId: OWNER_LID,
      senderRole: "owner",
    }));
    await waitUntil(() => deliveries.length === 4);
    assert.deepEqual(deliveries.map((item) => item.senderRole), ["owner", "untrusted", "untrusted", "untrusted"]);
  } finally {
    await context.cleanup();
  }
});

test("persists a pending queue across restart, retries with one event ID and fresh signatures", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-events-restart-"));
  let logicalNow = 1_800_000_000_000;
  const first = new EventSubscriptions({
    dataDir,
    now: () => logicalNow,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: echoVerification,
    logger: { error() {} },
  });
  await first.start();
  await first.subscribe(subscription([OWNER_LID]), "owner");
  await first.stop();
  await first.publish(message({
    chatId: OWNER_LID,
    senderId: OWNER_LID,
    senderRole: "owner",
  }));

  const statePath = path.join(dataDir, "events-state.json");
  const legacyState = JSON.parse(await fs.readFile(statePath, "utf8"));
  const originalEventId = legacyState.queue[0].event.eventId;
  delete legacyState.queue[0].event.data.senderRole;
  delete legacyState.queue[0].event.data.groupAllowed;
  delete legacyState.queue[0].event.data.mentionsBot;
  legacyState.queue[0].event.data.repliesToBot = "true";
  legacyState.queue[0].event.data.replyAllowed = "true";
  await fs.writeFile(statePath, `${JSON.stringify(legacyState)}\n`);

  const attempts = [];
  const second = new EventSubscriptions({
    dataDir,
    now: () => logicalNow,
    retryBaseMs: 0,
    dnsLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async (request) => {
      attempts.push(request);
      logicalNow += 1_000;
      return attempts.length === 1 ? { status: 503, body: "" } : { status: 204, body: "" };
    },
    logger: { error() {} },
  });
  try {
    await second.start();
    await waitUntil(() => attempts.length === 2);
    await waitUntil(() => second.stats().pendingDeliveries === 0);
    assert.equal(attempts[0].headers["webhook-id"], attempts[1].headers["webhook-id"]);
    assert.notEqual(attempts[0].headers["webhook-timestamp"], attempts[1].headers["webhook-timestamp"]);
    assert.notEqual(attempts[0].headers["webhook-signature"], attempts[1].headers["webhook-signature"]);
    const restored = JSON.parse(attempts[0].body);
    assert.equal(restored.eventId, originalEventId);
    assert.equal(restored.data.senderRole, "untrusted");
    assert.equal(restored.data.groupAllowed, false);
    assert.equal(restored.data.mentionsBot, false);
    assert.equal(restored.data.repliesToBot, false);
    assert.equal(restored.data.replyAllowed, false);
    assert.equal(second.stats().failedDeliveries, 0);
    const stateMode = (await fs.stat(statePath)).mode & 0o777;
    const directoryMode = (await fs.stat(dataDir)).mode & 0o777;
    assert.equal(stateMode, 0o600);
    assert.equal(directoryMode, 0o700);
  } finally {
    await second.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("restores one trusted group reply delivery and keeps its upstream duplicate suppressed", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-events-group-restart-"));
  const incoming = message({
    id: "group-restart",
    chatId: CHAT_B,
    senderId: OWNER_LID,
    senderRole: "owner",
    groupAllowed: true,
    mentionsBot: false,
    repliesToBot: true,
    replyAllowed: true,
  });
  const first = new EventSubscriptions({
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: echoVerification,
    logger: { error() {} },
  });
  await first.start();
  await first.subscribe(ownerGroupSubscription(), "owner");
  await first.stop();
  await first.publish(incoming);

  const deliveries = [];
  const second = new EventSubscriptions({
    dataDir,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async (request) => {
      deliveries.push(JSON.parse(request.body));
      return { status: 204, body: "" };
    },
    logger: { error() {} },
  });
  try {
    await second.start();
    await waitUntil(() => deliveries.length === 1);
    assert.equal(deliveries[0].data.groupAllowed, true);
    assert.equal(deliveries[0].data.mentionsBot, false);
    assert.equal(deliveries[0].data.repliesToBot, true);
    assert.equal(deliveries[0].data.replyAllowed, true);
    assert.equal(deliveries[0].data.senderRole, "untrusted");
    assert.deepEqual(await second.publish(incoming), { queued: 0, dropped: 0, duplicate: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(deliveries.length, 1);
  } finally {
    await second.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("IP classifier blocks special ranges and permits ordinary public addresses", () => {
  for (const address of ["0.0.0.0", "100.64.0.1", "198.18.0.1", "203.0.113.10", "::", "2001:2::1", "2001:db8::1", "3fff::1", "::ffff:192.168.1.1", "2002:0a00:0001::"]) {
    assert.equal(__test.isPublicIp(address), false, address);
  }
  for (const address of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(__test.isPublicIp(address), true, address);
  }
});
