import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { WhatsAppBridge } from './bridge.mjs'

const silentLogger = {
  calls: [],
  error(...args) { this.calls.push(args) },
  warn() {},
  info() {},
  debug() {},
  trace() {},
  child() { return this }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function createHarness(dataDir, overrides = {}) {
  const sockets = []
  const sentMessages = []
  let sendCalls = 0
  let endCalls = 0
  let groupMetadataCalls = 0
  const downloadCalls = []
  const socketFactory = overrides.socketFactory ?? (() => {
    const socket = {
      ev: new EventEmitter(),
      user: overrides.socketUser ?? { id: '85255551234@s.whatsapp.net', name: 'Dot' },
      signalRepository: overrides.signalRepository,
      async groupMetadata(chatId) {
        groupMetadataCalls += 1
        return overrides.groupMetadata?.(chatId) ?? { id: chatId, participants: [] }
      },
      async sendMessage(chatId, content, options) {
        sendCalls += 1
        sentMessages.push({ chatId, content, options })
        await new Promise((resolve) => setTimeout(resolve, 10))
        return { key: { id: options.messageId, remoteJid: chatId }, message: { conversation: content.text } }
      },
      end() { endCalls += 1 }
    }
    sockets.push(socket)
    return socket
  })
  const authStateFactory = overrides.authStateFactory ?? (async (authDir) => {
    await writeFile(join(authDir, 'creds.json'), '{}', { mode: 0o644 })
    return {
      state: { creds: { registered: true }, keys: {} },
      async saveCreds() {}
    }
  })
  const downloadImpl = overrides.downloadContentFromMessage ?? (async () => Readable.from([]))
  const bridge = new WhatsAppBridge({
    dataDir,
    logger: silentLogger,
    socketFactory,
    authStateFactory,
    downloadContentFromMessage: async (...args) => {
      downloadCalls.push(args)
      return downloadImpl(...args)
    },
    disconnectReason: { loggedOut: 401 },
    reconnectDelayMs: 5,
    reconnectMaxDelayMs: 10,
    ...overrides.options
  })
  return {
    bridge,
    sockets,
    sentMessages,
    downloadCalls,
    get sendCalls() { return sendCalls },
    get endCalls() { return endCalls },
    get groupMetadataCalls() { return groupMetadataCalls }
  }
}

test('stores and emits only live incoming text or media without logging QR data', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-bridge-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  silentLogger.calls = []
  const harness = createHarness(dataDir)
  const received = []
  harness.bridge.on('message', (message) => received.push(message))

  await harness.bridge.start()
  const socket = harness.sockets[0]
  socket.ev.emit('connection.update', { qr: 'private-qr-payload' })
  assert.equal(harness.bridge.getQr(), 'private-qr-payload')
  assert.equal(silentLogger.calls.flat(Infinity).includes('private-qr-payload'), false)
  socket.ev.emit('connection.update', { connection: 'open' })
  assert.deepEqual(harness.bridge.getStatus(), {
    status: 'connected',
    account: { id: '85255551234@s.whatsapp.net', name: 'Dot' },
    paired: true,
    owner: { valid: false, count: 0, directMessagesOnly: true, allowOwnerGroups: false }
  })
  const nowSeconds = Math.floor(Date.now() / 1000)
  socket.ev.emit('messaging-history.set', {
    chats: [{ id: '85255559999@s.whatsapp.net', name: 'History chat', conversationTimestamp: nowSeconds - 3600 }],
    messages: [{ key: { id: 'history-set', remoteJid: '85255559999@s.whatsapp.net', fromMe: false }, message: { conversation: 'must not trigger' } }]
  })
  await waitFor(() => harness.bridge.listChats().some((chat) => chat.id === '85255559999@s.whatsapp.net'))
  assert.equal(received.length, 0)

  socket.ev.emit('messages.upsert', {
    type: 'append',
    messages: [{ key: { id: 'history', remoteJid: '85255550000@s.whatsapp.net', fromMe: false }, message: { conversation: 'old' } }]
  })
  socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { id: 'own', remoteJid: '85255550000@s.whatsapp.net', fromMe: true }, message: { conversation: 'own' } },
      { key: { id: 'status', remoteJid: 'status@broadcast', fromMe: false }, message: { conversation: 'status' } },
      {
        key: { id: 'text-1', remoteJid: '85255550000@s.whatsapp.net', fromMe: false },
        pushName: 'Alice',
        messageTimestamp: nowSeconds,
        message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'hello' } } } }
      },
      {
        key: { id: 'media-1', remoteJid: '120363123456789012-1750000000@g.us', participant: '85255550001@s.whatsapp.net', fromMe: false },
        messageTimestamp: nowSeconds + 1,
        message: { imageMessage: { mimetype: 'image/jpeg', fileName: 'photo.jpg', url: 'https://example.invalid/private' } }
      }
    ]
  })
  socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'text-1', remoteJid: '85255550000@s.whatsapp.net', fromMe: false },
      pushName: 'Alice',
      messageTimestamp: nowSeconds,
      message: { conversation: 'hello' }
    }]
  })

  await waitFor(() => received.length === 2)
  assert.deepEqual(received[0], {
    id: 'text-1',
    chatId: '85255550000@s.whatsapp.net',
    senderId: '85255550000@s.whatsapp.net',
    direction: 'incoming',
    fromMe: false,
    senderRole: 'untrusted',
    groupAllowed: false,
    mentionsBot: false,
    mentionsAll: false,
    repliesToBot: false,
    quotedMessageId: null,
    replyAllowed: false,
    type: 'notify',
    pushName: 'Alice',
    timestamp: nowSeconds * 1000,
    text: 'hello',
    mediaType: null,
    media: null
  })
  assert.deepEqual(received[1].media, { mimetype: 'image/jpeg', fileName: 'photo.jpg' })
  assert.equal(JSON.stringify(received).includes('example.invalid'), false)
  assert.deepEqual(harness.bridge.getMessages({ chatId: '85255550000@s.whatsapp.net' }).map((message) => message.id), ['text-1'])

  socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'bounded-text', remoteJid: '85255550000@s.whatsapp.net', fromMe: false },
      messageTimestamp: nowSeconds + 2,
      message: { conversation: '💥'.repeat(9000) }
    }]
  })
  await waitFor(() => received.length === 3)
  assert.ok(received[2].text.length <= 8000)
  assert.ok(Buffer.byteLength(received[2].text) <= 32_000)

  await harness.bridge.sendText({
    chatId: '120363123456789012@g.us',
    text: 'modern group JID',
    idempotencyKey: 'group-send'
  })

  assert.equal((await stat(dataDir)).mode & 0o777, 0o700)
  assert.equal((await stat(join(dataDir, 'auth'))).mode & 0o777, 0o700)
  assert.equal((await stat(join(dataDir, 'auth', 'creds.json'))).mode & 0o777, 0o600)
  await harness.bridge.stop()
  assert.equal(harness.endCalls, 1)
})

test('serializes concurrent idempotent sends and reuses the persisted message ID after restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-idempotency-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const first = createHarness(dataDir)
  await first.bridge.start()
  first.sockets[0].ev.emit('connection.update', { connection: 'open' })

  const request = { chatId: '85255550000@s.whatsapp.net', text: 'one delivery', idempotencyKey: 'reply:incoming-1' }
  const [firstId, secondId] = await Promise.all([first.bridge.sendText(request), first.bridge.sendText(request)])
  assert.equal(firstId, secondId)
  assert.equal(first.sendCalls, 1)
  await assert.rejects(
    first.bridge.sendText({ ...request, text: 'different payload' }),
    /different request/
  )
  await first.bridge.stop()

  const second = createHarness(dataDir)
  await second.bridge.start()
  second.sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.equal(await second.bridge.sendText(request), firstId)
  assert.equal(second.sendCalls, 0)
  assert.equal(second.bridge.getMessages({ chatId: request.chatId })[0].text, 'one delivery')
  await second.bridge.stop()
})

