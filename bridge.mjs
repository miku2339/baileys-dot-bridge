import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const STORE_VERSION = 1
const STATUS_BROADCAST = 'status@broadcast'
const USER_JID = /^[1-9]\d{4,19}@s\.whatsapp\.net$/
const GROUP_JID = /^[1-9]\d{4,19}(?:-[1-9]\d{4,19})?@g\.us$/
const LID_JID = /^[1-9]\d{4,19}@lid$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_STORED_TEXT_BYTES = 32_000
const OWNER_IDENTITIES_VERSION = 1
const MAX_OWNER_IDENTITIES = 10
const MAX_GROUP_CACHE_ENTRIES = 100
const GROUP_CACHE_TTL_MS = 5 * 60 * 1000

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`)
  }
}

function assertChatId(chatId) {
  if (typeof chatId !== 'string' || !(USER_JID.test(chatId) || GROUP_JID.test(chatId) || LID_JID.test(chatId))) {
    throw new TypeError('chatId must be a WhatsApp user, group, or LID JID')
  }
}

function parseLimit(value, fallback, max) {
  const limit = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`limit must be an integer between 1 and ${max}`)
  }
  return limit
}

function toTimestampMs(value) {
  if (value === null || value === undefined) return Date.now()
  let numeric
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'bigint') numeric = Number(value)
  else if (typeof value === 'string') numeric = Number(value)
  else if (typeof value?.toNumber === 'function') numeric = value.toNumber()
  else if (Number.isInteger(value?.low)) numeric = value.low + (value.high || 0) * 0x100000000
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now()
  return numeric < 1_000_000_000_000 ? Math.trunc(numeric * 1000) : Math.trunc(numeric)
}

function boundedString(value, maxCharacters, maxBytes) {
  if (typeof value !== 'string') return null
  let result = ''
  let characters = 0
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (characters + character.length > maxCharacters || bytes + characterBytes > maxBytes) break
    result += character
    characters += character.length
    bytes += characterBytes
  }
  return result
}

function unwrapMessage(message) {
  let current = message
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const wrapped = current.ephemeralMessage?.message
      ?? current.viewOnceMessage?.message
      ?? current.viewOnceMessageV2?.message
      ?? current.viewOnceMessageV2Extension?.message
      ?? current.documentWithCaptionMessage?.message
      ?? current.editedMessage?.message
    if (!wrapped) break
    current = wrapped
  }
  return current
}

function normalizeIdentityJid(value) {
  if (typeof value !== 'string') return null
  const match = /^([1-9]\d{4,19})(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(value)
  return match ? `${match[1]}@${match[2]}` : null
}

function extractMentionedJids(rawMessage) {
  const message = unwrapMessage(rawMessage)
  const mentionedJids = message?.extendedTextMessage?.contextInfo?.mentionedJid
  if (!Array.isArray(mentionedJids)) return []
  return [...new Set(mentionedJids.map(normalizeIdentityJid).filter(Boolean))].slice(0, 32)
}

function extractContent(rawMessage) {
  const message = unwrapMessage(rawMessage)
  if (!message) return null

  const text = message.conversation
    ?? message.extendedTextMessage?.text
    ?? message.imageMessage?.caption
    ?? message.videoMessage?.caption
    ?? message.documentMessage?.caption
    ?? message.buttonsResponseMessage?.selectedDisplayText
    ?? message.listResponseMessage?.title
    ?? message.templateButtonReplyMessage?.selectedDisplayText
    ?? message.interactiveResponseMessage?.body?.text
    ?? message.interactiveMessage?.body?.text
    ?? null

  const mediaEntries = [
    ['image', message.imageMessage],
    ['video', message.videoMessage],
    ['audio', message.audioMessage],
    ['document', message.documentMessage],
    ['sticker', message.stickerMessage]
  ]
  const mediaEntry = mediaEntries.find(([, value]) => value)
  const mediaType = mediaEntry?.[0] ?? null
  const mediaValue = mediaEntry?.[1]
  if (text === null && mediaType === null) return null

  const media = mediaValue
    ? {
        mimetype: boundedString(mediaValue.mimetype, 128, 512),
        fileName: boundedString(mediaValue.fileName, 255, 1024)
      }
    : null

  return {
    text: boundedString(text, 8000, MAX_STORED_TEXT_BYTES),
    mediaType,
    media
  }
}

function safeError(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    statusCode: disconnectStatusCode(error)
  }
}

function disconnectStatusCode(error) {
  const candidates = [
    error?.output?.statusCode,
    error?.data?.statusCode,
    error?.statusCode,
    error?.cause?.output?.statusCode
  ]
  return candidates.find(Number.isFinite) ?? null
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

function newMessageId() {
  return randomBytes(16).toString('hex').toUpperCase()
}

function credentialsArePaired(authState) {
  return Boolean(authState?.creds?.registered || authState?.creds?.me?.id)
}

function unconfiguredOwnerIdentities() {
  return { valid: false, ownerIds: new Set(), allowOwnerGroups: false }
}

async function loadOwnerIdentities(file) {
  let handle
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    const fileStat = await handle.stat()
    if (!fileStat.isFile() || fileStat.size > 4096 || (fileStat.mode & 0o777) !== 0o600) {
      return unconfiguredOwnerIdentities()
    }
    const parsed = JSON.parse(await handle.readFile('utf8'))
    const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed).sort()
      : []
    const allowedKeys = new Set(['allowOwnerGroups', 'ownerIds', 'version'])
    if (
      keys.length < 2
      || keys.length > 3
      || keys.some((key) => !allowedKeys.has(key))
      || !keys.includes('ownerIds')
      || !keys.includes('version')
      || parsed.version !== OWNER_IDENTITIES_VERSION
      || !Array.isArray(parsed.ownerIds)
      || parsed.ownerIds.length > MAX_OWNER_IDENTITIES
      || parsed.ownerIds.some((ownerId) => typeof ownerId !== 'string' || !LID_JID.test(ownerId))
      || new Set(parsed.ownerIds).size !== parsed.ownerIds.length
      || (parsed.allowOwnerGroups !== undefined && typeof parsed.allowOwnerGroups !== 'boolean')
    ) {
      return unconfiguredOwnerIdentities()
    }
    return {
      valid: true,
      ownerIds: new Set(parsed.ownerIds),
      allowOwnerGroups: parsed.allowOwnerGroups === true
    }
  } catch {
    return unconfiguredOwnerIdentities()
  } finally {
    await handle?.close().catch(() => {})
  }
}

function senderRoleForMessage(message, ownerIds) {
  return message?.fromMe === false
    && message.chatId === message.senderId
    && ownerIds.has(message.senderId)
    ? 'owner'
    : 'untrusted'
}

class BoundedJsonStore {
  constructor({ dataDir, maxMessages, retentionDays }) {
    this.file = join(dataDir, 'store.json')
    this.maxMessages = maxMessages
    this.maxChats = Math.min(maxMessages, 1000)
    this.maxIdempotency = Math.min(maxMessages, 2000)
    this.retentionMs = retentionDays * 24 * 60 * 60 * 1000
    this.data = { version: STORE_VERSION, messages: [], chats: {}, idempotency: {} }
  }

  async load() {
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw new Error('Unable to read message store', { cause: error })
    }
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.messages) || typeof parsed.chats !== 'object' || typeof parsed.idempotency !== 'object') {
      throw new Error('Unsupported or malformed message store')
    }
    this.data = parsed
    this.prune()
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs
    this.data.messages = this.data.messages
      .filter((message) => Number.isFinite(message.timestamp) && message.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.maxMessages)

    const chats = Object.values(this.data.chats)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, this.maxChats)
    this.data.chats = Object.fromEntries(chats.map((chat) => [chat.id, chat]))

    const idempotency = Object.values(this.data.idempotency)
      .filter((entry) => entry.createdAt >= cutoff)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, this.maxIdempotency)
    this.data.idempotency = Object.fromEntries(idempotency.map((entry) => [entry.key, entry]))
  }

  async persist() {
    this.prune()
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(this.data)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.file)
      await chmod(this.file, 0o600)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }

  putMessage(message, chatName) {
    const duplicate = this.data.messages.findIndex((item) => item.id === message.id && item.chatId === message.chatId)
    if (duplicate >= 0) this.data.messages.splice(duplicate, 1)
    this.data.messages.unshift(message)
    const existing = this.data.chats[message.chatId]
    this.data.chats[message.chatId] = {
      id: message.chatId,
      name: chatName || existing?.name || null,
      updatedAt: message.timestamp,
      lastMessage: message.text?.slice(0, 160) || (message.mediaType ? `[${message.mediaType}]` : null)
    }
    this.prune()
    return duplicate < 0
  }

  putChat(chat) {
    const existing = this.data.chats[chat.id]
    this.data.chats[chat.id] = {
      id: chat.id,
      name: chat.name ?? existing?.name ?? null,
      updatedAt: chat.updatedAt ?? existing?.updatedAt ?? Date.now(),
      lastMessage: existing?.lastMessage ?? null
    }
    this.prune()
  }

  deleteChats(chatIds) {
    for (const chatId of chatIds) delete this.data.chats[chatId]
  }

  listChats(limit) {
    return Object.values(this.data.chats)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((chat) => ({ ...chat }))
  }

  getMessages(chatId, limit, before) {
    let messages = this.data.messages.filter((message) => message.chatId === chatId)
    if (before !== undefined && before !== null && before !== '') {
      const cursorMessage = messages.find((message) => message.id === before)
      let cursor = cursorMessage?.timestamp
      if (cursor === undefined) {
        const numeric = typeof before === 'number' ? before : Number(before)
        if (Number.isFinite(numeric) && numeric > 0) cursor = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
        else if (typeof before === 'string') cursor = Date.parse(before)
      }
      if (!Number.isFinite(cursor)) throw new TypeError('before must be a message ID or timestamp')
      messages = messages.filter((message) => message.timestamp < cursor)
    }
    return messages.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit).map((message) => ({ ...message }))
  }

  findTextMessage(key) {
    const message = this.data.messages.find((item) => item.id === key?.id && item.chatId === key?.remoteJid)
    return message?.text ? { conversation: message.text } : undefined
  }
}

export class WhatsAppBridge extends EventEmitter {
  constructor({
    dataDir,
    logger,
    maxMessages = 2000,
    retentionDays = 7,
    socketFactory,
    authStateFactory,
    disconnectReason,
    reconnectDelayMs = 1000,
    reconnectMaxDelayMs = 30000
  } = {}) {
    super()
    if (typeof dataDir !== 'string' || dataDir.length === 0) throw new TypeError('dataDir is required')
    assertPositiveInteger(maxMessages, 'maxMessages')
    assertPositiveInteger(retentionDays, 'retentionDays')
    assertPositiveInteger(reconnectDelayMs, 'reconnectDelayMs')
    assertPositiveInteger(reconnectMaxDelayMs, 'reconnectMaxDelayMs')

    this.dataDir = resolve(dataDir)
    this.authDir = join(this.dataDir, 'auth')
    this.ownerIdentitiesFile = join(this.dataDir, 'owner-identities.json')
    this.logger = logger
    this.maxMessages = maxMessages
    this.retentionDays = retentionDays
    this.socketFactory = socketFactory
    this.authStateFactory = authStateFactory
    this.disconnectReason = disconnectReason
    this.reconnectDelayMs = reconnectDelayMs
    this.reconnectMaxDelayMs = reconnectMaxDelayMs

    this.store = new BoundedJsonStore({ dataDir: this.dataDir, maxMessages, retentionDays })
    this.status = 'stopped'
    this.account = null
    this.qr = null
    this.paired = false
    this.socket = null
    this.authState = null
    this.saveCreds = null
    this.started = false
    this.generation = 0
    this.reconnectAttempt = 0
    this.reconnectTimer = null
    this.mutationQueue = Promise.resolve()
    this.sendQueue = Promise.resolve()
    this.authSaveQueue = Promise.resolve()
    this.ownerIdentities = unconfiguredOwnerIdentities()
    this.groupMetadataCache = new Map()
    this.botIdentityIds = new Set()
  }

  async start() {
    if (this.started) return this.getStatus()
    this.started = true
    this.status = 'starting'
    try {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 })
      await chmod(this.dataDir, 0o700)
      await mkdir(this.authDir, { recursive: true, mode: 0o700 })
      await chmod(this.authDir, 0o700)
      this.ownerIdentities = await loadOwnerIdentities(this.ownerIdentitiesFile)
      await this.store.load()
      await this._loadDependencies()
      const auth = await this.authStateFactory(this.authDir)
      this.authState = auth.state
      this.saveCreds = auth.saveCreds
      this.paired = credentialsArePaired(auth.state)
      await this._hardenAuthFiles()
      await this._connect()
      return this.getStatus()
    } catch (error) {
      this.started = false
      this.status = 'stopped'
      throw error
    }
  }

  async stop() {
    this.started = false
    this.status = 'stopped'
    this.qr = null
    this.generation += 1
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.groupMetadataCache.clear()
    const socket = this.socket
    this.socket = null
    try {
      if (socket?.end) await socket.end(new Error('Bridge stopped'))
      else if (socket?.ws?.close) socket.ws.close()
    } catch (error) {
      this._logError('Failed to close WhatsApp socket cleanly', error)
    }
    await Promise.allSettled([this.mutationQueue, this.sendQueue, this.authSaveQueue])
    return this.getStatus()
  }

  getStatus() {
    return {
      status: this.status,
      account: this.account ? { ...this.account } : null,
      paired: this.paired,
      owner: {
        valid: this.ownerIdentities.valid,
        count: this.ownerIdentities.ownerIds.size,
        directMessagesOnly: true,
        allowOwnerGroups: this.ownerIdentities.allowOwnerGroups
      }
    }
  }

  getQr() {
    return this.qr
  }

  listChats({ limit = 50 } = {}) {
    return this.store.listChats(parseLimit(limit, 50, 200))
  }

  getMessages({ chatId, limit = 30, before } = {}) {
    assertChatId(chatId)
    return this.store.getMessages(chatId, parseLimit(limit, 30, 200), before)
      .map((message) => this._messageView(message))
  }

  async getPendingReplies({ scope, after, limit = 20 } = {}) {
    if (scope !== 'groups') throw new TypeError('scope must be groups')
    if (!Number.isSafeInteger(after) || after < 1) throw new TypeError('after must be a positive epoch millisecond integer')
    const parsedLimit = parseLimit(limit, 20, 20)
    if (!this.ownerIdentities.valid || !this.ownerIdentities.allowOwnerGroups) return []

    this._refreshBotIdentitySeeds()
    this.botIdentityIds = await this._identityAliases(this.botIdentityIds)
    const candidates = this.store.data.messages
      .filter((message) => GROUP_JID.test(message.chatId) && message.timestamp > after && message.fromMe === false)
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((message) => {
        const view = this._messageView(message, { groupAllowed: false })
        return view.mentionsBot && !view.autoReplySent && typeof view.text === 'string' && view.text.length > 0
      })
    const accessByChat = new Map()
    const pending = []
    for (const message of candidates) {
      if (!accessByChat.has(message.chatId)) {
        accessByChat.set(message.chatId, await this._getGroupAccess(message.chatId, { fresh: true }))
      }
      const view = this._messageView(message, { groupAllowed: accessByChat.get(message.chatId) })
      if (view.groupAllowed) {
        pending.push(view)
        if (pending.length >= parsedLimit) break
      }
    }
    return pending
  }

  async sendText({ chatId, text, idempotencyKey } = {}) {
    assertChatId(chatId)
    if (typeof text !== 'string' || text.length < 1 || text.length > 8000) {
      throw new TypeError('text must contain between 1 and 8000 characters')
    }
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new TypeError('idempotencyKey must contain 1-128 safe characters')
    }

    const operation = this.sendQueue.then(() => this._sendTextLocked({ chatId, text, idempotencyKey }))
    this.sendQueue = operation.catch(() => {})
    return operation
  }

  async _sendTextLocked({ chatId, text, idempotencyKey }) {
    if (!this.started || this.status !== 'connected' || !this.socket) {
      throw new Error('WhatsApp is not connected')
    }
    const textHash = hashText(text)
    let entry = this.store.data.idempotency[idempotencyKey]
    if (entry && (entry.chatId !== chatId || entry.textHash !== textHash)) {
      throw new Error('idempotencyKey was already used with a different request')
    }
    const isAutomaticReply = idempotencyKey.startsWith('dot-auto:')
    if (isAutomaticReply) await this._validateAutomaticReply(chatId, idempotencyKey, false)
    if (entry?.status === 'sent') return entry.messageId
    if (isAutomaticReply) await this._validateAutomaticReply(chatId, idempotencyKey, true)

    if (!entry) {
      entry = {
        key: idempotencyKey,
        chatId,
        textHash,
        messageId: newMessageId(),
        status: 'pending',
        createdAt: Date.now()
      }
      await this._mutateStore(() => {
        this.store.data.idempotency[idempotencyKey] = entry
      })
    }

    const sent = await this.socket.sendMessage(chatId, { text }, { messageId: entry.messageId })
    await this._mutateStore(() => {
      entry.messageId = sent?.key?.id || entry.messageId
      entry.status = 'sent'
      entry.sentAt = Date.now()
      this.store.putMessage({
        id: entry.messageId,
        chatId,
        senderId: this.account?.id ?? null,
        direction: 'outgoing',
        timestamp: entry.sentAt,
        text,
        mediaType: null,
        media: null
      }, null)
    })
    return entry.messageId
  }

  _messageView(message, { groupAllowed } = {}) {
    const {
      _mentionedJids,
      autoReplySent: ignoredAutoReplySent,
      groupAllowed: ignoredGroupAllowed,
      mentionsBot: ignoredMentionsBot,
      senderRole: ignoredSenderRole,
      ...publicMessage
    } = message
    const autoReply = this.store.data.idempotency[`dot-auto:${message.id}`]
    const isGroup = GROUP_JID.test(message.chatId)
    return {
      ...publicMessage,
      senderRole: senderRoleForMessage(message, this.ownerIdentities.ownerIds),
      autoReplySent: autoReply?.status === 'sent' && autoReply.chatId === message.chatId,
      groupAllowed: isGroup && (groupAllowed ?? this._cachedGroupAllowed(message.chatId) ?? false),
      mentionsBot: isGroup && this._mentionedJidsIncludeBot(_mentionedJids)
    }
  }

  _mentionedJidsIncludeBot(mentionedJids) {
    return Array.isArray(mentionedJids)
      && mentionedJids.some((jid) => this.botIdentityIds.has(normalizeIdentityJid(jid)))
  }

  _refreshBotIdentitySeeds() {
    const candidates = [
      this.socket?.user?.id,
      this.socket?.user?.lid,
      this.authState?.creds?.me?.id,
      this.authState?.creds?.me?.lid
    ]
    for (const candidate of candidates) {
      const normalized = normalizeIdentityJid(candidate)
      if (normalized) this.botIdentityIds.add(normalized)
    }
  }

  async _identityAliases(sourceIds) {
    const aliases = new Set([...sourceIds].map(normalizeIdentityJid).filter(Boolean))
    const mapping = this.socket?.signalRepository?.lidMapping
    for (const identity of [...aliases]) {
      try {
        const mapped = identity.endsWith('@lid')
          ? await mapping?.getPNForLID?.(identity)
          : await mapping?.getLIDForPN?.(identity)
        const normalized = normalizeIdentityJid(mapped)
        if (normalized) aliases.add(normalized)
      } catch {
        // Missing identity aliases fail closed; exact IDs can still match.
      }
    }
    return aliases
  }

  _cachedGroupAllowed(chatId) {
    const cached = this.groupMetadataCache.get(chatId)
    if (!cached || cached.expiresAt <= Date.now()) {
      this.groupMetadataCache.delete(chatId)
      return null
    }
    return cached.allowed
  }

  _cacheGroupAccess(chatId, allowed) {
    this.groupMetadataCache.delete(chatId)
    this.groupMetadataCache.set(chatId, { allowed, expiresAt: Date.now() + GROUP_CACHE_TTL_MS })
    while (this.groupMetadataCache.size > MAX_GROUP_CACHE_ENTRIES) {
      this.groupMetadataCache.delete(this.groupMetadataCache.keys().next().value)
    }
  }

  async _getGroupAccess(chatId, { fresh = false } = {}) {
    if (!this.ownerIdentities.valid || !this.ownerIdentities.allowOwnerGroups || !GROUP_JID.test(chatId)) return false
    const cached = this._cachedGroupAllowed(chatId)
    if (!fresh && cached !== null) return cached
    try {
      const metadata = await this.socket?.groupMetadata?.(chatId)
      if (metadata?.id !== chatId || !Array.isArray(metadata.participants)) throw new Error('Invalid group metadata')
      this._refreshBotIdentitySeeds()
      const ownerIds = await this._identityAliases(this.ownerIdentities.ownerIds)
      this.botIdentityIds = await this._identityAliases(this.botIdentityIds)
      let ownerPresent = false
      let botPresent = false
      for (const participant of metadata.participants) {
        if (!participant || typeof participant !== 'object' || Array.isArray(participant)) continue
        const identities = [participant.id, participant.lid, participant.phoneNumber]
          .map(normalizeIdentityJid)
          .filter(Boolean)
        if (identities.some((identity) => ownerIds.has(identity))) ownerPresent = true
        if (identities.some((identity) => this.botIdentityIds.has(identity))) botPresent = true
      }
      const allowed = ownerPresent && botPresent
      this._cacheGroupAccess(chatId, allowed)
      return allowed
    } catch {
      this.groupMetadataCache.delete(chatId)
      return false
    }
  }

  async _validateAutomaticReply(chatId, idempotencyKey, requireFreshGroup) {
    const sourceId = idempotencyKey.slice('dot-auto:'.length)
    const source = sourceId && this.store.data.messages.find((message) => (
      message.id === sourceId
      && message.chatId === chatId
      && message.direction === 'incoming'
      && message.fromMe === false
    ))
    if (!source) throw new Error('dot-auto idempotencyKey does not reference an incoming message in this chat')
    if (!GROUP_JID.test(chatId)) {
      if (senderRoleForMessage(source, this.ownerIdentities.ownerIds) !== 'owner') {
        throw new Error('dot-auto source is not an owner direct message')
      }
      return
    }

    this._refreshBotIdentitySeeds()
    this.botIdentityIds = await this._identityAliases(this.botIdentityIds)
    if (!this.ownerIdentities.valid || !this.ownerIdentities.allowOwnerGroups || !this._mentionedJidsIncludeBot(source._mentionedJids)) {
      throw new Error('dot-auto source is not an allowed group mention')
    }
    if (requireFreshGroup && !(await this._getGroupAccess(chatId, { fresh: true }))) {
      throw new Error('dot-auto group is not currently allowed')
    }
  }

  async _loadDependencies() {
    if (!this.socketFactory || !this.authStateFactory || !this.disconnectReason) {
      const baileys = await import('@whiskeysockets/baileys')
      this.socketFactory ??= baileys.default
      this.authStateFactory ??= baileys.useMultiFileAuthState
      this.disconnectReason ??= baileys.DisconnectReason
    }
    if (!this.logger) {
      const { default: pino } = await import('pino')
      this.logger = pino({ level: 'silent' })
    }
  }

  async _connect() {
    if (!this.started) return
    const generation = ++this.generation
    this.groupMetadataCache.clear()
    this.botIdentityIds.clear()
    this.status = this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting'
    this.qr = null
    const socket = this.socketFactory({
      auth: this.authState,
      logger: this.logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: async (key) => this.store.findTextMessage(key)
    })
    this.socket = socket
    this._refreshBotIdentitySeeds()

    socket.ev.on('creds.update', () => {
      if (generation !== this.generation) return
      const operation = this.authSaveQueue.then(async () => {
        await this.saveCreds()
        this.paired = this.status === 'connected' || credentialsArePaired(this.authState)
        await this._hardenAuthFiles()
      })
      this.authSaveQueue = operation.catch((error) => this._logError('Failed to persist WhatsApp credentials', error))
    })

    socket.ev.on('connection.update', (update) => this._onConnectionUpdate(update, generation))
    socket.ev.on('messages.upsert', (upsert) => {
      if (generation !== this.generation) return
      this._onMessages(upsert).catch((error) => this._logError('Failed to persist incoming message', error))
    })
    socket.ev.on('messaging-history.set', ({ chats }) => {
      if (generation !== this.generation) return
      this._onChats(chats).catch((error) => this._logError('Failed to persist chat list', error))
    })
    socket.ev.on('chats.upsert', (chats) => {
      if (generation !== this.generation) return
      this._onChats(chats).catch((error) => this._logError('Failed to persist chat list', error))
    })
    socket.ev.on('chats.update', (chats) => {
      if (generation !== this.generation) return
      this._onChats(chats).catch((error) => this._logError('Failed to persist chat list', error))
    })
    socket.ev.on('chats.delete', (chatIds) => {
      if (generation !== this.generation || !Array.isArray(chatIds)) return
      this._mutateStore(() => this.store.deleteChats(chatIds)).catch((error) => this._logError('Failed to delete chats', error))
    })
    socket.ev.on('group-participants.update', (update) => {
      if (generation !== this.generation || !GROUP_JID.test(update?.id)) return
      this.groupMetadataCache.delete(update.id)
    })
  }

  _onConnectionUpdate(update, generation) {
    if (generation !== this.generation || !this.started) return
    if (typeof update?.qr === 'string') {
      this.qr = update.qr
      this.status = 'qr'
    }
    if (update?.connection === 'open') {
      this.reconnectAttempt = 0
      this.status = 'connected'
      this.qr = null
      this.paired = true
      const user = this.socket?.user
      this.account = user ? { id: user.id ?? null, name: user.name ?? null } : null
      this._refreshBotIdentitySeeds()
      this.emit('status', this.getStatus())
      return
    }
    if (update?.connection !== 'close') return

    this.qr = null
    this.generation += 1
    this.groupMetadataCache.clear()
    const code = disconnectStatusCode(update.lastDisconnect?.error)
    if (code === this.disconnectReason?.loggedOut) {
      this.status = 'logged_out'
      this.paired = false
      this.account = null
      this.emit('status', this.getStatus())
      return
    }
    this._scheduleReconnect()
  }

  _scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return
    this.status = 'reconnecting'
    this.reconnectAttempt += 1
    const delay = Math.min(this.reconnectMaxDelayMs, this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempt - 1, 8))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this._connect().catch((error) => {
        this._logError('WhatsApp reconnect failed', error)
        this._scheduleReconnect()
      })
    }, delay)
    this.reconnectTimer.unref?.()
    this.emit('status', this.getStatus())
  }

  async _onMessages(upsert) {
    if (upsert?.type !== 'notify' || !Array.isArray(upsert.messages)) return
    for (const raw of upsert.messages) {
      const chatId = raw?.key?.remoteJid
      if (raw?.key?.fromMe !== false || chatId === STATUS_BROADCAST) continue
      if (typeof chatId !== 'string' || !(USER_JID.test(chatId) || GROUP_JID.test(chatId) || LID_JID.test(chatId))) continue
      if (typeof raw?.key?.id !== 'string' || raw.key.id.length === 0) continue
      const content = extractContent(raw.message)
      if (!content) continue

      const isGroup = GROUP_JID.test(chatId)
      const mentionedJids = isGroup ? extractMentionedJids(raw.message) : []
      if (isGroup) {
        this._refreshBotIdentitySeeds()
        this.botIdentityIds = await this._identityAliases(this.botIdentityIds)
      }
      const groupAllowed = isGroup ? await this._getGroupAccess(chatId) : false

      const normalized = {
        id: raw.key.id,
        chatId,
        senderId: GROUP_JID.test(chatId) ? (raw.key.participant ?? null) : chatId,
        direction: 'incoming',
        fromMe: false,
        senderRole: 'untrusted',
        type: 'notify',
        pushName: boundedString(raw.pushName, 256, 1024),
        timestamp: toTimestampMs(raw.messageTimestamp),
        text: content.text,
        mediaType: content.mediaType,
        media: content.media,
        _mentionedJids: mentionedJids
      }
      normalized.senderRole = senderRoleForMessage(normalized, this.ownerIdentities.ownerIds)
      const isNew = await this._mutateStore(() => this.store.putMessage(normalized, normalized.pushName))
      if (!isNew) continue
      const { autoReplySent, ...eventMessage } = this._messageView(normalized, { groupAllowed })
      this.emit('message', {
        ...eventMessage,
        media: eventMessage.media ? { ...eventMessage.media } : null
      })
    }
  }

  async _onChats(chats) {
    if (!Array.isArray(chats)) return
    await this._mutateStore(() => {
      for (const chat of chats) {
        const id = chat?.id
        if (typeof id !== 'string' || !(USER_JID.test(id) || GROUP_JID.test(id) || LID_JID.test(id))) continue
        const timestamp = chat.conversationTimestamp ?? chat.lastMessageRecvTimestamp
        this.store.putChat({
          id,
          name: boundedString(chat.name, 256, 1024),
          updatedAt: timestamp === undefined ? undefined : toTimestampMs(timestamp)
        })
      }
    })
  }

  async _mutateStore(mutator) {
    const operation = this.mutationQueue.then(async () => {
      const result = mutator()
      await this.store.persist()
      return result
    })
    this.mutationQueue = operation.catch(() => {})
    return operation
  }

  async _hardenAuthFiles() {
    await chmod(this.authDir, 0o700)
    const entries = await readdir(this.authDir, { withFileTypes: true })
    await Promise.all(entries.filter((entry) => entry.isFile()).map((entry) => chmod(join(this.authDir, entry.name), 0o600)))
  }

  _logError(message, error) {
    this.logger?.error?.({ err: safeError(error) }, message)
  }
}
