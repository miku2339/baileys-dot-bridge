import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { promises as fs } from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const EVENT_NAME = "whatsapp.message_received";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_QUEUE = 500;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 5;
const STATE_VERSION = 1;
const VERIFICATION_CACHE_MS = 5 * 60 * 1000;

export class EventsError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "EventsError";
    this.code = code;
    this.rpcCode = code;
    if (data !== undefined) this.data = data;
  }
}

export class EventSubscriptions {
  constructor({
    dataDir,
    logger = console,
    transport = defaultTransport,
    dnsLookup = defaultDnsLookup,
    now = Date.now,
    uuid = randomUUID,
    retryBaseMs = 1_000,
  } = {}) {
    if (typeof dataDir !== "string" || dataDir.length === 0) {
      throw new TypeError("dataDir is required");
    }
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, "events-state.json");
    this.logger = logger;
    this.transport = transport;
    this.dnsLookup = dnsLookup;
    this.now = now;
    this.uuid = uuid;
    this.retryBaseMs = retryBaseMs;
    this.subscriptions = new Map();
    this.queue = [];
    this.seen = new Map();
    this.health = {
      lostEvents: 0,
      failedDeliveries: 0,
      lastPersistenceError: null,
      lastDeliveryError: null,
    };
    this.started = false;
    this.stopping = false;
    this.processing = false;
    this.drainPromise = null;
    this.timer = null;
    this.persistChain = Promise.resolve();
  }

  list(params = {}) {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw invalidParams("events/list params must be an object");
    }
    if (params.cursor !== undefined && params.cursor !== null) {
      throw invalidParams("events/list does not have another page");
    }
    return {
      events: [
        {
          name: EVENT_NAME,
          description: "A new incoming WhatsApp message in a selected chat or a trusted owner group mention.",
          delivery: ["webhook"],
          inputSchema: {
            type: "object",
            properties: {
              chatIds: {
                type: "array",
                description: "Exact WhatsApp chat IDs to monitor.",
                minItems: 1,
                maxItems: 20,
                uniqueItems: true,
                items: {
                  type: "string",
                  pattern: "^(?:[1-9][0-9]{4,19}@(?:s\\.whatsapp\\.net|lid)|[1-9][0-9]{4,19}(?:-[1-9][0-9]{4,19})?@g\\.us)$",
                },
              },
              ownerGroups: {
                type: "boolean",
                description: "Monitor trusted owner groups only when the bot is explicitly mentioned.",
              },
            },
            anyOf: [
              { required: ["chatIds"] },
              { required: ["ownerGroups"], properties: { ownerGroups: { const: true } } },
            ],
            additionalProperties: false,
          },
          payloadSchema: {
            type: "object",
            properties: {
              id: { type: "string" },
              chatId: { type: "string" },
              senderId: { type: "string" },
              text: { type: "string" },
              timestamp: { type: "string", format: "date-time" },
              fromMe: { type: "boolean" },
              type: { type: "string" },
              senderRole: { type: "string", enum: ["owner", "untrusted"] },
              groupAllowed: { type: "boolean" },
              mentionsBot: { type: "boolean" },
              pushName: { type: "string" },
            },
            required: ["id", "chatId", "senderId", "text", "timestamp", "fromMe", "type", "senderRole", "groupAllowed", "mentionsBot"],
            additionalProperties: false,
          },
        },
      ],
    };
  }

  async subscribe(params, principal) {
    const owner = validatePrincipal(principal);
    const request = validateSubscriptionParams(params);
    const id = subscriptionId(owner, request);
    const now = this.now();
    const existing = this.subscriptions.get(id);
    const ttlMs = grantedTtl(params.ttlMs);
    const expiresAt = now + ttlMs;
    const candidate = {
      id,
      principal: owner,
      name: EVENT_NAME,
      arguments: request.arguments,
      url: request.url,
      secret: request.secret,
      expiresAt,
      active: false,
      verifiedAt: null,
    };

    const recentlyVerified = existing?.secret === candidate.secret &&
      Number.isFinite(existing.verifiedAt) && existing.verifiedAt + VERIFICATION_CACHE_MS > now;
    if (!recentlyVerified) await this.#verifyCallback(candidate);
    candidate.active = true;
    candidate.verifiedAt = recentlyVerified ? existing.verifiedAt : this.now();
    this.subscriptions.set(id, candidate);
    await this.#persist();

    return {
      id,
      refreshBefore: new Date(expiresAt).toISOString(),
      cursor: null,
      truncated: false,
    };
  }

  async unsubscribe(params, principal) {
    const owner = validatePrincipal(principal);
    const request = validateSubscriptionParams(params, { requireSecret: false });
    const id = subscriptionId(owner, request);
    const existing = this.subscriptions.get(id);
    if (existing && existing.principal === owner) {
      this.subscriptions.delete(id);
      this.queue = this.queue.filter((item) => item.subscriptionId !== id);
      await this.#persist();
      this.#schedule();
    }
    return {};
  }

  async publish(normalizedMessage) {
    const message = normalizeMessage(normalizedMessage);
    if (!message) return { queued: 0, dropped: 0, filtered: true };

    const eventId = upstreamEventId(message);
    if (this.seen.has(eventId)) return { queued: 0, dropped: 0, duplicate: true };

    const event = {
      eventId,
      name: EVENT_NAME,
      timestamp: message.timestamp,
      data: message,
      cursor: null,
    };
    const body = JSON.stringify(event);
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      throw invalidParams("Event payload exceeds 256 KiB");
    }

    const now = this.now();
    this.#removeExpired(now);
    this.#pruneSeen(now);
    this.seen.set(eventId, now);

    let queued = 0;
    let dropped = 0;
    for (const subscription of this.subscriptions.values()) {
      if (!subscription.active || subscription.expiresAt <= now) continue;
      if (!subscriptionMatchesMessage(subscription, message)) continue;
      if (this.queue.length >= MAX_QUEUE) {
        dropped += 1;
        this.health.lostEvents += 1;
        continue;
      }
      this.queue.push({
        id: `delivery_${this.uuid()}`,
        subscriptionId: subscription.id,
        event,
        attempts: 0,
        nextAttemptAt: now,
      });
      queued += 1;
    }

    if (dropped > 0) {
      this.logger.error?.({ dropped }, "MCP Events queue full; event delivery was dropped");
    }
    await this.#persist();
    this.#schedule();
    return { queued, dropped };
  }

  async start() {
    if (this.started) return;
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDir, 0o700);
    try {
      const raw = await fs.readFile(this.statePath, "utf8");
      const state = JSON.parse(raw);
      this.#loadState(state);
      await fs.chmod(this.statePath, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.health.lastPersistenceError = "load_failed";
        throw error;
      }
    }
    this.#removeExpired(this.now());
    this.#pruneSeen(this.now());
    this.started = true;
    this.stopping = false;
    await this.#persist();
    this.#schedule();
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.drainPromise) await this.drainPromise;
    await this.#persist();
    await this.persistChain;
  }

  stats() {
    const now = this.now();
    let activeSubscriptions = 0;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.active && subscription.expiresAt > now) activeSubscriptions += 1;
    }
    return {
      subscriptions: this.subscriptions.size,
      activeSubscriptions,
      pendingDeliveries: this.queue.length,
      lostEvents: this.health.lostEvents,
      failedDeliveries: this.health.failedDeliveries,
      lastPersistenceError: this.health.lastPersistenceError,
      lastDeliveryError: this.health.lastDeliveryError,
      healthy: this.health.lostEvents === 0 && this.health.lastPersistenceError === null,
    };
  }

  async #verifyCallback(subscription) {
    const challenge = randomBytes(32).toString("base64url");
    const webhookId = `verification_${this.uuid()}`;
    const body = JSON.stringify({ type: "verification", challenge });
    let response;
    try {
      response = await this.#send(subscription, webhookId, body);
    } catch (error) {
      throw callbackError(categorizeTransportError(error));
    }
    if (response.status < 200 || response.status >= 300) {
      throw callbackError(response.status >= 500 ? "http_5xx" : "http_4xx");
    }
    let echoed;
    try {
      echoed = JSON.parse(response.body ?? "").challenge;
    } catch {
      throw callbackError("challenge_failed");
    }
    if (!constantTimeEqual(challenge, echoed)) throw callbackError("challenge_failed");
  }

  async #send(subscription, webhookId, body) {
    const destination = await resolvePublicDestination(subscription.url, this.dnsLookup);
    const timestamp = String(Math.floor(this.now() / 1000));
    const signature = signWebhook(subscription.secret, webhookId, timestamp, body);
    return this.transport({
      url: subscription.url,
      address: destination.address,
      family: destination.family,
      servername: destination.hostname,
      timeoutMs: 10_000,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
        "X-MCP-Subscription-Id": subscription.id,
      },
      body,
    });
  }

  #schedule() {
    if (!this.started || this.stopping || this.processing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const deadlines = [
      ...this.queue.map((item) => item.nextAttemptAt),
      ...[...this.subscriptions.values()].map((subscription) => subscription.expiresAt),
    ];
    if (deadlines.length === 0) return;
    const next = Math.min(...deadlines);
    const delay = Math.max(0, next - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drainPromise = this.#drain()
        .catch((error) => this.logger.error?.({ errorName: error?.name }, "MCP Events queue processing failed"))
        .finally(() => {
          this.drainPromise = null;
        });
    }, delay);
    this.timer.unref?.();
  }

  async #drain() {
    if (this.processing || !this.started || this.stopping) return;
    this.processing = true;
    try {
      while (this.started && !this.stopping) {
        const now = this.now();
        if (this.#removeExpired(now)) await this.#persist();
        const index = this.queue.findIndex((item) => item.nextAttemptAt <= now);
        if (index === -1) break;
        const item = this.queue[index];
        const subscription = this.subscriptions.get(item.subscriptionId);
        if (!subscription || !subscription.active || subscription.expiresAt <= now) {
          this.queue.splice(index, 1);
          await this.#persist();
          continue;
        }

        const body = JSON.stringify(item.event);
        let result;
        let reason = "transport_error";
        try {
          result = await this.#send(subscription, item.event.eventId, body);
          reason = result.status >= 500 ? "http_5xx" : "http_4xx";
        } catch (error) {
          reason = categorizeTransportError(error);
        }

        const currentIndex = this.queue.findIndex((queued) => queued.id === item.id);
        if (currentIndex === -1) continue;
        if (result && result.status >= 200 && result.status < 300) {
          this.queue.splice(currentIndex, 1);
          this.health.lastDeliveryError = null;
        } else if (result && (result.status === 410 || result.status === 413)) {
          this.queue.splice(currentIndex, 1);
          this.health.failedDeliveries += 1;
          this.health.lastDeliveryError = `http_${result.status}`;
        } else {
          item.attempts += 1;
          if (item.attempts >= MAX_ATTEMPTS) {
            this.queue.splice(currentIndex, 1);
            this.health.failedDeliveries += 1;
          } else {
            item.nextAttemptAt = this.now() + this.retryBaseMs * 2 ** (item.attempts - 1);
          }
          this.health.lastDeliveryError = reason;
        }
        await this.#persist();
      }
    } finally {
      this.processing = false;
      this.#schedule();
    }
  }

  #removeExpired(now) {
    const expired = new Set();
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.expiresAt <= now) {
        this.subscriptions.delete(id);
        expired.add(id);
      }
    }
    if (expired.size > 0) {
      this.queue = this.queue.filter((item) => !expired.has(item.subscriptionId));
    }
    return expired.size > 0;
  }

  #pruneSeen(now) {
    const cutoff = now - MAX_TTL_MS;
    for (const [eventId, seenAt] of this.seen) {
      if (seenAt < cutoff) this.seen.delete(eventId);
    }
    if (this.seen.size > 2_000) {
      const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);
      for (const [eventId] of entries.slice(0, this.seen.size - 2_000)) this.seen.delete(eventId);
    }
  }

  #loadState(state) {
    if (!state || state.version !== STATE_VERSION || !Array.isArray(state.subscriptions) || !Array.isArray(state.queue)) {
      throw new Error("Invalid MCP Events state file");
    }
    this.subscriptions.clear();
    for (const subscription of state.subscriptions) {
      if (isStoredSubscription(subscription)) this.subscriptions.set(subscription.id, subscription);
    }
    this.queue = [];
    for (const item of state.queue) {
      if (!isStoredDelivery(item)) continue;
      const subscription = this.subscriptions.get(item.subscriptionId);
      if (!subscription) continue;
      const restored = normalizeStoredDelivery(item);
      if (!restored || !subscriptionMatchesMessage(subscription, restored.event.data)) continue;
      this.queue.push(restored);
      if (this.queue.length >= MAX_QUEUE) break;
    }
    this.seen = new Map(Array.isArray(state.seen) ? state.seen.filter(isSeenEntry) : []);
    this.health = {
      lostEvents: nonNegativeInteger(state.health?.lostEvents),
      failedDeliveries: nonNegativeInteger(state.health?.failedDeliveries),
      lastPersistenceError: null,
      lastDeliveryError: typeof state.health?.lastDeliveryError === "string" ? state.health.lastDeliveryError : null,
    };
  }

  async #persist() {
    const operation = this.persistChain.then(async () => {
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      await fs.chmod(this.dataDir, 0o700);
      const state = {
        version: STATE_VERSION,
        subscriptions: [...this.subscriptions.values()],
        queue: this.queue,
        seen: [...this.seen.entries()],
        health: {
          lostEvents: this.health.lostEvents,
          failedDeliveries: this.health.failedDeliveries,
          lastDeliveryError: this.health.lastDeliveryError,
        },
      };
      const temporaryPath = `${this.statePath}.${process.pid}.${this.uuid()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, this.statePath);
        await fs.chmod(this.statePath, 0o600);
        this.health.lastPersistenceError = null;
      } catch (error) {
        this.health.lastPersistenceError = "write_failed";
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.persistChain = operation.catch(() => {});
    return operation;
  }
}

function validatePrincipal(principal) {
  if (typeof principal !== "string" || principal.length === 0 || principal.length > 512) {
    throw new EventsError(-32024, "Forbidden");
  }
  return principal;
}

function validateSubscriptionParams(params, { requireSecret = true } = {}) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw invalidParams("Invalid subscription params");
  if (params.name !== EVENT_NAME) {
    throw new EventsError(-32023, "NotFound", { kind: "event" });
  }
  if (!params.delivery || params.delivery.mode !== "webhook") {
    throw new EventsError(-32026, "Unsupported", { feature: "deliveryMode", value: params.delivery?.mode });
  }
  const url = validateCallbackUrl(params.delivery.url);
  const secret = requireSecret ? validateSecret(params.delivery.secret) : null;
  const argumentsValue = validateArguments(params.arguments);
  if (params.cursor !== undefined && params.cursor !== null) throw invalidParams("Replay cursors are not supported");
  if (params.ttlMs !== undefined && params.ttlMs !== null && (!Number.isFinite(params.ttlMs) || params.ttlMs <= 0)) {
    throw invalidParams("ttlMs must be a positive finite number");
  }
  return { name: EVENT_NAME, arguments: argumentsValue, url, secret };
}

function validateArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["chatIds", "ownerGroups"].includes(key))) {
    throw invalidParams("arguments may contain only chatIds and ownerGroups");
  }
  if (value.ownerGroups !== undefined && typeof value.ownerGroups !== "boolean") {
    throw invalidParams("ownerGroups must be a boolean");
  }
  let chatIds;
  if (value.chatIds !== undefined) {
    if (!Array.isArray(value.chatIds) || value.chatIds.length === 0 || value.chatIds.length > 20) {
      throw invalidParams("chatIds must contain between 1 and 20 IDs");
    }
    chatIds = [...new Set(value.chatIds)];
    if (chatIds.length !== value.chatIds.length || chatIds.some((id) => !isWhatsAppChatId(id))) {
      throw invalidParams("chatIds must be unique, exact WhatsApp IDs");
    }
  }
  if (!chatIds && value.ownerGroups !== true) {
    throw invalidParams("Provide non-empty chatIds or set ownerGroups to true");
  }
  return {
    ...(chatIds ? { chatIds: chatIds.sort() } : {}),
    ...(value.ownerGroups === true ? { ownerGroups: true } : {}),
  };
}

function isWhatsAppChatId(value) {
  if (typeof value !== "string") return false;
  return /^[1-9][0-9]{4,19}@(s\.whatsapp\.net|lid)$/.test(value) ||
    /^[1-9][0-9]{4,19}(?:-[1-9][0-9]{4,19})?@g\.us$/.test(value);
}

function validateCallbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidParams("delivery.url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname || url.hash) {
    throw invalidParams("delivery.url must be an HTTPS URL without credentials");
  }
  return url.href;
}

function validateSecret(value) {
  if (typeof value !== "string" || !value.startsWith("whsec_")) throw invalidParams("Invalid webhook secret");
  const encoded = value.slice(6);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded) || encoded.length % 4 === 1 || (/[+\/]/.test(encoded) && /[_-]/.test(encoded))) {
    throw invalidParams("Invalid webhook secret");
  }
  const key = decodeSecret(value);
  const format = /[_-]/.test(encoded) ? "base64url" : "base64";
  if (key.length < 24 || key.length > 64 || key.toString(format).replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw invalidParams("Invalid webhook secret");
  }
  return value;
}

function grantedTtl(value) {
  if (value === undefined) return DEFAULT_TTL_MS;
  if (value === null) return MAX_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(value)));
}

function subscriptionId(principal, request) {
  const canonical = canonicalJson({ name: request.name, arguments: request.arguments, url: request.url });
  const digest = createHash("sha256").update(principal).update("\0").update(canonical).digest("base64url");
  return `sub_${digest}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidParams("Invalid normalized WhatsApp message");
  if (value.fromMe === true) return null;
  if (value.fromMe !== false) throw invalidParams("Invalid message fromMe");
  const type = typeof value.type === "string" ? value.type : "";
  const loweredType = type.toLowerCase();
  if (["history", "history_sync", "status", "protocol", "notification"].includes(loweredType)) return null;
  if (value.chatId === "status@broadcast") return null;
  if (!isWhatsAppChatId(value.chatId)) throw invalidParams("Invalid message chatId");
  for (const field of ["id", "type"]) {
    if (typeof value[field] !== "string") throw invalidParams(`Invalid message ${field}`);
  }
  if (value.senderId !== null && typeof value.senderId !== "string") throw invalidParams("Invalid message senderId");
  if (value.text !== null && typeof value.text !== "string") throw invalidParams("Invalid message text");
  const timestamp = normalizeTimestamp(value.timestamp);
  const message = {
    id: value.id,
    chatId: value.chatId,
    senderId: value.senderId ?? value.chatId,
    text: value.text ?? "",
    timestamp,
    fromMe: false,
    type,
    senderRole: value.senderRole === "owner" && isOwnerDirectMessage(value) ? "owner" : "untrusted",
    groupAllowed: value.groupAllowed === true,
    mentionsBot: value.mentionsBot === true,
  };
  if (typeof value.pushName === "string" && value.pushName.length > 0) message.pushName = value.pushName;
  return message;
}

function isOwnerGroupMention(message) {
  return message.fromMe === false &&
    message.groupAllowed === true &&
    message.mentionsBot === true &&
    isWhatsAppGroupId(message.chatId) &&
    isWhatsAppDirectId(message.senderId);
}

function subscriptionMatchesMessage(subscription, message) {
  return subscription.arguments.chatIds?.includes(message.chatId) === true ||
    (subscription.arguments.ownerGroups === true && isOwnerGroupMention(message));
}

function isWhatsAppGroupId(value) {
  return typeof value === "string" && /^[1-9][0-9]{4,19}(?:-[1-9][0-9]{4,19})?@g\.us$/.test(value);
}

function isWhatsAppDirectId(value) {
  return typeof value === "string" && /^[1-9][0-9]{4,19}@(s\.whatsapp\.net|lid)$/.test(value);
}

function isOwnerDirectMessage(value) {
  return value.fromMe === false &&
    typeof value.chatId === "string" &&
    value.chatId === value.senderId &&
    /^[1-9][0-9]{4,19}@lid$/.test(value.chatId);
}

function normalizeTimestamp(value) {
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === "number" && Number.isFinite(value)) date = new Date(value < 1e12 ? value * 1000 : value);
  else if (typeof value === "string") date = new Date(value);
  else throw invalidParams("Invalid message timestamp");
  if (!Number.isFinite(date.getTime())) throw invalidParams("Invalid message timestamp");
  return date.toISOString();
}