test('sends decoded image content and persists only caption and media metadata', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-image-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const harness = createHarness(dataDir)
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII='

  const messageId = await harness.bridge.sendImage({
    chatId: '85255550000@s.whatsapp.net',
    imageBase64,
    caption: 'tiny image',
    idempotencyKey: 'image:tiny'
  })

  assert.equal(harness.sentMessages.length, 1)
  assert.equal(harness.sentMessages[0].chatId, '85255550000@s.whatsapp.net')
  assert.deepEqual(harness.sentMessages[0].content, {
    image: Buffer.from(imageBase64, 'base64'),
    mimetype: 'image/png',
    caption: 'tiny image'
  })
  assert.equal(harness.sentMessages[0].options.messageId, messageId)
  const storedMessage = harness.bridge.getMessages({ chatId: '85255550000@s.whatsapp.net' })[0]
  assert.equal(storedMessage.text, 'tiny image')
  assert.equal(storedMessage.mediaType, 'image')
  assert.deepEqual(storedMessage.media, {
    mimetype: 'image/png',
    size: Buffer.from(imageBase64, 'base64').length
  })
  const persisted = await readFile(join(dataDir, 'store.json'), 'utf8')
  assert.equal(persisted.includes(imageBase64), false)
  assert.equal(persisted.includes('imageBase64'), false)
  await harness.bridge.stop()
})

test('deduplicates image sends across concurrency and restart with shared text keys', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-image-idempotency-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII='
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')
  const request = {
    chatId: '85255550000@s.whatsapp.net',
    imageBase64: png,
    caption: 'one delivery',
    idempotencyKey: 'image:dedupe'
  }
  const first = createHarness(dataDir)
  await first.bridge.start()
  first.sockets[0].ev.emit('connection.update', { connection: 'open' })

  const [firstId, secondId] = await Promise.all([
    first.bridge.sendImage(request),
    first.bridge.sendImage(request)
  ])
  assert.equal(firstId, secondId)
  assert.equal(first.sendCalls, 1)
  await assert.rejects(first.bridge.sendImage({ ...request, caption: 'changed' }), /different request/)
  await assert.rejects(first.bridge.sendImage({ ...request, imageBase64: jpeg }), /different request/)
  await assert.rejects(first.bridge.sendImage({ ...request, chatId: '85255550001@s.whatsapp.net' }), /different request/)
  await assert.rejects(first.bridge.sendText({
    chatId: request.chatId,
    text: 'collision',
    idempotencyKey: request.idempotencyKey
  }), /different request/)
  await first.bridge.sendText({
    chatId: request.chatId,
    text: 'text first',
    idempotencyKey: 'shared:text-first'
  })
  await assert.rejects(first.bridge.sendImage({
    ...request,
    idempotencyKey: 'shared:text-first'
  }), /different request/)
  await first.bridge.stop()

  const second = createHarness(dataDir)
  await second.bridge.start()
  second.sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.equal(await second.bridge.sendImage(request), firstId)
  assert.equal(second.sendCalls, 0)
  await second.bridge.stop()
})

test('rejects malformed, unsupported, oversized images and oversized captions', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-image-validation-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const harness = createHarness(dataDir)
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const request = {
    chatId: '85255550000@s.whatsapp.net',
    caption: '',
    idempotencyKey: 'image:invalid'
  }

  for (const imageBase64 of ['', 'not base64', 'data:image/png;base64,iVBORw0KGgo=', 'aGVsbG8=']) {
    await assert.rejects(harness.bridge.sendImage({ ...request, imageBase64 }), /imageBase64/)
  }
  await assert.rejects(harness.bridge.sendImage({
    ...request,
    imageBase64: 'iVBORw0KGgo=',
    caption: 'x'.repeat(2001)
  }), /caption/)
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized)
  await assert.rejects(harness.bridge.sendImage({
    ...request,
    imageBase64: oversized.toString('base64')
  }), /imageBase64/)
  assert.equal(harness.sendCalls, 0)
  await harness.bridge.stop()
})

test('sends bounded video and document buffers with durable shared idempotency', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-send-media-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const video = Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  const document = Buffer.from('%PDF-1.7 unique document body')
  const request = {
    chatId: '85255550000@s.whatsapp.net',
    kind: 'document',
    data: document,
    mimetype: 'application/pdf',
    fileName: '../private/report\r\n.pdf',
    caption: 'report',
    idempotencyKey: 'media:document'
  }
  const first = createHarness(dataDir)
  await first.bridge.start()
  first.sockets[0].ev.emit('connection.update', { connection: 'open' })

  const [firstId, secondId] = await Promise.all([
    first.bridge.sendMedia(request),
    first.bridge.sendMedia(request)
  ])
  assert.equal(firstId, secondId)
  assert.equal(first.sendCalls, 1)
  assert.deepEqual(first.sentMessages[0].content, {
    document,
    mimetype: 'application/pdf',
    fileName: 'report.pdf',
    caption: 'report'
  })
  await first.bridge.sendMedia({
    chatId: request.chatId,
    kind: 'video',
    data: video,
    mimetype: 'video/mp4',
    fileName: 'clips/demo.mp4',
    caption: '',
    idempotencyKey: 'media:video'
  })
  assert.deepEqual(first.sentMessages[1].content, {
    video,
    mimetype: 'video/mp4',
    caption: ''
  })
  const storedVideo = first.bridge.getMessages({ chatId: request.chatId })
    .find((message) => message.mediaType === 'video')
  assert.deepEqual(storedVideo.media, { mimetype: 'video/mp4', fileName: 'demo.mp4', size: video.length })

  for (const change of [
    { caption: 'changed' },
    { data: Buffer.from('%PDF-1.7 changed') },
    { mimetype: 'application/octet-stream' },
    { fileName: 'changed.pdf' },
    { kind: 'video', data: video, mimetype: 'video/mp4', fileName: 'report.pdf' },
    { chatId: '85255550001@s.whatsapp.net' }
  ]) {
    await assert.rejects(first.bridge.sendMedia({ ...request, ...change }), /different request/)
  }
  await assert.rejects(first.bridge.sendText({
    chatId: request.chatId,
    text: 'collision',
    idempotencyKey: request.idempotencyKey
  }), /different request/)
  await assert.rejects(first.bridge.sendImage({
    chatId: request.chatId,
    imageBase64: 'iVBORw0KGgo=',
    idempotencyKey: request.idempotencyKey
  }), /different request/)
  const persisted = await readFile(join(dataDir, 'store.json'), 'utf8')
  assert.equal(persisted.includes(document.toString('base64')), false)
  assert.equal(persisted.includes(document.toString()), false)
  await first.bridge.stop()

  const second = createHarness(dataDir)
  await second.bridge.start()
  second.sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.equal(await second.bridge.sendMedia(request), firstId)
  assert.equal(second.sendCalls, 0)
  await second.bridge.stop()
})

test('derives the WhatsApp video duration from a bounded MP4 mvhd box', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-video-duration-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const video = Buffer.from(
    '000000186674797069736f6d0000020069736f6d69736f32'
    + '000000246d6f6f760000001c6d766864000000000000000000000000000003e8000007d0',
    'hex'
  )
  const harness = createHarness(dataDir)
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })

  await harness.bridge.sendMedia({
    chatId: '85255550000@s.whatsapp.net',
    kind: 'video',
    data: video,
    mimetype: 'video/mp4',
    fileName: 'red-blue.mp4',
    caption: 'two seconds',
    idempotencyKey: 'media:duration'
  })

  assert.deepEqual(harness.sentMessages[0].content, {
    video,
    mimetype: 'video/mp4',
    caption: 'two seconds',
    seconds: 2
  })
  await harness.bridge.stop()
})

