import assert from "node:assert/strict";
import { createCipheriv, createHmac } from "node:crypto";
import test from "node:test";

import {
  downloadFile,
  downloadWhatsAppMedia,
  MAX_MEDIA_BYTES,
  MEDIA_CACHE_BYTES,
  MEDIA_CACHE_ITEMS,
  MEDIA_TTL_MS,
  MediaStore,
} from "./media.mjs";

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function encryptedFixture(plaintext = Buffer.from("verified WhatsApp media")) {
  const keys = {
    iv: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
    cipherKey: Buffer.from("0123456789abcdef".repeat(4), "hex"),
    macKey: Buffer.from("fedcba9876543210".repeat(4), "hex"),
  };
  const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10);
  return { plaintext, payload: Buffer.concat([ciphertext, mac]), keys };
}

function file(download_url = "https://files.example.test/item") {
  return {
    download_url,
    file_id: "file_fixture",
    mime_type: "application/octet-stream",
    file_name: "fixture.bin",
  };
}

test("file downloads require HTTPS public port-443 destinations and pinned DNS", async () => {
  let transportCalls = 0;
  const transport = async (request) => {
    transportCalls += 1;
    assert.equal(request.address, "93.184.216.34");
    assert.equal(request.family, 4);
    assert.equal(request.servername, "files.example.test");
    assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 30_000);
    return {
      status: 200,
      headers: { "content-type": "image/png", "content-disposition": "attachment; filename=remote.png" },
      body: Buffer.from("png"),
    };
  };
  const dnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  for (const value of [
    "http://files.example.test/item",
    "file:///tmp/private.png",
    "https://user:secret@files.example.test/item",
    "https://files.example.test:8443/item",
    "https://127.0.0.1/item",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/item",
  ]) {
    await assert.rejects(downloadFile(file(value), { dnsLookup, transport }), { code: "EPRIVATE" });
  }
  assert.equal(transportCalls, 0);

  await assert.rejects(downloadFile(file(), {
    dnsLookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.8", family: 4 },
    ],
    transport,
  }), { code: "EPRIVATE" });
  assert.equal(transportCalls, 0);

  const downloaded = await downloadFile(file(), { dnsLookup, transport });
  assert.equal(downloaded.data.toString(), "png");
  assert.equal(downloaded.mimetype, "image/png");
  assert.equal(downloaded.fileName, "fixture.bin");
  assert.equal(transportCalls, 1);
});

test("redirects re-resolve and fail closed on DNS rebinding or excess hops", async () => {
  let lookups = 0;
  let requests = 0;
  await assert.rejects(downloadFile(file(), {
    dnsLookup: async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? "93.184.216.34" : "10.0.0.1", family: 4 }];
    },
    transport: async () => {
      requests += 1;
      return { status: 302, headers: { location: "/next" }, body: Buffer.alloc(0) };
    },
  }), { code: "EPRIVATE" });
  assert.equal(lookups, 2);
  assert.equal(requests, 1);

  requests = 0;
  await assert.rejects(downloadFile(file(), {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => {
      requests += 1;
      return { status: 302, headers: { location: `/redirect-${requests}` }, body: Buffer.alloc(0) };
    },
  }), { code: "EREDIRECT" });
  assert.equal(requests, 4);

  await assert.rejects(downloadFile(file(), {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: async () => ({ status: 302, headers: { location: "https://localhost/private" }, body: Buffer.alloc(0) }),
  }), { code: "EPRIVATE" });
});

test("downloads enforce response and time bounds without exposing signed URLs", async () => {
  const dnsLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  await assert.rejects(downloadFile(file(), {
    maximum: 8,
    dnsLookup,
    transport: async () => ({ status: 200, headers: {}, body: Buffer.alloc(9) }),
  }), { code: "ETOOLARGE" });
  await assert.rejects(downloadFile(file(), {
    maximum: 8,
    dnsLookup,
    transport: async () => ({ status: 200, headers: { "content-length": "9" }, body: Buffer.alloc(1) }),
  }), { code: "ETOOLARGE" });

  let timeout;
  await assert.rejects(downloadFile(file("https://files.example.test/item?signature=private-key"), {
    dnsLookup,
    transport: async (request) => {
      timeout = request.timeoutMs;
      throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    },
  }), (error) => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(String(error).includes("private-key"), false);
    return true;
  });
  assert.ok(timeout > 0 && timeout <= 30_000);
});

