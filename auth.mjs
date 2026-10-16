import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCOPES = ["whatsapp.read", "whatsapp.send", "events"];
const MAX_CLIENTS = 100;
const MAX_CODES = 100;
const MAX_TOKENS = 300;
const MAX_SESSIONS = 10;
const MAX_CSRF = 100;

export class OAuthError extends Error {
  constructor(code, description, status = 400) {
    super(description);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function secret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function parseScopes(value) {
  const scopes = [...new Set(String(value || "").split(/\s+/).filter(Boolean))];
  if (scopes.some((scope) => !SCOPES.includes(scope))) {
    throw new OAuthError("invalid_scope", "要求的權限範圍不受支援");
  }
  return scopes;
}

function validateRedirectUri(raw, allowLocalRedirects) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri 格式無效");
  }
  if (url.username || url.password || url.hash) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri 不可包含認證資料或 fragment");
  }
  const productionHost = url.protocol === "https:" &&
    (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
  const localHost = allowLocalRedirects &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1");
  if (!productionHost && !localHost) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uri 網域不在允許清單");
  }
  return url.toString();
}

function cleanState(state, now) {
  for (const collection of ["codes", "accessTokens", "refreshTokens", "adminSessions", "oauthCsrf", "adminCsrf"]) {
    for (const [key, value] of Object.entries(state[collection])) {
      if (!value || value.expiresAt <= now) delete state[collection][key];
    }
  }
}

function trimObject(object, maximum, sortField = "createdAt") {
  const entries = Object.entries(object);
  if (entries.length <= maximum) return;
  entries.sort((a, b) => (a[1]?.[sortField] || 0) - (b[1]?.[sortField] || 0));
  for (const [key] of entries.slice(0, entries.length - maximum)) delete object[key];
}

function emptyState() {
  return {
    version: 1,
    clients: {},
    codes: {},
    accessTokens: {},
    refreshTokens: {},
    adminSessions: {},
    oauthCsrf: {},
    adminCsrf: {},
  };
}

function normalizeState(value) {
  const base = emptyState();
  if (!value || value.version !== 1) return base;
  for (const key of Object.keys(base)) {
    if (key === "version") continue;
    if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) {
      base[key] = value[key];
    }
  }
  return base;
}

async function readAdminToken(config) {
  if (config.adminToken) return String(config.adminToken).trim();
  const tokenFile = config.adminTokenFile || process.env.ADMIN_TOKEN_FILE;
  if (tokenFile) {
    const stat = await lstat(tokenFile);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("ADMIN_TOKEN_FILE 必須是一般檔案");
    if ((stat.mode & 0o077) !== 0) throw new Error("ADMIN_TOKEN_FILE 權限必須為 0600 或更嚴格");
    return (await readFile(tokenFile, "utf8")).trim();
  }
  return String(process.env.ADMIN_TOKEN || "").trim();
}