test('rejects unsupported or unsafe outgoing media inputs', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-send-media-validation-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const harness = createHarness(dataDir)
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const request = {
    chatId: '85255550000@s.whatsapp.net',
    kind: 'document',
    data: Buffer.from('document'),
    mimetype: 'application/octet-stream',
    fileName: 'file.bin',
    idempotencyKey: 'media:invalid'
  }

  await assert.rejects(harness.bridge.sendMedia({ ...request, kind: 'audio' }), /kind/)
  await assert.rejects(harness.bridge.sendMedia({ ...request, data: new Uint8Array([1]) }), /Buffer/)
  await assert.rejects(harness.bridge.sendMedia({ ...request, data: Buffer.alloc(20 * 1024 * 1024 + 1) }), /20 MiB/)
  await assert.rejects(harness.bridge.sendMedia({ ...request, fileName: '../../\r\n' }), /fileName/)
  await assert.rejects(harness.bridge.sendMedia({ ...request, mimetype: 'invalid' }), /mimetype/)
  await assert.rejects(harness.bridge.sendMedia({
    ...request,
    kind: 'video',
    data: Buffer.from('not an mp4'),
    mimetype: 'video/mp4',
    fileName: null
  }), /MP4/)
  await assert.rejects(harness.bridge.sendMedia({ ...request, caption: 'x'.repeat(2001) }), /caption/)
  assert.equal(harness.sendCalls, 0)
  await harness.bridge.stop()
})

test('downloads only stored incoming media within owner and fresh group boundaries after restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-get-media-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '111111111111111@lid'
  const ownerPn = '85255550000@s.whatsapp.net'
  const otherId = '333333333333333@lid'
  const botId = '222222222222222@lid'
  const botPn = '85255551234@s.whatsapp.net'
  const groupId = '120363123456789012@g.us'
  const mediaKey = Buffer.alloc(32, 7)
  const fileEncSha256 = Buffer.alloc(32, 9)
  const ownerData = Buffer.from('owner image bytes')
  const groupData = Buffer.from('group video bytes')
  const urlData = Buffer.from('trusted url bytes')
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId],
    allowOwnerGroups: true
  }), { mode: 0o600 })

  let ownerPresent = true
  const harnessOptions = {
    socketUser: { id: botPn, lid: botId, name: 'Dot' },
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) {
          if (lid === ownerId) return ownerPn
          if (lid === botId) return botPn
          return undefined
        },
        async getLIDForPN(pn) {
          if (pn === ownerPn) return ownerId
          if (pn === botPn) return botId
          return undefined
        }
      }
    },
    groupMetadata: async (chatId) => ({
      id: chatId,
      participants: [
        ...(ownerPresent ? [{ id: ownerPn, lid: ownerId }] : []),
        { id: botPn, lid: botId }
      ]
    }),
    downloadContentFromMessage: async (descriptor) => {
      if (descriptor.directPath === '/v/owner-image') return Readable.from([ownerData.subarray(0, 5), ownerData.subarray(5)])
      if (descriptor.directPath === '/v/group-video') return Readable.from([groupData])
      if (descriptor.directPath === '/v/from-url?token=safe') return Readable.from([urlData])
      if (descriptor.directPath === '/v/oversize') {
        return Readable.from([Buffer.alloc(10 * 1024 * 1024), Buffer.alloc(11 * 1024 * 1024)])
      }
      throw new Error('unexpected descriptor')
    }
  }
  const first = createHarness(dataDir, harnessOptions)
  const received = []
  first.bridge.on('message', (message) => received.push(message))
  await first.bridge.start()
  first.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const media = (type, overrides = {}) => ({
    mimetype: type === 'image' ? 'image/jpeg' : type === 'video' ? 'video/mp4' : 'application/pdf',
    fileName: `../${type}.bin`,
    mediaKey,
    directPath: `/v/${type}`,
    fileLength: 4,
    fileSha256: undefined,
    fileEncSha256,
    ...overrides
  })
  first.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { id: 'owner-image', remoteJid: ownerId, fromMe: false },
        message: { imageMessage: media('image', { directPath: '/v/owner-image', fileLength: ownerData.length, fileSha256: createHash('sha256').update(ownerData).digest() }) }
      },
      {
        key: { id: 'other-image', remoteJid: otherId, fromMe: false },
        message: { imageMessage: media('image', { directPath: '/v/owner-image', fileLength: ownerData.length, fileSha256: createHash('sha256').update(ownerData).digest() }) }
      },
      {
        key: { id: 'group-video', remoteJid: groupId, participant: otherId, fromMe: false },
        message: {
          videoMessage: media('video', {
            directPath: '/v/group-video',
            fileLength: groupData.length,
            fileSha256: createHash('sha256').update(groupData).digest(),
            contextInfo: { mentionedJid: [botId] }
          })
        }
      },
      {
        key: { id: 'group-document', remoteJid: groupId, participant: otherId, fromMe: false },
        message: {
          documentMessage: media('document', {
            contextInfo: { stanzaId: 'group-video', participant: otherId, quotedMessage: { videoMessage: {} } }
          })
        }
      },
      {
        key: { id: 'declared-too-large', remoteJid: groupId, participant: otherId, fromMe: false },
        message: { documentMessage: media('document', { fileLength: 20 * 1024 * 1024 + 1 }) }
      },
      {
        key: { id: 'oversize-stream', remoteJid: groupId, participant: otherId, fromMe: false },
        message: { documentMessage: media('document', { directPath: '/v/oversize', fileLength: undefined }) }
      },
      {
        key: { id: 'path-attack', remoteJid: groupId, participant: otherId, fromMe: false },
        message: { imageMessage: media('image', { directPath: '//evil.invalid/media' }) }
      },
      {
        key: { id: 'trusted-url', remoteJid: groupId, participant: otherId, fromMe: false },
        message: {
          imageMessage: media('image', {
            directPath: undefined,
            url: 'https://mmg.whatsapp.net/v/from-url?token=safe',
            fileLength: urlData.length,
            fileSha256: createHash('sha256').update(urlData).digest()
          })
        }
      }
    ]
  })
  await waitFor(() => received.length === 8)

  const publicGroupVideo = received.find((message) => message.id === 'group-video')
  assert.equal(publicGroupVideo.text, null)
  assert.equal(publicGroupVideo.mentionsBot, true)
  assert.equal(publicGroupVideo.repliesToBot, false)
  assert.equal(Object.hasOwn(publicGroupVideo, '_mediaDownload'), false)
  assert.equal(received.find((message) => message.id === 'group-document').quotedMessageId, 'group-video')
  assert.equal(received.find((message) => message.id === 'group-document').repliesToBot, false)
  assert.equal(Object.hasOwn(first.bridge.getMessages({ chatId: ownerId })[0], '_mediaDownload'), false)
  assert.deepEqual((await first.bridge.getPendingReplies({
    scope: 'groups',
    after: Date.now() - 60_000
  })).map((message) => message.id), ['group-video'])
  const persisted = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8'))
  assert.equal(persisted.messages.some((message) => Object.hasOwn(message, '_mediaDownload')), false)
  assert.equal(Object.keys(persisted.mediaDownloads).length, 7)
  assert.equal(JSON.stringify(persisted).includes(ownerData.toString()), false)
  await first.bridge.stop()

  const second = createHarness(dataDir, harnessOptions)
  await second.bridge.start()
  second.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const ownerMedia = await second.bridge.getMedia({ chatId: ownerId, messageId: 'owner-image' })
  assert.deepEqual(ownerMedia, {
    data: ownerData,
    mimetype: 'image/jpeg',
    fileName: 'image.bin',
    mediaType: 'image'
  })
  assert.deepEqual(second.downloadCalls[0][0], { mediaKey, directPath: '/v/owner-image' })
  assert.equal(second.downloadCalls[0][1], 'image')
  assert.equal(second.downloadCalls[0][2].options.timeout, 30_000)
  assert.equal(second.downloadCalls[0][2].options.maxRedirects, 0)
  assert.equal(second.downloadCalls[0][2].options.signal instanceof AbortSignal, true)
  await assert.rejects(
    second.bridge.getMedia({ chatId: otherId, messageId: 'other-image' }),
    /not allowed/
  )
  assert.equal(second.downloadCalls.length, 1)

  assert.deepEqual(await second.bridge.getMedia({ chatId: groupId, messageId: 'group-video' }), {
    data: groupData,
    mimetype: 'video/mp4',
    fileName: 'video.bin',
    mediaType: 'video'
  })
  assert.deepEqual((await second.bridge.getMedia({ chatId: groupId, messageId: 'trusted-url' })).data, urlData)
  await assert.rejects(
    second.bridge.getMedia({ chatId: groupId, messageId: 'declared-too-large' }),
    /20 MiB/
  )
  await assert.rejects(
    second.bridge.getMedia({ chatId: groupId, messageId: 'oversize-stream' }),
    /20 MiB/
  )
  await assert.rejects(
    second.bridge.getMedia({ chatId: groupId, messageId: 'path-attack' }),
    /unavailable/
  )
  ownerPresent = false
  await assert.rejects(
    second.bridge.getMedia({ chatId: groupId, messageId: 'group-video' }),
    /not allowed/
  )
  await second.bridge.stop()
})

