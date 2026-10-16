import { createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import { isPublicIp } from "./events.mjs";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const MAX_ENCRYPTED_MEDIA_BYTES = MAX_MEDIA_BYTES + 32;
export const MEDIA_CACHE_BYTES = 50 * 1024 * 1024;
export const MEDIA_CACHE_ITEMS = 10;
export const MEDIA_TTL_MS = 5 * 60 * 1000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function mediaError(message, code = "EMEDIA") {
  return Object.assign(new Error(message), { code });
}

function boundedString(value, name, maximum, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw mediaError(`${name} is invalid`, "EINVAL");
  }
  return value;
}

function validateFile(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw mediaError("file is invalid", "EINVAL");
  if (Object.keys(file).some((key) => !["download_url", "file_id", "mime_type", "file_name"].includes(key))) {
    throw mediaError("file contains an unexpected property", "EINVAL");
  }
  return {
    downloadUrl: boundedString(file.download_url, "file.download_url", 4096),
    fileId: boundedString(file.file_id, "file.file_id", 512),
    mimeType: boundedString(file.mime_type, "file.mime_type", 256, { optional: true }),
    fileName: boundedString(file.file_name, "file.file_name", 255, { optional: true }),
  };
}

function validateDownloadUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw mediaError("file download URL is invalid", "EINVAL");
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || (url.port && url.port !== "443")
    || url.hostname === "localhost"
    || url.hostname.endsWith(".localhost")
  ) {
    throw mediaError("file download URL is not allowed", "EPRIVATE");
  }
  url.hash = "";
  return url;
}

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : mediaError("file download timed out", "ETIMEDOUT");
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function resolvePublicDestination(url, lookup, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await abortable(lookup(hostname, { signal }), signal);
  if (!Array.isArray(addresses) || addresses.length === 0) throw mediaError("file host could not be resolved", "ENOTFOUND");
  const normalized = addresses.map((entry) => typeof entry === "string" ? { address: entry, family: net.isIP(entry) } : entry);
  if (normalized.some((entry) => !entry.family || !isPublicIp(entry.address))) {
    throw mediaError("file host is not public", "EPRIVATE");
  }
  return { ...normalized[0], hostname };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  return Array.isArray(value) ? value[0] : value;
}

function cleanMimeType(value, fallback) {
  const candidate = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(candidate) ? candidate : fallback;
}

export function safeFileName(value, fallback = "attachment") {
  const cleaned = String(value || "")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/^\.+$/, "_")
    .trim()
    .slice(0, 255);
  return cleaned || fallback;
}

function dispositionFileName(value) {
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(String(value || ""));
  if (!match) return undefined;
  try { return decodeURIComponent(match[1].replace(/^"|"$/g, "")); } catch { return match[1].replace(/^"|"$/g, ""); }
}

async function defaultDnsLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function defaultTransport({ url, address, family, servername, timeoutMs, maximum, signal }) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const request = https.request({
      protocol: "https:",
      hostname: url.hostname.replace(/^\[|\]$/g, ""),
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: { accept: "application/octet-stream" },
      servername,
      timeout: timeoutMs,
      autoSelectFamily: false,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => {
      const contentLength = Number.parseInt(String(response.headers["content-length"] || ""), 10);
      if (Number.isFinite(contentLength) && contentLength > maximum) {
        response.resume();
        request.destroy(mediaError("file response is too large", "ETOOLARGE"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maximum) request.destroy(mediaError("file response is too large", "ETOOLARGE"));
        else chunks.push(chunk);
      });
      response.on("aborted", () => finish(reject, mediaError("file download was interrupted", "EDOWNLOAD")));
      response.on("error", (error) => finish(reject, error));
      response.on("end", () => finish(resolve, {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks, size),
      }));
    });
    const abort = () => request.destroy(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    request.on("timeout", () => request.destroy(mediaError("file download timed out", "ETIMEDOUT")));
    request.on("error", (error) => finish(reject, error));
    request.end();
  });
}

function validateWhatsAppDirectPath(value) {
  if (
    typeof value !== "string"
    || value.length < 2
    || value.length > 4096
    || !/^\/(?!\/)/.test(value)
    || /[\\\u0000-\u001f\u007f]/.test(value)
  ) {
    throw mediaError("WhatsApp media path is invalid", "EINVAL");
  }
  const url = new URL(value, "https://mmg.whatsapp.net");
  if (
    url.protocol !== "https:"
    || url.hostname !== "mmg.whatsapp.net"
    || url.port
    || url.username
    || url.password
  ) {
    throw mediaError("WhatsApp media path is invalid", "EINVAL");
  }
  url.hash = "";
  return url;
}