test("one total deadline aborts DNS and active transfer work", async () => {
  let dnsAborted = false;
  await assert.rejects(downloadFile(file(), {
    timeoutMs: 20,
    dnsLookup: (_hostname, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        dnsAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    transport: async () => assert.fail("transport must not start after DNS timeout"),
  }), { code: "ETIMEDOUT" });
  assert.equal(dnsAborted, true);

  let transferAborted = false;
  await assert.rejects(downloadFile(file(), {
    timeoutMs: 20,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        transferAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  }), { code: "ETIMEDOUT" });
  assert.equal(transferAborted, true);
});

test("WhatsApp media uses pinned mmg transport and verifies MAC before AES decryption", async () => {
  const fixture = encryptedFixture();
  const mediaKey = Buffer.alloc(32, 7);
  let keyCalls = 0;
  const stream = await downloadWhatsAppMedia(
    { mediaKey, directPath: "/v/t62.7118-24/example.enc?token=secret" },
    "image",
    {
      getMediaKeys: async (receivedKey, kind) => {
        keyCalls += 1;
        assert.equal(receivedKey, mediaKey);
        assert.equal(kind, "image");
        return fixture.keys;
      },
      dnsLookup: async (hostname) => {
        assert.equal(hostname, "mmg.whatsapp.net");
        return [{ address: "157.240.8.53", family: 4 }];
      },
      transport: async (request) => {
        assert.equal(request.url.origin, "https://mmg.whatsapp.net");
        assert.equal(request.url.pathname, "/v/t62.7118-24/example.enc");
        assert.equal(request.servername, "mmg.whatsapp.net");
        assert.equal(request.address, "157.240.8.53");
        assert.equal(request.maximum, MAX_MEDIA_BYTES + 32);
        return { status: 200, headers: {}, body: fixture.payload };
      },
    },
  );
  assert.equal(keyCalls, 1);
  assert.deepEqual(await readStream(stream), fixture.plaintext);
});

test("WhatsApp media rejects unsafe paths, redirects, tampering and oversized encrypted bodies", async () => {
  const fixture = encryptedFixture();
  const mediaKey = Buffer.alloc(32, 8);
  const options = {
    getMediaKeys: async () => fixture.keys,
    dnsLookup: async () => [{ address: "157.240.8.53", family: 4 }],
    transport: async () => ({ status: 200, headers: {}, body: fixture.payload }),
  };
  for (const directPath of [
    "https://evil.example/media",
    "//evil.example/media",
    "/\\evil.example/media",
    "/media\nheader",
  ]) {
    await assert.rejects(downloadWhatsAppMedia({ mediaKey, directPath }, "video", options), { code: "EINVAL" });
  }

  let requests = 0;
  await assert.rejects(downloadWhatsAppMedia(
    { mediaKey, directPath: "/redirect" },
    "video",
    { ...options, transport: async () => {
      requests += 1;
      return { status: 302, headers: { location: "https://evil.example/media" }, body: Buffer.alloc(0) };
    } },
  ), { code: "EREDIRECT" });
  assert.equal(requests, 1);

  const tampered = Buffer.from(fixture.payload);
  tampered[0] ^= 1;
  await assert.rejects(downloadWhatsAppMedia(
    { mediaKey, directPath: "/tampered" },
    "document",
    { ...options, transport: async () => ({ status: 200, headers: {}, body: tampered }) },
  ), { code: "EDECRYPT" });

  await assert.rejects(downloadWhatsAppMedia(
    { mediaKey, directPath: "/oversized" },
    "document",
    { ...options, transport: async () => ({
      status: 200,
      headers: { "content-length": String(MAX_MEDIA_BYTES + 33) },
      body: fixture.payload,
    }) },
  ), { code: "ETOOLARGE" });
});

test("WhatsApp media caller abort cancels an active transfer without leaking its path", async () => {
  const fixture = encryptedFixture();
  const controller = new AbortController();
  let transferAborted = false;
  const pending = downloadWhatsAppMedia(
    { mediaKey: Buffer.alloc(32, 9), directPath: "/secret/path?auth=private" },
    "image",
    {
      signal: controller.signal,
      getMediaKeys: async () => fixture.keys,
      dnsLookup: async () => [{ address: "157.240.8.53", family: 4 }],
      transport: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          transferAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    },
  );
  setImmediate(() => controller.abort(new Error("private caller reason")));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "EABORT");
    assert.equal(String(error).includes("private"), false);
    assert.equal(String(error).includes("secret"), false);
    return true;
  });
  assert.equal(transferAborted, true);
});

test("media cache uses expiring 32-byte capabilities and remains bounded", () => {
  assert.equal(MAX_MEDIA_BYTES, 20 * 1024 * 1024);
  assert.equal(MEDIA_CACHE_BYTES, 50 * 1024 * 1024);
  assert.equal(MEDIA_CACHE_ITEMS, 10);
  assert.equal(MEDIA_TTL_MS, 5 * 60 * 1000);
  let now = 1_800_000_000_000;
  let sequence = 0;
  const store = new MediaStore({
    publicUrl: "https://wa.example.test",
    now: () => now,
    random: (size) => Buffer.alloc(size, sequence += 1),
    ttlMs: 100,
    maximumBytes: 8,
    maximumItems: 2,
  });
  const firstData = Buffer.from("1111");
  const first = store.put({ data: firstData, mimetype: "image/png", fileName: "one.png" });
  const firstToken = new URL(first.downloadUrl).pathname.split("/").pop();
  assert.equal(firstToken.length, 43);
  assert.equal(store.get(firstToken).data, firstData);

  const second = store.put({ data: Buffer.from("2222"), mimetype: "video/mp4", fileName: "two.mp4" });
  const secondToken = new URL(second.downloadUrl).pathname.split("/").pop();
  const third = store.put({ data: Buffer.from("3333"), mimetype: "application/pdf", fileName: "three.pdf" });
  const thirdToken = new URL(third.downloadUrl).pathname.split("/").pop();
  assert.equal(store.get(firstToken), null);
  assert.deepEqual(store.stats(), { items: 2, bytes: 8 });

  now += 101;
  assert.equal(store.get(secondToken), null);
  assert.equal(store.get(thirdToken), null);
  assert.deepEqual(store.stats(), { items: 0, bytes: 0 });
});