test('migrates legacy per-message download descriptors before exposing messages and survives restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-media-migration-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '111111111111111@lid'
  const data = Buffer.from('legacy private media')
  const mediaKey = Buffer.alloc(32, 4)
  const descriptor = {
    mediaKey: mediaKey.toString('base64'),
    directPath: '/v/legacy-media',
    fileLength: data.length,
    fileSha256: createHash('sha256').update(data).digest('base64'),
    fileEncSha256: Buffer.alloc(32, 5).toString('base64')
  }
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId]
  }), { mode: 0o600 })
  await writeFile(join(dataDir, 'store.json'), JSON.stringify({
    version: 1,
    messages: [{
      id: 'legacy-media',
      chatId: ownerId,
      senderId: ownerId,
      direction: 'incoming',
      fromMe: false,
      timestamp: Date.now(),
      text: null,
      mediaType: 'image',
      media: { mimetype: 'image/jpeg', fileName: 'legacy.jpg' },
      _mediaDownload: descriptor
    }],
    chats: {},
    idempotency: {}
  }), { mode: 0o600 })
  const options = {
    downloadContentFromMessage: async () => Readable.from([data])
  }

  const first = createHarness(dataDir, options)
  await first.bridge.start()
  const migrated = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8'))
  assert.equal((await stat(join(dataDir, 'store.json'))).mode & 0o777, 0o600)
  assert.equal(Object.hasOwn(migrated.messages[0], '_mediaDownload'), false)
  assert.equal(JSON.stringify({ ...migrated.messages[0] }).includes(mediaKey.toString('base64')), false)
  assert.equal(Object.keys(migrated.mediaDownloads).length, 1)
  assert.equal(Object.keys(migrated.mediaDownloads)[0].length, 64)
  assert.deepEqual(migrated.mediaDownloads[Object.keys(migrated.mediaDownloads)[0]], descriptor)
  assert.equal(Object.hasOwn(first.bridge.getMessages({ chatId: ownerId })[0], '_mediaDownload'), false)
  first.sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.deepEqual((await first.bridge.getMedia({ chatId: ownerId, messageId: 'legacy-media' })).data, data)
  await first.bridge.stop()

  const second = createHarness(dataDir, options)
  await second.bridge.start()
  second.sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.deepEqual((await second.bridge.getMedia({ chatId: ownerId, messageId: 'legacy-media' })).data, data)
  await second.bridge.stop()
})

test('keys media descriptors by chat and message while pruning them with bounded messages', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-media-map-bounds-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '111111111111111@lid'
  const ownerPn = '85255550000@s.whatsapp.net'
  const botId = '222222222222222@lid'
  const botPn = '85255551234@s.whatsapp.net'
  const groupId = '120363123456789012@g.us'
  const directData = Buffer.from('direct same id')
  const groupData = Buffer.from('group same id')
  const newestData = Buffer.from('newest media')
  const mediaKey = Buffer.alloc(32, 6)
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId],
    allowOwnerGroups: true
  }), { mode: 0o600 })
  const dataByPath = new Map([
    ['/v/direct-same', directData],
    ['/v/group-same', groupData],
    ['/v/newest', newestData]
  ])
  const harness = createHarness(dataDir, {
    options: { maxMessages: 2 },
    socketUser: { id: botPn, lid: botId, name: 'Dot' },
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) { return lid === ownerId ? ownerPn : lid === botId ? botPn : undefined },
        async getLIDForPN(pn) { return pn === ownerPn ? ownerId : pn === botPn ? botId : undefined }
      }
    },
    groupMetadata: async (chatId) => ({
      id: chatId,
      participants: [{ id: ownerPn, lid: ownerId }, { id: botPn, lid: botId }]
    }),
    downloadContentFromMessage: async ({ directPath }) => Readable.from([dataByPath.get(directPath)])
  })
  const received = []
  harness.bridge.on('message', (message) => received.push(message))
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const now = Date.now()
  const imageMessage = (directPath, data) => ({
    mimetype: 'image/jpeg',
    mediaKey,
    directPath,
    fileLength: data.length,
    fileSha256: createHash('sha256').update(data).digest(),
    fileEncSha256: Buffer.alloc(32, 7)
  })
  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { id: 'same-id', remoteJid: ownerId, fromMe: false },
        messageTimestamp: now,
        message: { imageMessage: imageMessage('/v/direct-same', directData) }
      },
      {
        key: { id: 'same-id', remoteJid: groupId, participant: ownerId, fromMe: false },
        messageTimestamp: now + 1,
        message: { imageMessage: imageMessage('/v/group-same', groupData) }
      }
    ]
  })
  await waitFor(() => received.length === 2)
  assert.deepEqual((await harness.bridge.getMedia({ chatId: ownerId, messageId: 'same-id' })).data, directData)
  assert.deepEqual((await harness.bridge.getMedia({ chatId: groupId, messageId: 'same-id' })).data, groupData)
  let persisted = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8'))
  assert.equal(Object.keys(persisted.mediaDownloads).length, 2)

  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'newest', remoteJid: ownerId, fromMe: false },
      messageTimestamp: now + 2,
      message: { imageMessage: imageMessage('/v/newest', newestData) }
    }]
  })
  await waitFor(() => received.length === 3)
  persisted = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8'))
  assert.deepEqual(persisted.messages.map((message) => [message.chatId, message.id]), [
    [ownerId, 'newest'],
    [groupId, 'same-id']
  ])
  assert.equal(Object.keys(persisted.mediaDownloads).length, 2)
  assert.deepEqual(Object.values(persisted.mediaDownloads).map((item) => item.directPath).sort(), ['/v/group-same', '/v/newest'])
  await assert.rejects(harness.bridge.getMedia({ chatId: ownerId, messageId: 'same-id' }), /unavailable/)
  await harness.bridge.stop()
})