export async function createAuthManager(config = {}) {
  const publicUrl = new URL(config.publicUrl || process.env.PUBLIC_URL || "");
  publicUrl.pathname = publicUrl.pathname.replace(/\/$/, "");
  publicUrl.search = "";
  publicUrl.hash = "";
  if (publicUrl.protocol !== "https:" && !(config.allowInsecureHttp && ["localhost", "127.0.0.1", "::1"].includes(publicUrl.hostname))) {
    throw new Error("PUBLIC_URL 必須使用 HTTPS");
  }
  const issuer = publicUrl.toString().replace(/\/$/, "");
  const resource = `${issuer}/mcp`;
  const dataDir = config.dataDir || process.env.DATA_DIR || join(process.cwd(), "data");
  const statePath = join(dataDir, "auth-state.json");
  const now = config.now || Date.now;
  const adminToken = await readAdminToken(config);
  if (adminToken.length < 16) throw new Error("ADMIN_TOKEN 至少需要 16 個字元");
  const allowLocalRedirects = config.allowLocalRedirects === true || process.env.ALLOW_LOCAL_OAUTH_REDIRECTS === "true";

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  let state = emptyState();
  try {
    const stat = await lstat(statePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("OAuth 狀態路徑不安全");
    state = normalizeState(JSON.parse(await readFile(statePath, "utf8")));
    await chmod(statePath, 0o600);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let mutation = Promise.resolve();
  async function persist() {
    trimObject(state.codes, MAX_CODES);
    trimObject(state.accessTokens, MAX_TOKENS);
    trimObject(state.refreshTokens, MAX_TOKENS);
    trimObject(state.adminSessions, MAX_SESSIONS);
    trimObject(state.oauthCsrf, MAX_CSRF);
    trimObject(state.adminCsrf, MAX_CSRF);
    const temporary = `${statePath}.${process.pid}.${secret(8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, statePath);
    await chmod(statePath, 0o600);
  }

  async function mutate(operation) {
    const previous = mutation;
    let release;
    mutation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      cleanState(state, now());
      let result;
      let operationError;
      try {
        result = await operation();
      } catch (error) {
        operationError = error;
      }
      await persist();
      if (operationError) throw operationError;
      return result;
    } finally {
      release();
    }
  }

  async function inspect(operation) {
    await mutation;
    return operation();
  }

  function requireClient(clientId, redirectUri) {
    const client = state.clients[clientId];
    if (!client) throw new OAuthError("invalid_client", "OAuth client 不存在", 401);
    const normalized = validateRedirectUri(redirectUri, allowLocalRedirects);
    if (!client.redirectUris.includes(normalized)) {
      throw new OAuthError("invalid_grant", "redirect_uri 與已登記資料不符");
    }
    return { client, redirectUri: normalized };
  }

  function normalizeAuthorization(params) {
    const clientId = String(params.client_id || "");
    const { redirectUri } = requireClient(clientId, String(params.redirect_uri || ""));
    if (params.response_type !== "code") throw new OAuthError("unsupported_response_type", "只支援 code response type");
    if (params.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(String(params.code_challenge || ""))) {
      throw new OAuthError("invalid_request", "必須使用 PKCE S256");
    }
    if (String(params.resource || "") !== resource) throw new OAuthError("invalid_target", "resource 不符");
    const scopes = parseScopes(params.scope);
    if (scopes.length === 0) throw new OAuthError("invalid_scope", "至少需要一項權限");
    return {
      clientId,
      redirectUri,
      state: String(params.state || ""),
      codeChallenge: String(params.code_challenge),
      resource,
      scopes,
    };
  }

  return {
    issuer,
    resource,
    scopes: [...SCOPES],

    protectedResourceMetadata() {
      return {
        resource,
        authorization_servers: [issuer],
        scopes_supported: [...SCOPES],
      };
    },

    authorizationServerMetadata() {
      return {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...SCOPES],
        authorization_response_iss_parameter_supported: true,
      };
    },

    challenge(scopes = []) {
      const scope = scopes.length ? `, scope="${scopes.join(" ")}"` : "";
      return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"${scope}`;
    },

    async registerClient(body) {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new OAuthError("invalid_client_metadata", "client metadata 無效");
      const redirectUris = [...new Set(asArray(body.redirect_uris).map((uri) => validateRedirectUri(String(uri), allowLocalRedirects)))];
      if (redirectUris.length === 0 || redirectUris.length > 10) throw new OAuthError("invalid_redirect_uris", "redirect_uris 數量無效");
      if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
        throw new OAuthError("invalid_client_metadata", "只支援 public client");
      }
      const grants = asArray(body.grant_types || ["authorization_code", "refresh_token"]);
      if (grants.some((grant) => !["authorization_code", "refresh_token"].includes(grant))) {
        throw new OAuthError("invalid_client_metadata", "grant_types 不受支援");
      }
      const responses = asArray(body.response_types || ["code"]);
      if (responses.length !== 1 || responses[0] !== "code") throw new OAuthError("invalid_client_metadata", "response_types 不受支援");
      return mutate(async () => {
        if (Object.keys(state.clients).length >= MAX_CLIENTS) {
          throw new OAuthError("temporarily_unavailable", "OAuth client 登記數量已達上限", 429);
        }
        const clientId = `client_${secret(24)}`;
        state.clients[clientId] = {
          clientId,
          redirectUris,
          clientName: String(body.client_name || "OpenAI client").slice(0, 100),
          createdAt: now(),
        };
        return {
          client_id: clientId,
          client_id_issued_at: Math.floor(now() / 1000),
          redirect_uris: redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        };
      });
    },

    async beginAuthorization(params) {
      await mutation;
      const request = normalizeAuthorization(params);
      return mutate(async () => {
        const csrf = secret();
        state.oauthCsrf[sha256(csrf)] = {
          request,
          createdAt: now(),
          expiresAt: now() + 10 * 60_000,
        };
        return { csrf, request };
      });
    },

    async authorizationErrorRedirect(params, error) {
      return inspect(() => {
        const clientId = String(params.clientId || params.client_id || "");
        const rawRedirect = String(params.redirectUri || params.redirect_uri || "");
        const { redirectUri } = requireClient(clientId, rawRedirect);
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("error", error.code || "invalid_request");
        redirect.searchParams.set("error_description", error.message || "Authorization failed");
        const requestState = params.state;
        if (requestState) redirect.searchParams.set("state", String(requestState));
        redirect.searchParams.set("iss", issuer);
        return redirect.toString();
      });
    },

    async approveAuthorization(fields) {
      const csrfHash = sha256(String(fields.csrf || ""));
      return mutate(async () => {
        const pending = state.oauthCsrf[csrfHash];
        delete state.oauthCsrf[csrfHash];
        if (!pending || pending.expiresAt <= now()) throw new OAuthError("invalid_request", "授權頁已過期，請重新開始");
        if (!safeEqual(String(fields.admin_token || ""), adminToken)) {
          const error = new OAuthError("access_denied", "管理員驗證失敗", 403);
          error.authorizationRequest = pending.request;
          throw error;
        }
        const code = secret();
        state.codes[sha256(code)] = {
          ...pending.request,
          createdAt: now(),
          expiresAt: now() + 5 * 60_000,
        };
        return { code, ...pending.request };
      });
    },

    async exchangeToken(fields) {
      const grantType = String(fields.grant_type || "");
      if (grantType === "authorization_code") {
        const codeHash = sha256(String(fields.code || ""));
        return mutate(async () => {
          const grant = state.codes[codeHash];
          if (!grant || grant.expiresAt <= now()) throw new OAuthError("invalid_grant", "authorization code 無效或已使用");
          const { redirectUri } = requireClient(String(fields.client_id || ""), String(fields.redirect_uri || ""));
          if (grant.clientId !== fields.client_id || grant.redirectUri !== redirectUri || String(fields.resource || "") !== grant.resource) {
            throw new OAuthError("invalid_grant", "authorization code 與請求不符");
          }
          const verifier = String(fields.code_verifier || "");
          if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError("invalid_grant", "PKCE verifier 無效");
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!safeEqual(challenge, grant.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verifier 無效");
          delete state.codes[codeHash];
          return issueTokens(grant.clientId, grant.scopes, grant.resource);
        });
      }
      if (grantType === "refresh_token") {
        const refreshHash = sha256(String(fields.refresh_token || ""));
        return mutate(async () => {
          const grant = state.refreshTokens[refreshHash];
          if (!grant || grant.expiresAt <= now()) throw new OAuthError("invalid_grant", "refresh token 無效");
          if (grant.clientId !== fields.client_id || String(fields.resource || "") !== grant.resource) {
            throw new OAuthError("invalid_grant", "refresh token 與請求不符");
          }
          if (!state.clients[String(fields.client_id || "")]) throw new OAuthError("invalid_client", "OAuth client 不存在", 401);
          const requested = fields.scope ? parseScopes(fields.scope) : grant.scopes;
          if (requested.some((scope) => !grant.scopes.includes(scope))) throw new OAuthError("invalid_scope", "不可擴大 refresh token 權限");
          delete state.refreshTokens[refreshHash];
          return issueTokens(grant.clientId, requested, grant.resource);
        });
      }
      throw new OAuthError("unsupported_grant_type", "grant_type 不受支援");
    },

    async authenticateBearer(header, requiredScopes = []) {
      const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(String(header || ""));
      if (!match) throw new OAuthError("invalid_token", "缺少有效 access token", 401);
      return inspect(() => {
        const token = state.accessTokens[sha256(match[1])];
        if (!token || token.expiresAt <= now() || token.resource !== resource) {
          throw new OAuthError("invalid_token", "access token 無效或已過期", 401);
        }
        if (requiredScopes.some((scope) => !token.scopes.includes(scope))) {
          const error = new OAuthError("insufficient_scope", "access token 權限不足", 403);
          error.requiredScopes = [...requiredScopes];
          throw error;
        }
        return { id: "owner", scopes: [...token.scopes], clientId: token.clientId };
      });
    },

    async createAdminSession(presentedToken) {
      if (!safeEqual(String(presentedToken || ""), adminToken)) throw new OAuthError("access_denied", "管理員驗證失敗", 403);
      return mutate(async () => {
        const session = secret();
        state.adminSessions[sha256(session)] = { createdAt: now(), expiresAt: now() + 12 * 60 * 60_000 };
        return session;
      });
    },

    async authenticateAdmin(session) {
      const sessionHash = sha256(String(session || ""));
      return inspect(() => {
        const record = state.adminSessions[sessionHash];
        if (!record || record.expiresAt <= now()) throw new OAuthError("access_denied", "管理員登入已失效", 401);
        return sessionHash;
      });
    },

    async createAdminCsrf(session) {
      const sessionHash = await this.authenticateAdmin(session);
      return mutate(async () => {
        const csrf = secret();
        state.adminCsrf[sha256(csrf)] = { sessionHash, createdAt: now(), expiresAt: now() + 30 * 60_000 };
        return csrf;
      });
    },

    async consumeAdminCsrf(session, csrf) {
      const sessionHash = await this.authenticateAdmin(session);
      return mutate(async () => {
        const csrfHash = sha256(String(csrf || ""));
        const record = state.adminCsrf[csrfHash];
        delete state.adminCsrf[csrfHash];
        if (!record || record.expiresAt <= now() || !safeEqual(record.sessionHash, sessionHash)) {
          throw new OAuthError("invalid_request", "CSRF token 無效或已使用", 403);
        }
        return true;
      });
    },

    async destroyAdminSession(session, csrf) {
      const sessionHash = await this.authenticateAdmin(session);
      await this.consumeAdminCsrf(session, csrf);
      return mutate(async () => { delete state.adminSessions[sessionHash]; });
    },
  };

  function issueTokens(clientId, scopes, tokenResource) {
    const accessToken = secret();
    const refreshToken = secret();
    const createdAt = now();
    state.accessTokens[sha256(accessToken)] = {
      clientId,
      scopes,
      resource: tokenResource,
      createdAt,
      expiresAt: createdAt + 15 * 60_000,
    };
    state.refreshTokens[sha256(refreshToken)] = {
      clientId,
      scopes,
      resource: tokenResource,
      createdAt,
      expiresAt: createdAt + 30 * 24 * 60 * 60_000,
    };
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 15 * 60,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}
