import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
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
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const MAX_MEDIA_BYTES = 20 * 1024 * 1024
const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000
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

function extractContextInfo(rawMessage) {
  const message = unwrapMessage(rawMessage)
  return message?.extendedTextMessage?.contextInfo
    ?? message?.imageMessage?.contextInfo
    ?? message?.videoMessage?.contextInfo
    ?? message?.documentMessage?.contextInfo
    ?? message?.audioMessage?.contextInfo
    ?? message?.stickerMessage?.contextInfo
    ?? null
}

function extractMentionedJids(rawMessage) {
  const mentionedJids = extractContextInfo(rawMessage)?.mentionedJid
  if (!Array.isArray(mentionedJids)) return []
  return [...new Set(mentionedJids.map(normalizeIdentityJid).filter(Boolean))].slice(0, 32)
}

function extractNonJidMentions(rawMessage) {
  const value = extractContextInfo(rawMessage)?.nonJidMentions
  if (value === undefined || value === null) return null
  return value === 0 || value === 1 ? value : 'invalid'
}

function extractReplyReference(rawMessage) {
  const contextInfo = extractContextInfo(rawMessage)
  const id = contextInfo?.stanzaId
  const participant = normalizeIdentityJid(contextInfo?.participant)
  if (typeof id !== 'string' || id.length < 1 || id.length > 256) return null
  return { id, participant }
}

function safeDirectPath(directPath, url) {
  let candidate = directPath
  if (candidate === undefined || candidate === null || candidate === '') {
    try {
      const parsed = new URL(url)
      if (
        parsed.protocol !== 'https:'
        || parsed.hostname !== 'mmg.whatsapp.net'
        || parsed.port
        || parsed.username
        || parsed.password
      ) return null
      candidate = `${parsed.pathname}${parsed.search}`
    } catch {
      return null
    }
  }
  if (
    typeof candidate !== 'string'
    || candidate.length < 2
    || candidate.length > 4096
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(candidate)
  ) return null
  try {
    const parsed = new URL(`https://mmg.whatsapp.net${candidate}`)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'mmg.whatsapp.net' || parsed.port) return null
  } catch {
    return null
  }
  return candidate
}

function binaryBase64(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null
  if (value.byteLength !== 32) return null
  return Buffer.from(value).toString('base64')
}

function declaredFileLength(value) {
  let numeric
  if (typeof value === 'number') numeric = value
  else if (typeof value === 'bigint') numeric = Number(value)
  else if (typeof value === 'string' && /^\d+$/.test(value)) numeric = Number(value)
  else if (typeof value?.toNumber === 'function') numeric = value.toNumber()
  else if (Number.isInteger(value?.low)) numeric = value.low + (value.high || 0) * 0x100000000
  return Number.isFinite(numeric) && Number.isInteger(numeric) && numeric >= 0 ? numeric : null
}

function extractMediaDownload(rawMessage, mediaType) {
  if (!['image', 'video', 'document'].includes(mediaType)) return null
  const message = unwrapMessage(rawMessage)
  const media = message?.[`${mediaType}Message`]
  const mediaKey = binaryBase64(media?.mediaKey)
  const directPath = safeDirectPath(media?.directPath, media?.url)
  if (!mediaKey || !directPath) return null
  return {
    mediaKey,
    directPath,
    fileLength: declaredFileLength(media.fileLength),
    fileSha256: binaryBase64(media.fileSha256),
    fileEncSha256: binaryBase64(media.fileEncSha256)
  }
}

function sanitizeFileName(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new TypeError('fileName is required')
    return null
  }
  if (typeof value !== 'string') throw new TypeError('fileName must be a string')
  const leaf = value.replace(/[\r\n]/g, '').split(/[\\/]/).pop().trim()
  const fileName = boundedString(leaf, 255, 1024)
  if (!fileName) {
    if (required) throw new TypeError('fileName is required')
    return null
  }
  return fileName
}