test('reconnects with bounded delay, but never reconnects after logged out', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-reconnect-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const harness = createHarness(dataDir)
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 500 } } }
  })
  await waitFor(() => harness.sockets.length === 2)
  harness.sockets[1].ev.emit('connection.update', {
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode: 401 } } }
  })
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(harness.sockets.length, 2)
  assert.deepEqual(harness.bridge.getStatus(), {
    status: 'logged_out',
    account: null,
    paired: false,
    owner: { valid: false, count: 0, directMessagesOnly: true, allowOwnerGroups: false }
  })
  await harness.bridge.stop()
})

test('keeps paired true for persisted me.id and after connected credential updates', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-paired-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const creds = { registered: false, me: { id: '85255551234@s.whatsapp.net', name: 'Dot' } }
  let saves = 0
  const harness = createHarness(dataDir, {
    authStateFactory: async (authDir) => {
      await writeFile(join(authDir, 'creds.json'), '{}', { mode: 0o644 })
      return {
        state: { creds, keys: {} },
        async saveCreds() { saves += 1 }
      }
    }
  })

  await harness.bridge.start()
  assert.equal(harness.bridge.getStatus().paired, true)
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  delete creds.me
  harness.sockets[0].ev.emit('creds.update', { registered: false })
  await waitFor(() => saves === 1)
  assert.deepEqual(harness.bridge.getStatus(), {
    status: 'connected',
    account: { id: '85255551234@s.whatsapp.net', name: 'Dot' },
    paired: true,
    owner: { valid: false, count: 0, directMessagesOnly: true, allowOwnerGroups: false }
  })
  await harness.bridge.stop()
})

test('enforces retention and count bounds in the persisted store', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-bounds-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const harness = createHarness(dataDir, { options: { maxMessages: 2, retentionDays: 7 } })
  const received = []
  harness.bridge.on('message', (message) => received.push(message))
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const now = Math.floor(Date.now() / 1000)
  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { id: 'expired', remoteJid: '85255550001@s.whatsapp.net', fromMe: false }, messageTimestamp: now - 8 * 86400, message: { conversation: 'expired' } },
      { key: { id: 'new-1', remoteJid: '85255550002@s.whatsapp.net', fromMe: false }, messageTimestamp: now - 2, message: { conversation: 'new 1' } },
      { key: { id: 'new-2', remoteJid: '85255550003@s.whatsapp.net', fromMe: false }, messageTimestamp: now - 1, message: { conversation: 'new 2' } },
      { key: { id: 'new-3', remoteJid: '85255550004@s.whatsapp.net', fromMe: false }, messageTimestamp: now, message: { conversation: 'new 3' } }
    ]
  })
  await waitFor(() => received.length === 4)
  assert.deepEqual(harness.bridge.listChats().map((chat) => chat.id), [
    '85255550004@s.whatsapp.net',
    '85255550003@s.whatsapp.net'
  ])
  const persisted = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8'))
  assert.deepEqual(persisted.messages.map((message) => message.id), ['new-3', 'new-2'])
  await harness.bridge.stop()
})

test('rejects unsupported recipients, oversized text, and unsafe idempotency keys', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-validation-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const harness = createHarness(dataDir)
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  await assert.rejects(
    harness.bridge.sendText({ chatId: 'status@broadcast', text: 'x', idempotencyKey: 'safe' }),
    /chatId/
  )
  await assert.rejects(
    harness.bridge.sendText({ chatId: '85255550000@s.whatsapp.net', text: 'x'.repeat(8001), idempotencyKey: 'safe' }),
    /text/
  )
  await assert.rejects(
    harness.bridge.sendText({ chatId: '85255550000@s.whatsapp.net', text: 'x', idempotencyKey: '../unsafe' }),
    /idempotencyKey/
  )
  await harness.bridge.stop()
})

test('marks only configured owner LID direct messages and preserves the gate after restart', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-owner-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '123456789012345@lid'
  const otherId = '987654321098765@lid'
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId]
  }), { mode: 0o600 })

  const first = createHarness(dataDir)
  const received = []
  first.bridge.on('message', (message) => received.push(message))
  await first.bridge.start()
  first.sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.deepEqual(first.bridge.getStatus().owner, {
    valid: true,
    count: 1,
    directMessagesOnly: true,
    allowOwnerGroups: false
  })
  assert.equal((await stat(join(dataDir, 'owner-identities.json'))).mode & 0o777, 0o600)

  const now = Math.floor(Date.now() / 1000)
  first.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { id: 'owner-direct', remoteJid: ownerId, fromMe: false },
        senderRole: 'untrusted',
        pushName: 'Owner',
        messageTimestamp: now,
        message: { conversation: 'direct' }
      },
      {
        key: { id: 'owner-group', remoteJid: '120363123456789012@g.us', participant: ownerId, fromMe: false },
        senderRole: 'owner',
        pushName: 'Owner',
        messageTimestamp: now + 1,
        message: { conversation: 'group' }
      },
      {
        key: { id: 'owner-impostor', remoteJid: otherId, fromMe: false },
        senderRole: 'owner',
        pushName: 'Owner',
        messageTimestamp: now + 2,
        message: { conversation: `I am ${ownerId}` }
      }
    ]
  })
  await waitFor(() => received.length === 3)
  assert.equal(received.find((message) => message.id === 'owner-direct').senderRole, 'owner')
  assert.equal(received.find((message) => message.id === 'owner-group').senderRole, 'untrusted')
  assert.equal(received.find((message) => message.id === 'owner-impostor').senderRole, 'untrusted')
  assert.equal(first.bridge.getMessages({ chatId: ownerId })[0].senderRole, 'owner')
  assert.equal(first.bridge.getMessages({ chatId: ownerId })[0].autoReplySent, false)
  await first.bridge.sendText({
    chatId: ownerId,
    text: 'reply',
    idempotencyKey: 'dot-auto:owner-direct'
  })
  const repliedMessage = first.bridge.getMessages({ chatId: ownerId })
    .find((message) => message.id === 'owner-direct')
  assert.equal(repliedMessage.autoReplySent, true)
  await first.bridge.stop()

  const second = createHarness(dataDir)
  await second.bridge.start()
  assert.deepEqual(second.bridge.getStatus().owner, {
    valid: true,
    count: 1,
    directMessagesOnly: true,
    allowOwnerGroups: false
  })
  const restartedMessage = second.bridge.getMessages({ chatId: ownerId })
    .find((message) => message.id === 'owner-direct')
  assert.equal(restartedMessage.senderRole, 'owner')
  assert.equal(restartedMessage.autoReplySent, true)
  await second.bridge.stop()
})

