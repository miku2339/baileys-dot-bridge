import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  let sendCalls = 0
  let endCalls = 0
  let groupMetadataCalls = 0
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
  const bridge = new WhatsAppBridge({
    dataDir,
    logger: silentLogger,
    socketFactory,
    authStateFactory,
    disconnectReason: { loggedOut: 401 },
    reconnectDelayMs: 5,
    reconnectMaxDelayMs: 10,
    ...overrides.options
  })
  return {
    bridge,
    sockets,
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