function cryptoBytes(value, length) {
  if (!(value instanceof Uint8Array)) throw mediaError("WhatsApp media keys are invalid", "EDECRYPT");
  const result = Buffer.from(value);
  if (result.length !== length) throw mediaError("WhatsApp media keys are invalid", "EDECRYPT");
  return result;
}

function sanitizedWhatsAppError(error) {
  if (error?.code === "ETOOLARGE") return mediaError("WhatsApp media exceeds 20 MiB", "ETOOLARGE");
  if (error?.code === "ETIMEDOUT") return mediaError("WhatsApp media download timed out", "ETIMEDOUT");
  if (error?.code === "EABORT") return mediaError("WhatsApp media download was aborted", "EABORT");
  if (error?.code === "EREDIRECT") return mediaError("WhatsApp media download redirected", "EREDIRECT");
  if (error?.code === "EINVAL") return mediaError("WhatsApp media request is invalid", "EINVAL");
  if (error?.code === "EDECRYPT") return mediaError("WhatsApp media could not be verified", "EDECRYPT");
  return mediaError("WhatsApp media download failed", "EDOWNLOAD");
}

export async function downloadWhatsAppMedia({ mediaKey, directPath } = {}, kind, {
  getMediaKeys,
  signal,
  timeoutMs = 30_000,
  dnsLookup = defaultDnsLookup,
  transport = defaultTransport,
} = {}) {
  try {
    const url = validateWhatsAppDirectPath(directPath);
    if (!(mediaKey instanceof Uint8Array) || mediaKey.length !== 32) {
      throw mediaError("WhatsApp media key is invalid", "EINVAL");
    }
    if (!["image", "video", "document"].includes(kind) || typeof getMediaKeys !== "function") {
      throw mediaError("WhatsApp media request is invalid", "EINVAL");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw mediaError("WhatsApp media timeout is invalid", "EINVAL");
    }

    const controller = new AbortController();
    const aborted = () => controller.abort(mediaError("WhatsApp media download was aborted", "EABORT"));
    if (signal?.aborted) aborted();
    else signal?.addEventListener?.("abort", aborted, { once: true });
    const timer = setTimeout(
      () => controller.abort(mediaError("WhatsApp media download timed out", "ETIMEDOUT")),
      timeoutMs,
    );
    timer.unref?.();
    const deadline = Date.now() + timeoutMs;
    try {
      const keys = await abortable(Promise.resolve().then(() => getMediaKeys(mediaKey, kind)), controller.signal);
      const iv = cryptoBytes(keys?.iv, 16);
      const cipherKey = cryptoBytes(keys?.cipherKey, 32);
      const macKey = cryptoBytes(keys?.macKey, 32);
      const destination = await resolvePublicDestination(url, dnsLookup, controller.signal);
      const response = await abortable(transport({
        url,
        address: destination.address,
        family: destination.family,
        servername: destination.hostname,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maximum: MAX_ENCRYPTED_MEDIA_BYTES,
        signal: controller.signal,
      }), controller.signal);
      if (REDIRECT_STATUSES.has(response?.status)) throw mediaError("WhatsApp media download redirected", "EREDIRECT");
      if (response?.status !== 200 || !Buffer.isBuffer(response.body)) {
        throw mediaError("WhatsApp media download failed", "EDOWNLOAD");
      }
      const declaredLength = Number.parseInt(String(headerValue(response.headers, "content-length") || ""), 10);
      if (
        response.body.length < 26
        || response.body.length > MAX_ENCRYPTED_MEDIA_BYTES
        || (Number.isFinite(declaredLength) && declaredLength > MAX_ENCRYPTED_MEDIA_BYTES)
      ) {
        throw mediaError("WhatsApp media exceeds 20 MiB", "ETOOLARGE");
      }
      const ciphertext = response.body.subarray(0, -10);
      const receivedMac = response.body.subarray(-10);
      if (ciphertext.length < 16 || ciphertext.length % 16 !== 0) {
        throw mediaError("WhatsApp media could not be verified", "EDECRYPT");
      }
      const expectedMac = createHmac("sha256", macKey).update(iv).update(ciphertext).digest().subarray(0, 10);
      if (!timingSafeEqual(receivedMac, expectedMac)) {
        throw mediaError("WhatsApp media could not be verified", "EDECRYPT");
      }
      let plaintext;
      try {
        const decipher = createDecipheriv("aes-256-cbc", cipherKey, iv);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw mediaError("WhatsApp media could not be verified", "EDECRYPT");
      }
      if (plaintext.length < 1 || plaintext.length > MAX_MEDIA_BYTES) {
        throw mediaError("WhatsApp media exceeds 20 MiB", "ETOOLARGE");
      }
      return Readable.from([plaintext]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", aborted);
    }
  } catch (error) {
    throw sanitizedWhatsAppError(error);
  }
}

export async function downloadFile(file, {
  maximum = MAX_MEDIA_BYTES,
  timeoutMs = 30_000,
  maximumRedirects = 3,
  dnsLookup = defaultDnsLookup,
  transport = defaultTransport,
} = {}) {
  const input = validateFile(file);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_MEDIA_BYTES) throw mediaError("maximum is invalid", "EINVAL");
  let url = validateDownloadUrl(input.downloadUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw mediaError("timeout is invalid", "EINVAL");
  const controller = new AbortController();
  const timeoutError = mediaError("file download timed out", "ETIMEDOUT");
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref?.();
  const deadline = Date.now() + timeoutMs;
  try {
    for (let redirects = 0; ; redirects += 1) {
      if (controller.signal.aborted) throw abortError(controller.signal);
      const destination = await resolvePublicDestination(url, dnsLookup, controller.signal);
      if (controller.signal.aborted) throw abortError(controller.signal);
      const response = await abortable(transport({
        url,
        address: destination.address,
        family: destination.family,
        servername: destination.hostname,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maximum,
        signal: controller.signal,
      }), controller.signal);
      if (!response || !Number.isInteger(response.status)) throw mediaError("file download failed", "EDOWNLOAD");
      if (REDIRECT_STATUSES.has(response.status)) {
        if (redirects >= maximumRedirects) throw mediaError("file download redirected too many times", "EREDIRECT");
        const location = headerValue(response.headers, "location");
        if (typeof location !== "string" || location.length === 0) throw mediaError("file redirect is invalid", "EREDIRECT");
        url = validateDownloadUrl(new URL(location, url).toString());
        continue;
      }
      if (response.status !== 200) throw mediaError("file download failed", "EDOWNLOAD");
      if (!Buffer.isBuffer(response.body) || response.body.length < 1 || response.body.length > maximum) {
        throw mediaError("file response size is invalid", "ETOOLARGE");
      }
      const declaredLength = Number.parseInt(String(headerValue(response.headers, "content-length") || ""), 10);
      if (Number.isFinite(declaredLength) && declaredLength > maximum) throw mediaError("file response is too large", "ETOOLARGE");
      const hintedMimeType = cleanMimeType(input.mimeType, "application/octet-stream");
      const responseMimeType = cleanMimeType(headerValue(response.headers, "content-type"), hintedMimeType);
      return {
        data: response.body,
        mimetype: responseMimeType === "application/octet-stream" ? hintedMimeType : responseMimeType,
        fileName: safeFileName(input.fileName || dispositionFileName(headerValue(response.headers, "content-disposition")), input.fileId),
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

export class MediaStore {
  constructor({
    publicUrl,
    now = Date.now,
    random = randomBytes,
    ttlMs = MEDIA_TTL_MS,
    maximumBytes = MEDIA_CACHE_BYTES,
    maximumItems = MEDIA_CACHE_ITEMS,
  } = {}) {
    const origin = new URL(publicUrl);
    origin.pathname = origin.pathname.replace(/\/$/, "");
    origin.search = "";
    origin.hash = "";
    this.publicUrl = origin.toString().replace(/\/$/, "");
    this.now = now;
    this.random = random;
    this.ttlMs = ttlMs;
    this.maximumBytes = maximumBytes;
    this.maximumItems = maximumItems;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  put({ data, mimetype, fileName }) {
    if (!Buffer.isBuffer(data) || data.length < 1 || data.length > MAX_MEDIA_BYTES || data.length > this.maximumBytes) {
      throw mediaError("media is invalid", "ETOOLARGE");
    }
    this.prune();
    while (this.entries.size >= this.maximumItems || this.totalBytes + data.length > this.maximumBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.#delete(oldest);
    }
    if (this.entries.size >= this.maximumItems || this.totalBytes + data.length > this.maximumBytes) {
      throw mediaError("media cache is full", "ETOOLARGE");
    }
    let token;
    do { token = this.random(32).toString("base64url"); } while (this.entries.has(token));
    const expiresAt = this.now() + this.ttlMs;
    const entry = {
      data,
      mimetype: cleanMimeType(mimetype, "application/octet-stream"),
      fileName: safeFileName(fileName),
      expiresAt,
    };
    this.entries.set(token, entry);
    this.totalBytes += data.length;
    return {
      downloadUrl: `${this.publicUrl}/media/${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
      fileName: entry.fileName,
      mimetype: entry.mimetype,
      size: data.length,
    };
  }

  get(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.#delete(token);
      return null;
    }
    return entry;
  }

  prune() {
    const now = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= now) this.#delete(token);
  }

  stats() {
    this.prune();
    return { items: this.entries.size, bytes: this.totalBytes };
  }

  #delete(token) {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.totalBytes -= entry.data.length;
    this.entries.delete(token);
  }
}

export function contentDisposition(fileName) {
  const safe = safeFileName(fileName).replace(/["\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safeFileName(fileName))}`;
}