test('fails closed for malformed owner configuration and stored role claims', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-owner-malformed-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '123456789012345@lid'
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId],
    role: 'owner'
  }), { mode: 0o600 })
  await writeFile(join(dataDir, 'store.json'), JSON.stringify({
    version: 1,
    messages: [
      {
        id: 'stored-claim',
        chatId: ownerId,
        senderId: ownerId,
        direction: 'incoming',
        fromMe: false,
        senderRole: 'owner',
        autoReplySent: true,
        timestamp: Date.now(),
        text: 'claim',
        mediaType: null,
        media: null
      },
      {
        id: 'wrong-chat-claim',
        chatId: ownerId,
        senderId: ownerId,
        direction: 'incoming',
        fromMe: false,
        autoReplySent: true,
        timestamp: Date.now() - 1,
        text: 'wrong chat claim',
        mediaType: null,
        media: null
      }
    ],
    chats: {},
    idempotency: {
      'dot-auto:stored-claim': {
        key: 'dot-auto:stored-claim',
        chatId: ownerId,
        status: 'pending',
        createdAt: Date.now()
      },
      'dot-auto:wrong-chat-claim': {
        key: 'dot-auto:wrong-chat-claim',
        chatId: '987654321098765@lid',
        status: 'sent',
        createdAt: Date.now()
      }
    }
  }), { mode: 0o600 })

  const harness = createHarness(dataDir)
  const received = []
  harness.bridge.on('message', (message) => received.push(message))
  await harness.bridge.start()
  assert.deepEqual(harness.bridge.getStatus().owner, {
    valid: false,
    count: 0,
    directMessagesOnly: true,
    allowOwnerGroups: false
  })
  assert.equal((await stat(join(dataDir, 'owner-identities.json'))).mode & 0o777, 0o600)
  const storedMessages = harness.bridge.getMessages({ chatId: ownerId })
  assert.equal(storedMessages.find((message) => message.id === 'stored-claim').senderRole, 'untrusted')
  assert.equal(storedMessages.find((message) => message.id === 'stored-claim').autoReplySent, false)
  assert.equal(storedMessages.find((message) => message.id === 'wrong-chat-claim').autoReplySent, false)

  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{
      key: { id: 'live-claim', remoteJid: ownerId, fromMe: false },
      senderRole: 'owner',
      pushName: 'Owner',
      message: { conversation: 'owner' }
    }]
  })
  await waitFor(() => received.length === 1)
  assert.equal(received[0].senderRole, 'untrusted')
  await harness.bridge.stop()
})

test('rejects insecure or oversized owner configuration without changing permissions', async (t) => {
  const ownerId = '123456789012345@lid'
  const config = JSON.stringify({ version: 1, ownerIds: [ownerId] })

  const insecureDir = await mkdtemp(join(tmpdir(), 'baileys-owner-insecure-'))
  t.after(() => rm(insecureDir, { recursive: true, force: true }))
  const insecureFile = join(insecureDir, 'owner-identities.json')
  await writeFile(insecureFile, config, { mode: 0o644 })
  const insecure = createHarness(insecureDir)
  await insecure.bridge.start()
  assert.deepEqual(insecure.bridge.getStatus().owner, {
    valid: false,
    count: 0,
    directMessagesOnly: true,
    allowOwnerGroups: false
  })
  assert.equal((await stat(insecureFile)).mode & 0o777, 0o644)
  await insecure.bridge.stop()

  const oversizedDir = await mkdtemp(join(tmpdir(), 'baileys-owner-oversized-'))
  t.after(() => rm(oversizedDir, { recursive: true, force: true }))
  await writeFile(join(oversizedDir, 'owner-identities.json'), `${config}${' '.repeat(4097)}`, { mode: 0o600 })
  const oversized = createHarness(oversizedDir)
  await oversized.bridge.start()
  assert.deepEqual(oversized.bridge.getStatus().owner, {
    valid: false,
    count: 0,
    directMessagesOnly: true,
    allowOwnerGroups: false
  })
  await oversized.bridge.stop()

  const malformedGroupDir = await mkdtemp(join(tmpdir(), 'baileys-owner-groups-malformed-'))
  t.after(() => rm(malformedGroupDir, { recursive: true, force: true }))
  const duplicateGroup = '120363123456789012@g.us'
  await writeFile(join(malformedGroupDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId],
    allowOwnerGroups: true,
    mentionOnlyGroupIds: [duplicateGroup, duplicateGroup]
  }), { mode: 0o600 })
  const malformedGroup = createHarness(malformedGroupDir)
  await malformedGroup.bridge.start()
  assert.equal(malformedGroup.bridge.getStatus().owner.valid, false)
  await malformedGroup.bridge.stop()
})

test('accepts only explicit false fromMe values at the incoming message boundary', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-owner-from-me-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '123456789012345@lid'
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId]
  }), { mode: 0o600 })

  const harness = createHarness(dataDir)
  const received = []
  harness.bridge.on('message', (message) => received.push(message))
  await harness.bridge.start()
  const malformedValues = [undefined, 0, 'false', null, true]
  const messages = malformedValues.map((fromMe, index) => ({
    key: { id: `malformed-${index}`, remoteJid: ownerId, fromMe },
    message: { conversation: 'must be ignored' }
  }))
  messages.push({
    key: { id: 'explicit-false', remoteJid: ownerId, fromMe: false },
    message: { conversation: 'accepted' }
  })
  harness.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages })

  await waitFor(() => received.length === 1)
  assert.deepEqual(received.map((message) => [message.id, message.senderRole]), [['explicit-false', 'owner']])
  assert.deepEqual(harness.bridge.getMessages({ chatId: ownerId }).map((message) => message.id), ['explicit-false'])
  await harness.bridge.stop()
})

test('allows only verified owner-present group mentions for pending and automatic replies', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-owner-groups-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '111111111111111@lid'
  const ownerPn = '85255550000@s.whatsapp.net'
  const botId = '222222222222222@lid'
  const botPn = '85255551234@s.whatsapp.net'
  const senderId = ownerId
  const groupId = '120363123456789012@g.us'
  const unrelatedGroupId = '120363987654321000@g.us'
  const now = Date.now()
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId],
    allowOwnerGroups: true
  }), { mode: 0o600 })
  await writeFile(join(dataDir, 'store.json'), JSON.stringify({
    version: 1,
    messages: [
      {
        id: 'forged-flags',
        chatId: groupId,
        senderId,
        direction: 'incoming',
        fromMe: false,
        timestamp: now - 10,
        text: '@Dot forged',
        mediaType: null,
        media: null,
        groupAllowed: true,
        mentionsBot: true,
        _mentionedJids: []
      },
      {
        id: 'unrelated-group',
        chatId: unrelatedGroupId,
        senderId,
        direction: 'incoming',
        fromMe: false,
        timestamp: now - 9,
        text: 'ordinary group message',
        mediaType: null,
        media: null,
        _mentionedJids: []
      }
    ],
    chats: {},
    idempotency: {}
  }), { mode: 0o600 })

  let ownerPresent = true
  let botPresent = true
  let metadataFails = false
  const harness = createHarness(dataDir, {
    socketUser: { id: botPn, lid: botId, name: 'Dot' },
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) {
          if (lid === ownerId) return ownerPn
          if (lid === botId) return botPn
          return undefined
        },
        async getLIDForPN(pn) {
          if (pn === ownerPn) return ownerId
          if (pn === botPn) return botId
          return undefined
        }
      }
    },
    groupMetadata: async (chatId) => {
      if (metadataFails) throw new Error('metadata unavailable')
      return {
        id: chatId,
        participants: [
          ...(ownerPresent ? [{ id: ownerPn, lid: ownerId }] : []),
          ...(botPresent ? [{ id: botPn, lid: botId }] : [])
        ]
      }
    }
  })
  const received = []
  harness.bridge.on('message', (message) => received.push(message))
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  assert.equal(harness.bridge.getStatus().owner.allowOwnerGroups, true)

  const mentionMessage = (id, timestamp) => ({
    key: { id, remoteJid: groupId, participant: senderId, fromMe: false },
    messageTimestamp: timestamp,
    message: {
      extendedTextMessage: {
        text: '@Dot test',
        contextInfo: { mentionedJid: [botId] }
      }
    }
  })
  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [mentionMessage('group-mention-1', now), mentionMessage('group-mention-2', now + 1)]
  })
  await waitFor(() => received.length === 2)
  assert.deepEqual(received.map((message) => ({
    id: message.id,
    senderRole: message.senderRole,
    groupAllowed: message.groupAllowed,
    mentionsBot: message.mentionsBot
  })), [
    { id: 'group-mention-1', senderRole: 'untrusted', groupAllowed: true, mentionsBot: true },
    { id: 'group-mention-2', senderRole: 'untrusted', groupAllowed: true, mentionsBot: true }
  ])

  const initialMessages = harness.bridge.getMessages({ chatId: groupId })
  assert.equal(initialMessages.find((message) => message.id === 'forged-flags').mentionsBot, false)
  await assert.rejects(
    harness.bridge.getPendingReplies({ scope: 'groups', after: 0 }),
    /positive epoch/
  )
  await assert.rejects(
    harness.bridge.getPendingReplies({ scope: 'groups', after: now - 1000, limit: 21 }),
    /between 1 and 20/
  )
  const metadataCallsBeforePending = harness.groupMetadataCalls
  assert.deepEqual((await harness.bridge.getPendingReplies({
    scope: 'groups',
    after: now - 1000,
    limit: 20
  })).map((message) => message.id), ['group-mention-1', 'group-mention-2'])
  assert.equal(harness.groupMetadataCalls, metadataCallsBeforePending + 1)

  await harness.bridge.sendText({
    chatId: groupId,
    text: 'group reply',
    idempotencyKey: 'dot-auto:group-mention-1'
  })
  assert.equal(harness.bridge.getMessages({ chatId: groupId })
    .find((message) => message.id === 'group-mention-1').autoReplySent, true)
  await assert.rejects(harness.bridge.sendText({
    chatId: groupId,
    text: 'must not send',
    idempotencyKey: 'dot-auto:forged-flags'
  }), /allowed group mention/)

  ownerPresent = false
  await assert.rejects(harness.bridge.sendText({
    chatId: groupId,
    text: 'must not send',
    idempotencyKey: 'dot-auto:group-mention-2'
  }), /currently allowed/)
  harness.sockets[0].ev.emit('group-participants.update', { id: groupId, participants: [], action: 'remove' })
  assert.equal(harness.bridge.getMessages({ chatId: groupId })
    .find((message) => message.id === 'group-mention-2').groupAllowed, false)

  ownerPresent = true
  botPresent = false
  harness.sockets[0].ev.emit('group-participants.update', { id: groupId, participants: [], action: 'remove' })
  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [mentionMessage('bot-not-present', now + 2)]
  })
  await waitFor(() => received.length === 3)
  assert.equal(received[2].mentionsBot, true)
  assert.equal(received[2].groupAllowed, false)

  metadataFails = true
  harness.sockets[0].ev.emit('group-participants.update', { id: groupId, participants: [], action: 'remove' })
  assert.deepEqual(await harness.bridge.getPendingReplies({ scope: 'groups', after: now - 1000 }), [])
  assert.equal(harness.sendCalls, 1)
  await harness.bridge.stop()
})