function upstreamEventId(message) {
  const digest = createHash("sha256").update(message.chatId).update("\0").update(message.id).digest("base64url");
  return `evt_wa_${digest.slice(0, 32)}`;
}

function signWebhook(secret, webhookId, timestamp, body) {
  const key = decodeSecret(secret);
  const digest = createHmac("sha256", key).update(`${webhookId}.${timestamp}.${body}`, "utf8").digest("base64");
  return `v1,${digest}`;
}

function decodeSecret(secret) {
  const encoded = secret.slice(6);
  return Buffer.from(encoded, /[_-]/.test(encoded) ? "base64url" : "base64");
}

async function resolvePublicDestination(value, lookup) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = net.isIP(hostname);
  let addresses;
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    addresses = await lookup(hostname);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw Object.assign(new Error("DNS returned no addresses"), { code: "ENOTFOUND" });
  const normalized = addresses.map((entry) => typeof entry === "string" ? { address: entry, family: net.isIP(entry) } : entry);
  if (normalized.some((entry) => !entry.family || !isPublicIp(entry.address))) {
    throw Object.assign(new Error("Callback resolves to a non-public address"), { code: "EPRIVATE" });
  }
  return { ...normalized[0], hostname };
}

function isPublicIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytes.slice(12).join("."));
  }
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  const hex = bytes.toString("hex");
  if (hex.startsWith("20010db8")) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] <= 0x01) return false;
  if (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPublicIpv4(bytes.slice(2, 6).join("."));
  return true;
}

function isPublicIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 31 && c === 196) return false;
  if (a === 192 && b === 52 && c === 193) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 175 && c === 48) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Bytes(address) {
  let input = address.split("%")[0].toLowerCase();
  const ipv4Match = input.match(/((?:\d{1,3}\.){3}\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match[1].split(".").map(Number);
    if (octets.some((part) => part > 255)) return null;
    input = `${input.slice(0, ipv4Match.index)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(parseInt(group, 16), index * 2));
  return bytes;
}

async function defaultDnsLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function defaultTransport({ url: value, address, family, servername, timeoutMs, headers, body }) {
  const url = new URL(value);
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers,
      servername,
      timeout: timeoutMs,
      autoSelectFamily: false,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 16 * 1024) chunks.push(chunk);
        else request.destroy(Object.assign(new Error("Response body too large"), { code: "ERESPONSETOOLARGE" }));
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("Webhook timeout"), { code: "ETIMEDOUT" })));
    request.on("error", reject);
    request.end(body);
  });
}

function constantTimeEqual(expected, actual) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function invalidParams(message) {
  return new EventsError(-32602, "InvalidParams", { reason: message });
}

function callbackError(reason) {
  return new EventsError(-32015, "CallbackEndpointError", { reason });
}

function categorizeTransportError(error) {
  if (error?.code === "ETIMEDOUT" || error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  if (typeof error?.code === "string" && error.code.startsWith("ERR_TLS")) return "tls_error";
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPRIVATE"].includes(error?.code)) return "connection_refused";
  return "connection_refused";
}

function isStoredSubscription(value) {
  return value && typeof value.id === "string" && typeof value.principal === "string" && value.name === EVENT_NAME &&
    isStoredArguments(value.arguments) && typeof value.url === "string" && typeof value.secret === "string" &&
    Number.isFinite(value.expiresAt) && value.active === true;
}

function isStoredArguments(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !["chatIds", "ownerGroups"].includes(key))) return false;
  const chatIds = value.chatIds;
  const validChatIds = Array.isArray(chatIds) && chatIds.length > 0 && chatIds.length <= 20 &&
    new Set(chatIds).size === chatIds.length && chatIds.every(isWhatsAppChatId);
  return (chatIds === undefined || validChatIds) &&
    (value.ownerGroups === undefined || value.ownerGroups === true) &&
    (validChatIds || value.ownerGroups === true);
}

function isStoredDelivery(value) {
  return value && typeof value.id === "string" && typeof value.subscriptionId === "string" &&
    value.event?.name === EVENT_NAME && typeof value.event?.eventId === "string" && Number.isInteger(value.attempts) &&
    Number.isFinite(value.nextAttemptAt);
}

function normalizeStoredDelivery(value) {
  try {
    const data = normalizeMessage(value.event.data);
    if (!data) return null;
    return {
      id: value.id,
      subscriptionId: value.subscriptionId,
      event: {
        eventId: value.event.eventId,
        name: EVENT_NAME,
        timestamp: data.timestamp,
        data,
        cursor: null,
      },
      attempts: value.attempts,
      nextAttemptAt: value.nextAttemptAt,
    };
  } catch {
    return null;
  }
}

function isSeenEntry(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Number.isFinite(value[1]);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export const __test = { isPublicIp, signWebhook };