function validateMimeType(value, kind) {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(value)) {
    throw new TypeError('mimetype must be a valid media type')
  }
  if (kind === 'video' && value !== 'video/mp4') throw new TypeError('video mimetype must be video/mp4')
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
        fileName: typeof mediaValue.fileName === 'string' ? sanitizeFileName(mediaValue.fileName) : null
      }
    : null

  return {
    text: boundedString(text, 8000, MAX_STORED_TEXT_BYTES),
    mediaType,
    media
  }
}

function quotedIncomingMessage(source) {
  const media = source.media && typeof source.media === 'object' ? source.media : {}
  const metadata = {
    ...(typeof media.mimetype === 'string' ? { mimetype: media.mimetype } : {}),
    ...(typeof source.text === 'string' ? { caption: source.text } : {})
  }
  let message
  if (source.mediaType === 'image') message = { imageMessage: metadata }
  else if (source.mediaType === 'video') message = { videoMessage: metadata }
  else if (source.mediaType === 'document') {
    message = {
      documentMessage: {
        ...metadata,
        ...(typeof media.fileName === 'string' ? { fileName: media.fileName } : {})
      }
    }
  } else {
    message = { conversation: typeof source.text === 'string' ? source.text : '' }
  }
  return {
    key: {
      remoteJid: source.chatId,
      id: source.id,
      fromMe: false,
      ...(GROUP_JID.test(source.chatId) ? { participant: source.senderId } : {})
    },
    message
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

function mediaDownloadKey(chatId, messageId) {
  return createHash('sha256').update(chatId).update('\0').update(messageId).digest('hex')
}

function decodeImageBase64(imageBase64) {
  if (
    typeof imageBase64 !== 'string'
    || imageBase64.length < 4
    || imageBase64.length > MAX_IMAGE_BASE64_LENGTH
    || imageBase64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64)
  ) {
    throw new TypeError('imageBase64 must be non-empty standard base64')
  }
  const padding = imageBase64.endsWith('==') ? 2 : imageBase64.endsWith('=') ? 1 : 0
  if ((imageBase64.length / 4) * 3 - padding > MAX_IMAGE_BYTES) {
    throw new TypeError('imageBase64 must decode to at most 5 MiB')
  }
  const image = Buffer.from(imageBase64, 'base64')
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES || image.toString('base64') !== imageBase64) {
    throw new TypeError('imageBase64 must decode to at most 5 MiB')
  }
  return image
}

function imageMimeType(image) {
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return 'image/jpeg'
  }
  if (image.length >= 12 && image.toString('ascii', 0, 4) === 'RIFF' && image.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  throw new TypeError('imageBase64 must contain a PNG, JPEG, or WebP image')
}

function mp4BoxAt(data, offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > limit) return null
  const size32 = data.readUInt32BE(offset)
  let headerSize = 8
  let size
  if (size32 === 0) {
    size = limit - offset
  } else if (size32 === 1) {
    if (offset + 16 > limit) return null
    const size64 = data.readBigUInt64BE(offset + 8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return null
    headerSize = 16
    size = Number(size64)
  } else {
    size = size32
  }
  if (size < headerSize || size > limit - offset) return null
  return {
    type: data.toString('ascii', offset + 4, offset + 8),
    dataStart: offset + headerSize,
    end: offset + size
  }
}

function mp4DurationSeconds(data) {
  let topOffset = 0
  while (topOffset < data.length) {
    const topBox = mp4BoxAt(data, topOffset, data.length)
    if (!topBox) return null
    if (topBox.type === 'moov') {
      let childOffset = topBox.dataStart
      while (childOffset < topBox.end) {
        const childBox = mp4BoxAt(data, childOffset, topBox.end)
        if (!childBox) return null
        if (childBox.type === 'mvhd') {
          const version = data[childBox.dataStart]
          let timescale
          let duration
          if (version === 0 && childBox.dataStart + 20 <= childBox.end) {
            timescale = data.readUInt32BE(childBox.dataStart + 12)
            duration = BigInt(data.readUInt32BE(childBox.dataStart + 16))
            if (duration === 0xffffffffn) return null
          } else if (version === 1 && childBox.dataStart + 32 <= childBox.end) {
            timescale = data.readUInt32BE(childBox.dataStart + 20)
            duration = data.readBigUInt64BE(childBox.dataStart + 24)
            if (duration === 0xffffffffffffffffn) return null
          } else {
            return null
          }
          if (timescale === 0 || duration === 0n) return null
          const seconds = (duration + BigInt(timescale) - 1n) / BigInt(timescale)
          return seconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(seconds) : null
        }
        childOffset = childBox.end
      }
      return null
    }
    topOffset = topBox.end
  }
  return null
}