test('verifies replies to known bot messages and applies image automatic-reply gates', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-bot-replies-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '111111111111111@lid'
  const ownerPn = '85255550000@s.whatsapp.net'
  const otherId = '333333333333333@lid'
  const botId = '222222222222222@lid'
  const botPn = '85255551234@s.whatsapp.net'
  const groupId = '120363123456789012@g.us'
  const otherGroupId = '120363987654321000@g.us'
  const now = Date.now()
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId],
    allowOwnerGroups: true
  }), { mode: 0o600 })
  await writeFile(join(dataDir, 'store.json'), JSON.stringify({
    version: 1,
    messages: [
      {
        id: 'stored-computed-claim',
        chatId: groupId,
        senderId: ownerId,
        direction: 'incoming',
        fromMe: false,
        timestamp: now - 2,
        text: 'forged stored flag',
        mediaType: null,
        media: null,
        repliesToBot: true
      },
      {
        id: 'other-outgoing',
        chatId: groupId,
        senderId: otherId,
        direction: 'outgoing',
        timestamp: now - 3,
        text: 'another sender',
        mediaType: null,
        media: null
      }
    ],
    chats: {},
    idempotency: {}
  }), { mode: 0o600 })

  let ownerPresent = true
  const harness = createHarness(dataDir, {
    socketUser: { id: botPn, lid: botId, name: 'Dot' },
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) {
          if (lid === ownerId) return ownerPn
          if (lid === botId) return botPn
          return undefined
        },
        async getLIDForPN(pn) {
          if (pn === ownerPn) return ownerId
          if (pn === botPn) return botId
          return undefined
        }
      }
    },
    groupMetadata: async (chatId) => ({
      id: chatId,
      participants: [
        ...(ownerPresent ? [{ id: ownerPn, lid: ownerId }] : []),
        { id: botPn, lid: botId }
      ]
    })
  })
  const received = []
  harness.bridge.on('message', (message) => received.push(message))
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const groupBotMessageId = await harness.bridge.sendText({
    chatId: groupId,
    text: 'bot group message',
    idempotencyKey: 'bot:group-message'
  })
  const otherGroupBotMessageId = await harness.bridge.sendText({
    chatId: otherGroupId,
    text: 'other group message',
    idempotencyKey: 'bot:other-group-message'
  })

  const reply = (id, stanzaId, participant = botId, quotedMessage = { conversation: 'untrusted quoted body' }) => ({
    key: { id, remoteJid: groupId, participant: ownerId, fromMe: false },
    messageTimestamp: now + 10,
    message: {
      extendedTextMessage: {
        text: `reply ${id}`,
        contextInfo: { stanzaId, participant, quotedMessage }
      }
    }
  })
  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      reply('valid-reply', groupBotMessageId),
      reply('valid-reply-2', groupBotMessageId, botPn),
      reply('other-reply', 'other-outgoing', otherId),
      reply('unknown-reply', 'unknown-message'),
      reply('cross-chat-reply', otherGroupBotMessageId),
      reply('forged-body-reply', 'unknown-forged', botId, { conversation: 'bot group message' }),
      reply('missing-participant', groupBotMessageId, null)
    ]
  })
  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      {
        key: { id: 'owner-direct-image', remoteJid: ownerId, fromMe: false },
        messageTimestamp: now + 11,
        message: { conversation: 'send image' }
      },
      {
        key: { id: 'other-direct-image', remoteJid: otherId, fromMe: false },
        messageTimestamp: now + 12,
        message: { conversation: 'must not send image' }
      }
    ]
  })
  await waitFor(() => received.length === 9)

  const byId = Object.fromEntries(received.map((message) => [message.id, message]))
  assert.equal(byId['valid-reply'].mentionsBot, false)
  assert.equal(byId['valid-reply'].repliesToBot, true)
  assert.equal(byId['valid-reply'].senderRole, 'untrusted')
  for (const id of ['other-reply', 'unknown-reply', 'cross-chat-reply', 'forged-body-reply', 'missing-participant']) {
    assert.equal(byId[id].repliesToBot, false)
  }
  assert.equal(harness.bridge.getMessages({ chatId: groupId })
    .find((message) => message.id === 'stored-computed-claim').repliesToBot, false)
  assert.deepEqual((await harness.bridge.getPendingReplies({
    scope: 'groups',
    after: now - 1000
  })).map((message) => message.id).sort(), ['valid-reply', 'valid-reply-2'])

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII='
  await harness.bridge.sendImage({
    chatId: groupId,
    imageBase64: png,
    caption: 'group image reply',
    idempotencyKey: 'dot-auto:valid-reply'
  })
  assert.equal(harness.bridge.getMessages({ chatId: groupId })
    .find((message) => message.id === 'valid-reply').autoReplySent, true)
  await assert.rejects(harness.bridge.sendImage({
    chatId: groupId,
    imageBase64: png,
    idempotencyKey: 'dot-auto:unknown-reply'
  }), /allowed group mention or reply/)

  ownerPresent = false
  await assert.rejects(harness.bridge.sendImage({
    chatId: groupId,
    imageBase64: png,
    idempotencyKey: 'dot-auto:valid-reply-2'
  }), /currently allowed/)
  await harness.bridge.sendImage({
    chatId: ownerId,
    imageBase64: png,
    caption: 'private image reply',
    idempotencyKey: 'dot-auto:owner-direct-image'
  })
  await assert.rejects(harness.bridge.sendImage({
    chatId: otherId,
    imageBase64: png,
    idempotencyKey: 'dot-auto:other-direct-image'
  }), /owner direct message/)
  assert.equal(harness.bridge.getMessages({ chatId: ownerId })
    .find((message) => message.id === 'owner-direct-image').autoReplySent, true)
  await harness.bridge.stop()
})

test('enforces mention-only group writes, mention-all silence, and bounded group info', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'baileys-mention-only-group-'))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const ownerId = '111111111111111@lid'
  const ownerPn = '85255550000@s.whatsapp.net'
  const botId = '222222222222222@lid'
  const botPn = '85255551234@s.whatsapp.net'
  const classId = '120363123456789012@g.us'
  const otherGroupId = '120363987654321000@g.us'
  const now = Date.now()
  await writeFile(join(dataDir, 'owner-identities.json'), JSON.stringify({
    version: 1,
    ownerIds: [ownerId],
    allowOwnerGroups: true,
    mentionOnlyGroupIds: [classId]
  }), { mode: 0o600 })
  await writeFile(join(dataDir, 'store.json'), JSON.stringify({
    version: 1,
    messages: [{
      id: 'known-bot-class-message',
      chatId: classId,
      senderId: botPn,
      direction: 'outgoing',
      timestamp: now - 100,
      text: 'known bot message',
      mediaType: null,
      media: null
    }],
    chats: {},
    idempotency: {}
  }), { mode: 0o600 })

  let ownerPresent = true
  const harness = createHarness(dataDir, {
    socketUser: { id: botPn, lid: botId, name: 'Dot' },
    signalRepository: {
      lidMapping: {
        async getPNForLID(lid) {
          if (lid === ownerId) return ownerPn
          if (lid === botId) return botPn
          return undefined
        },
        async getLIDForPN(pn) {
          if (pn === ownerPn) return ownerId
          if (pn === botPn) return botId
          return undefined
        }
      }
    },
    groupMetadata: async (chatId) => ({
      id: chatId,
      subject: chatId === classId ? 'Class group' : 'Other group',
      desc: chatId === classId ? 'Class announcements and discussion' : null,
      announce: chatId === classId,
      participants: [
        ...(ownerPresent ? [{ id: ownerPn, lid: ownerId }] : []),
        { id: botPn, lid: botId }
      ]
    })
  })
  const received = []
  harness.bridge.on('message', (message) => received.push(message))
  await harness.bridge.start()
  harness.sockets[0].ev.emit('connection.update', { connection: 'open' })
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlVQAAAAASUVORK5CYII='
  const video = Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  await assert.rejects(harness.bridge.sendText({
    chatId: classId,
    text: 'unsolicited',
    idempotencyKey: 'class:normal-text'
  }), /automatic replies/)
  await assert.rejects(harness.bridge.sendImage({
    chatId: classId,
    imageBase64: png,
    idempotencyKey: 'class:normal-image'
  }), /automatic replies/)
  await assert.rejects(harness.bridge.sendMedia({
    chatId: classId,
    kind: 'video',
    data: video,
    mimetype: 'video/mp4',
    idempotencyKey: 'class:normal-video'
  }), /automatic replies/)

  const message = (id, chatId, contextInfo, text = `message ${id}`) => ({
    key: { id, remoteJid: chatId, participant: ownerId, fromMe: false },
    messageTimestamp: now + 10,
    message: { extendedTextMessage: { text, contextInfo } }
  })
  harness.sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      message('class-direct-mention', classId, { mentionedJid: [botId], nonJidMentions: 0 }),
      message('class-quote-only', classId, {
        stanzaId: 'known-bot-class-message',
        participant: botId,
        quotedMessage: { conversation: 'known bot message' }
      }),
      message('class-mention-all', classId, { mentionedJid: [botId], nonJidMentions: 1 }),
      message('class-malformed-mention', classId, { mentionedJid: [botId], nonJidMentions: 2 }),
      message('class-text-everyone', classId, {}, '@everyone please read'),
      {
        key: { id: 'class-media-mention', remoteJid: classId, participant: ownerId, fromMe: false },
        messageTimestamp: now + 11,
        message: { imageMessage: { mimetype: 'image/jpeg', contextInfo: { mentionedJid: [botId] } } }
      },
      message('other-mention-all', otherGroupId, { mentionedJid: [botId], nonJidMentions: 1 })
    ]
  })
  await waitFor(() => received.length === 7)
  const byId = Object.fromEntries(received.map((item) => [item.id, item]))
  assert.deepEqual({
    mentionsBot: byId['class-direct-mention'].mentionsBot,
    mentionsAll: byId['class-direct-mention'].mentionsAll,
    repliesToBot: byId['class-direct-mention'].repliesToBot,
    replyAllowed: byId['class-direct-mention'].replyAllowed
  }, { mentionsBot: true, mentionsAll: false, repliesToBot: false, replyAllowed: true })
  assert.equal(byId['class-quote-only'].repliesToBot, true)
  assert.equal(byId['class-quote-only'].replyAllowed, false)
  assert.equal(byId['class-mention-all'].mentionsBot, true)
  assert.equal(byId['class-mention-all'].mentionsAll, true)
  assert.equal(byId['class-mention-all'].replyAllowed, false)
  assert.equal(byId['class-malformed-mention'].mentionsAll, false)
  assert.equal(byId['class-malformed-mention'].replyAllowed, false)
  assert.equal(byId['class-text-everyone'].replyAllowed, false)
  assert.equal(byId['other-mention-all'].replyAllowed, false)
  assert.deepEqual((await harness.bridge.getPendingReplies({
    scope: 'groups',
    after: now - 1000
  })).map((item) => item.id).sort(), ['class-direct-mention', 'class-media-mention'])

  await harness.bridge.sendText({
    chatId: classId,
    text: 'verified reply',
    idempotencyKey: 'dot-auto:class-direct-mention'
  })
  await harness.bridge.sendMedia({
    chatId: classId,
    kind: 'video',
    data: video,
    mimetype: 'video/mp4',
    caption: 'verified media reply',
    idempotencyKey: 'dot-auto:class-media-mention'
  })
  await assert.rejects(harness.bridge.sendText({
    chatId: classId,
    text: 'quote alone',
    idempotencyKey: 'dot-auto:class-quote-only'
  }), /allowed group mention or reply/)
  await assert.rejects(harness.bridge.sendText({
    chatId: classId,
    text: 'mention all',
    idempotencyKey: 'dot-auto:class-mention-all'
  }), /allowed group mention or reply/)
  await assert.rejects(harness.bridge.sendText({
    chatId: otherGroupId,
    text: 'mention all',
    idempotencyKey: 'dot-auto:other-mention-all'
  }), /allowed group mention or reply/)

  assert.deepEqual(await harness.bridge.getGroupInfo({ chatId: classId }), {
    chatId: classId,
    subject: 'Class group',
    description: 'Class announcements and discussion',
    announcementOnly: true,
    ownerPresent: true,
    botPresent: true
  })
  ownerPresent = false
  await assert.rejects(harness.bridge.getGroupInfo({ chatId: classId }), /not allowed/)
  await harness.bridge.stop()
})