function newMessageId() {
  return randomBytes(16).toString('hex').toUpperCase()
}

function credentialsArePaired(authState) {
  return Boolean(authState?.creds?.registered || authState?.creds?.me?.id)
}

function unconfiguredOwnerIdentities() {
  return { valid: false, ownerIds: new Set(), allowOwnerGroups: false, mentionOnlyGroupIds: new Set() }
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
    const allowedKeys = new Set(['allowOwnerGroups', 'mentionOnlyGroupIds', 'ownerIds', 'version'])
    if (
      keys.length < 2
      || keys.length > 4
      || keys.some((key) => !allowedKeys.has(key))
      || !keys.includes('ownerIds')
      || !keys.includes('version')
      || parsed.version !== OWNER_IDENTITIES_VERSION
      || !Array.isArray(parsed.ownerIds)
      || parsed.ownerIds.length > MAX_OWNER_IDENTITIES
      || parsed.ownerIds.some((ownerId) => typeof ownerId !== 'string' || !LID_JID.test(ownerId))
      || new Set(parsed.ownerIds).size !== parsed.ownerIds.length
      || (parsed.allowOwnerGroups !== undefined && typeof parsed.allowOwnerGroups !== 'boolean')
      || (parsed.mentionOnlyGroupIds !== undefined && (
        !Array.isArray(parsed.mentionOnlyGroupIds)
        || parsed.mentionOnlyGroupIds.length > 10
        || parsed.mentionOnlyGroupIds.some((chatId) => typeof chatId !== 'string' || !GROUP_JID.test(chatId))
        || new Set(parsed.mentionOnlyGroupIds).size !== parsed.mentionOnlyGroupIds.length
      ))
    ) {
      return unconfiguredOwnerIdentities()
    }
    return {
      valid: true,
      ownerIds: new Set(parsed.ownerIds),
      allowOwnerGroups: parsed.allowOwnerGroups === true,
      mentionOnlyGroupIds: new Set(parsed.mentionOnlyGroupIds ?? [])
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
    this.data = { version: STORE_VERSION, messages: [], chats: {}, idempotency: {}, mediaDownloads: {} }
  }

  async load() {
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw new Error('Unable to read message store', { cause: error })
    }
    if (
      parsed?.version !== STORE_VERSION
      || !Array.isArray(parsed.messages)
      || typeof parsed.chats !== 'object'
      || typeof parsed.idempotency !== 'object'
      || (parsed.mediaDownloads !== undefined && (
        typeof parsed.mediaDownloads !== 'object'
        || parsed.mediaDownloads === null
        || Array.isArray(parsed.mediaDownloads)
      ))
    ) {
      throw new Error('Unsupported or malformed message store')
    }
    let migrated = parsed.mediaDownloads === undefined
    parsed.mediaDownloads ??= {}
    for (const message of parsed.messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue
      if (message._mediaDownload && typeof message._mediaDownload === 'object' && !Array.isArray(message._mediaDownload)) {
        if (typeof message.chatId === 'string' && typeof message.id === 'string') {
          parsed.mediaDownloads[mediaDownloadKey(message.chatId, message.id)] = message._mediaDownload
        }
      }
      if (Object.hasOwn(message, '_mediaDownload')) {
        delete message._mediaDownload
        migrated = true
      }
    }
    this.data = parsed
    const mediaKeysBeforePrune = Object.keys(this.data.mediaDownloads).sort().join('\n')
    this.prune()
    if (Object.keys(this.data.mediaDownloads).sort().join('\n') !== mediaKeysBeforePrune) migrated = true
    return migrated
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

    const mediaKeys = new Set(this.data.messages.map((message) => mediaDownloadKey(message.chatId, message.id)))
    this.data.mediaDownloads = Object.fromEntries(Object.entries(this.data.mediaDownloads ?? {})
      .filter(([key, descriptor]) => mediaKeys.has(key) && descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)))
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

  getMediaDownload(chatId, messageId) {
    return this.data.mediaDownloads[mediaDownloadKey(chatId, messageId)] ?? null
  }

  putMediaDownload(chatId, messageId, descriptor) {
    this.data.mediaDownloads[mediaDownloadKey(chatId, messageId)] = descriptor
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
    downloadContentFromMessage,
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
    this.downloadContentFromMessage = downloadContentFromMessage
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
      const storeMigrated = await this.store.load()
      if (storeMigrated) await this.store.persist()
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

  async getMedia({ chatId, messageId } = {}) {
    assertChatId(chatId)
    if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 256) {
      throw new TypeError('messageId is required')
    }
    if (!this.started || !this.downloadContentFromMessage) throw new Error('WhatsApp bridge is not started')
    if (GROUP_JID.test(chatId)) {
      if (!(await this._getGroupAccess(chatId, { fresh: true }))) throw new Error('Media access is not allowed')
    } else if (!this.ownerIdentities.valid || !this.ownerIdentities.ownerIds.has(chatId)) {
      throw new Error('Media access is not allowed')
    }

    const message = this.store.data.messages.find((item) => (
      item.id === messageId
      && item.chatId === chatId
      && item.direction === 'incoming'
      && item.fromMe === false
      && ['image', 'video', 'document'].includes(item.mediaType)
    ))
    const descriptor = message && this.store.getMediaDownload(chatId, messageId)
    if (!descriptor) throw new Error('Media is unavailable')
    if (!GROUP_JID.test(chatId) && senderRoleForMessage(message, this.ownerIdentities.ownerIds) !== 'owner') {
      throw new Error('Media access is not allowed')
    }

    const fileLength = declaredFileLength(descriptor.fileLength)
    if (fileLength !== null && fileLength > MAX_MEDIA_BYTES) {
      throw new Error('Media exceeds 20 MiB')
    }
    const directPath = safeDirectPath(descriptor.directPath)
    let mediaKey
    let expectedFileHash = null
    try {
      mediaKey = Buffer.from(descriptor.mediaKey, 'base64')
      if (descriptor.fileSha256 !== null) expectedFileHash = Buffer.from(descriptor.fileSha256, 'base64')
      if (
        mediaKey.length !== 32
        || mediaKey.toString('base64') !== descriptor.mediaKey
        || !directPath
        || (expectedFileHash && (
          expectedFileHash.length !== 32
          || expectedFileHash.toString('base64') !== descriptor.fileSha256
        ))
      ) throw new Error()
    } catch {
      throw new Error('Media is unavailable')
    }

    let stream
    let timer
    let timedOut = false
    const controller = new AbortController()
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
        stream?.destroy?.()
        reject(new Error('Media download timed out'))
      }, MEDIA_DOWNLOAD_TIMEOUT_MS)
    })
    const download = async () => {
      stream = await this.downloadContentFromMessage(
        { mediaKey, directPath },
        message.mediaType,
        { options: { timeout: MEDIA_DOWNLOAD_TIMEOUT_MS, maxRedirects: 0, signal: controller.signal } }
      )
      if (timedOut) {
        stream?.destroy?.()
        throw new Error('Media download timed out')
      }
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('Invalid media stream')
      const chunks = []
      let length = 0
      const hash = expectedFileHash ? createHash('sha256') : null
      for await (const value of stream) {
        if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error('Invalid media stream')
        const chunk = Buffer.from(value)
        if (chunk.length === 0) continue
        length += chunk.length
        if (length > MAX_MEDIA_BYTES) {
          stream.destroy?.()
          throw new Error('Media exceeds 20 MiB')
        }
        hash?.update(chunk)
        chunks.push(chunk)
      }
      if (fileLength !== null && length !== fileLength) {
        throw new Error('Media length did not match descriptor')
      }
      if (expectedFileHash && !timingSafeEqual(hash.digest(), expectedFileHash)) {
        throw new Error('Media hash did not match descriptor')
      }
      return Buffer.concat(chunks, length)
    }

    let data
    try {
      data = await Promise.race([download(), timeout])
    } catch (error) {
      if (error?.message === 'Media exceeds 20 MiB' || error?.message === 'Media download timed out') throw error
      throw new Error('Unable to download media')
    } finally {
      clearTimeout(timer)
    }
    return {
      data,
      mimetype: message.media?.mimetype ?? null,
      fileName: message.media?.fileName ?? null,
      mediaType: message.mediaType
    }
  }

  async getGroupInfo({ chatId } = {}) {
    if (typeof chatId !== 'string' || !GROUP_JID.test(chatId)) throw new TypeError('chatId must be a WhatsApp group JID')
    if (!this.started || !this.socket) throw new Error('WhatsApp bridge is not started')
    try {
      const metadata = await this.socket.groupMetadata(chatId)
      if (!(await this._groupMetadataAllowsAccess(chatId, metadata))) throw new Error()
      this._cacheGroupAccess(chatId, true)
      return {
        chatId,
        subject: boundedString(metadata.subject, 256, 1024),
        description: boundedString(metadata.desc, 8000, MAX_STORED_TEXT_BYTES),
        announcementOnly: metadata.announce === true,
        ownerPresent: true,
        botPresent: true
      }
    } catch {
      this.groupMetadataCache.delete(chatId)
      throw new Error('Group access is not allowed')
    }
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
        return this._groupMessageAddressesBot(message.chatId, message)
          && !view.autoReplySent
          && (
            (typeof view.text === 'string' && view.text.length > 0)
            || (['image', 'video', 'document'].includes(view.mediaType) && view.media !== null)
          )
      })
    const accessByChat = new Map()
    const pending = []
    for (const message of candidates) {
      if (!accessByChat.has(message.chatId)) {
        accessByChat.set(message.chatId, await this._getGroupAccess(message.chatId, { fresh: true }))
      }
      const view = this._messageView(message, { groupAllowed: accessByChat.get(message.chatId) })
      if (view.replyAllowed) {
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

  async sendImage({ chatId, imageBase64, caption = '', idempotencyKey } = {}) {
    assertChatId(chatId)
    if (typeof caption !== 'string' || caption.length > 2000) {
      throw new TypeError('caption must contain at most 2000 characters')
    }
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new TypeError('idempotencyKey must contain 1-128 safe characters')
    }
    const image = decodeImageBase64(imageBase64)
    const mimetype = imageMimeType(image)

    const operation = this.sendQueue.then(() => this._sendImageLocked({
      chatId,
      image,
      mimetype,
      caption,
      idempotencyKey
    }))
    this.sendQueue = operation.catch(() => {})
    return operation
  }

  async sendMedia({ chatId, kind, data, mimetype, fileName, caption = '', idempotencyKey } = {}) {
    assertChatId(chatId)
    if (kind !== 'video' && kind !== 'document') throw new TypeError('kind must be video or document')
    if (!Buffer.isBuffer(data) || data.length < 1 || data.length > MAX_MEDIA_BYTES) {
      throw new TypeError('data must be a non-empty Buffer of at most 20 MiB')
    }
    validateMimeType(mimetype, kind)
    const safeFileName = sanitizeFileName(fileName, { required: kind === 'document' })
    if (typeof caption !== 'string' || caption.length > 2000) {
      throw new TypeError('caption must contain at most 2000 characters')
    }
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new TypeError('idempotencyKey must contain 1-128 safe characters')
    }
    const media = Buffer.from(data)
    if (kind === 'video' && (media.length < 12 || media.toString('ascii', 4, 8) !== 'ftyp')) {
      throw new TypeError('video data must contain an MP4 ftyp header')
    }
    const requestHash = createHash('sha256')
      .update(kind).update('\0')
      .update(mimetype).update('\0')
      .update(safeFileName ?? '').update('\0')
      .update(caption).update('\0')
      .update(media)
      .digest('hex')

    const operation = this.sendQueue.then(() => this._sendMediaLocked({
      chatId,
      kind,
      media,
      mimetype,
      fileName: safeFileName,
      caption,
      idempotencyKey,
      requestHash
    }))
    this.sendQueue = operation.catch(() => {})
    return operation
  }

  async _sendTextLocked({ chatId, text, idempotencyKey }) {
    if (!this.started || this.status !== 'connected' || !this.socket) {
      throw new Error('WhatsApp is not connected')
    }
    this._validateGroupSendPolicy(chatId, idempotencyKey)
    const textHash = hashText(text)
    let entry = this.store.data.idempotency[idempotencyKey]
    if (entry && (
      entry.chatId !== chatId
      || (entry.requestType !== undefined && entry.requestType !== 'text')
      || entry.textHash !== textHash
    )) {
      throw new Error('idempotencyKey was already used with a different request')
    }
    const isAutomaticReply = idempotencyKey.startsWith('dot-auto:')
    let source
    if (isAutomaticReply) source = await this._validateAutomaticReply(chatId, idempotencyKey, false)
    if (entry?.status === 'sent') return entry.messageId
    if (isAutomaticReply) source = await this._validateAutomaticReply(chatId, idempotencyKey, true)

    if (!entry) {
      entry = {
        key: idempotencyKey,
        chatId,
        requestType: 'text',
        textHash,
        messageId: newMessageId(),
        status: 'pending',
        createdAt: Date.now()
      }
      await this._mutateStore(() => {
        this.store.data.idempotency[idempotencyKey] = entry
      })
    }

    const sent = await this.socket.sendMessage(chatId, { text }, {
      messageId: entry.messageId,
      ...(source ? { quoted: quotedIncomingMessage(source) } : {})
    })
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
        media: null,
        ...(source ? { _replyTo: { id: source.id, participant: source.senderId } } : {})
      }, null)
    })
    return entry.messageId
  }

  async _sendImageLocked({ chatId, image, mimetype, caption, idempotencyKey }) {
    if (!this.started || this.status !== 'connected' || !this.socket) {
      throw new Error('WhatsApp is not connected')
    }
    this._validateGroupSendPolicy(chatId, idempotencyKey)
    const imageHash = hashText(image)
    const captionHash = hashText(caption)
    let entry = this.store.data.idempotency[idempotencyKey]
    if (entry && (
      entry.chatId !== chatId
      || entry.requestType !== 'image'
      || entry.imageHash !== imageHash
      || entry.captionHash !== captionHash
      || entry.mimetype !== mimetype
    )) {
      throw new Error('idempotencyKey was already used with a different request')
    }
    const isAutomaticReply = idempotencyKey.startsWith('dot-auto:')
    let source
    if (isAutomaticReply) source = await this._validateAutomaticReply(chatId, idempotencyKey, false)
    if (entry?.status === 'sent') return entry.messageId
    if (isAutomaticReply) source = await this._validateAutomaticReply(chatId, idempotencyKey, true)

    if (!entry) {
      entry = {
        key: idempotencyKey,
        chatId,
        requestType: 'image',
        imageHash,
        captionHash,
        mimetype,
        size: image.length,
        messageId: newMessageId(),
        status: 'pending',
        createdAt: Date.now()
      }
      await this._mutateStore(() => {
        this.store.data.idempotency[idempotencyKey] = entry
      })
    }

    const sent = await this.socket.sendMessage(chatId, { image, mimetype, caption }, {
      messageId: entry.messageId,
      ...(source ? { quoted: quotedIncomingMessage(source) } : {})
    })
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
        text: caption || null,
        mediaType: 'image',
        media: { mimetype, size: image.length },
        ...(source ? { _replyTo: { id: source.id, participant: source.senderId } } : {})
      }, null)
    })
    return entry.messageId
  }

  async _sendMediaLocked({ chatId, kind, media, mimetype, fileName, caption, idempotencyKey, requestHash }) {
    if (!this.started || this.status !== 'connected' || !this.socket) {
      throw new Error('WhatsApp is not connected')
    }
    this._validateGroupSendPolicy(chatId, idempotencyKey)
    let entry = this.store.data.idempotency[idempotencyKey]
    if (entry && (
      entry.chatId !== chatId
      || entry.requestType !== 'media'
      || entry.requestHash !== requestHash
    )) {
      throw new Error('idempotencyKey was already used with a different request')
    }
    const isAutomaticReply = idempotencyKey.startsWith('dot-auto:')
    let source
    if (isAutomaticReply) source = await this._validateAutomaticReply(chatId, idempotencyKey, false)
    if (entry?.status === 'sent') return entry.messageId
    if (isAutomaticReply) source = await this._validateAutomaticReply(chatId, idempotencyKey, true)

    if (!entry) {
      entry = {
        key: idempotencyKey,
        chatId,
        requestType: 'media',
        requestHash,
        kind,
        mimetype,
        fileName,
        size: media.length,
        messageId: newMessageId(),
        status: 'pending',
        createdAt: Date.now()
      }
      await this._mutateStore(() => {
        this.store.data.idempotency[idempotencyKey] = entry
      })
    }

    const seconds = kind === 'video' ? mp4DurationSeconds(media) : null
    const content = kind === 'video'
      ? { video: media, mimetype, caption, ...(seconds === null ? {} : { seconds }) }
      : { document: media, mimetype, fileName, caption }
    const sent = await this.socket.sendMessage(chatId, content, {
      messageId: entry.messageId,
      ...(source ? { quoted: quotedIncomingMessage(source) } : {})
    })
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
        text: caption || null,
        mediaType: kind,
        media: { mimetype, fileName, size: media.length },
        ...(source ? { _replyTo: { id: source.id, participant: source.senderId } } : {})
      }, null)
    })
    return entry.messageId
  }

  _messageView(message, { groupAllowed } = {}) {
    const {
      _mediaDownload,
      _mentionedJids,
      _nonJidMentions,
      _replyTo,
      autoReplySent: ignoredAutoReplySent,
      groupAllowed: ignoredGroupAllowed,
      mentionsAll: ignoredMentionsAll,
      mentionsBot: ignoredMentionsBot,
      replyAllowed: ignoredReplyAllowed,
      repliesToBot: ignoredRepliesToBot,
      senderRole: ignoredSenderRole,
      ...publicMessage
    } = message
    const autoReply = this.store.data.idempotency[`dot-auto:${message.id}`]
    const isGroup = GROUP_JID.test(message.chatId)
    const senderRole = senderRoleForMessage(message, this.ownerIdentities.ownerIds)
    const mentionsBot = isGroup && this._mentionedJidsIncludeBot(_mentionedJids)
    const mentionsAll = isGroup && _nonJidMentions === 1
    const replyAddressed = isGroup && this._groupMessageAddressesBot(message.chatId, message)
    const allowedGroup = isGroup && (groupAllowed ?? this._cachedGroupAllowed(message.chatId) ?? false)
    const incoming = message.direction === 'incoming' && message.fromMe === false
    return {
      ...publicMessage,
      senderRole,
      autoReplySent: autoReply?.status === 'sent' && autoReply.chatId === message.chatId,
      groupAllowed: allowedGroup,
      mentionsBot,
      mentionsAll,
      repliesToBot: isGroup && this._replyReferenceIsBotMessage(message.chatId, _replyTo),
      quotedMessageId: _replyTo?.id ?? null,
      replyAllowed: incoming && (isGroup ? allowedGroup && replyAddressed : senderRole === 'owner')
    }
  }

  _groupMessageAddressesBot(chatId, message) {
    if (message._nonJidMentions === 1 || message._nonJidMentions === 'invalid') return false
    if (this.ownerIdentities.mentionOnlyGroupIds.has(chatId)) {
      return this._mentionedJidsIncludeBot(message._mentionedJids)
    }
    return this._mentionedJidsIncludeBot(message._mentionedJids)
      || this._replyReferenceIsBotMessage(chatId, message._replyTo)
  }

  _validateGroupSendPolicy(chatId, idempotencyKey) {
    if (this.ownerIdentities.mentionOnlyGroupIds.has(chatId) && !idempotencyKey.startsWith('dot-auto:')) {
      throw new Error('This group only allows verified automatic replies')
    }
  }

  _replyReferenceIsBotMessage(chatId, replyTo) {
    if (!replyTo || !this.botIdentityIds.has(replyTo.participant)) return false
    return this.store.data.messages.some((message) => (
      message.id === replyTo.id
      && message.chatId === chatId
      && message.direction === 'outgoing'
      && this.botIdentityIds.has(normalizeIdentityJid(message.senderId))
    ))
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
      const allowed = await this._groupMetadataAllowsAccess(chatId, metadata)
      this._cacheGroupAccess(chatId, allowed)
      return allowed
    } catch {
      this.groupMetadataCache.delete(chatId)
      return false
    }
  }

  async _groupMetadataAllowsAccess(chatId, metadata) {
    if (!this.ownerIdentities.valid || !this.ownerIdentities.allowOwnerGroups) return false
    if (metadata?.id !== chatId || !Array.isArray(metadata.participants)) return false
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
    return ownerPresent && botPresent
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
      return source
    }

    this._refreshBotIdentitySeeds()
    this.botIdentityIds = await this._identityAliases(this.botIdentityIds)
    const addressesBot = this._groupMessageAddressesBot(chatId, source)
    if (!this.ownerIdentities.valid || !this.ownerIdentities.allowOwnerGroups || !addressesBot) {
      throw new Error('dot-auto source is not an allowed group mention or reply')
    }
    if (requireFreshGroup && !(await this._getGroupAccess(chatId, { fresh: true }))) {
      throw new Error('dot-auto group is not currently allowed')
    }
    return source
  }

  async _loadDependencies() {
    if (!this.socketFactory || !this.authStateFactory || !this.downloadContentFromMessage || !this.disconnectReason) {
      const baileys = await import('@whiskeysockets/baileys')
      this.socketFactory ??= baileys.default
      this.authStateFactory ??= baileys.useMultiFileAuthState
      if (!this.downloadContentFromMessage) {
        const { downloadWhatsAppMedia } = await import('./media.mjs')
        this.downloadContentFromMessage = (descriptor, kind, options) => downloadWhatsAppMedia(descriptor, kind, {
          getMediaKeys: baileys.getMediaKeys,
          signal: options?.options?.signal
        })
      }
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
      const nonJidMentions = isGroup ? extractNonJidMentions(raw.message) : null
      const replyTo = isGroup ? extractReplyReference(raw.message) : null
      const mediaDownload = extractMediaDownload(raw.message, content.mediaType)
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
        _mentionedJids: mentionedJids,
        _nonJidMentions: nonJidMentions,
        _replyTo: replyTo
      }
      normalized.senderRole = senderRoleForMessage(normalized, this.ownerIdentities.ownerIds)
      const isNew = await this._mutateStore(() => {
        const inserted = this.store.putMessage(normalized, normalized.pushName)
        if (mediaDownload) this.store.putMediaDownload(normalized.chatId, normalized.id, mediaDownload)
        return inserted
      })
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
