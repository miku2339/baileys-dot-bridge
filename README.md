# Baileys → MCP Events → ChatGPT Dot

把一個 WhatsApp 帳戶透過 [Baileys](https://github.com/WhiskeySockets/Baileys) 接到受 OAuth 保護的 MCP 伺服器，再由 ChatGPT Dot 透過原生 MCP Events 接收新訊息並回覆。

這個專案提供：

- 6 個唯讀工具：狀態、對話清單、訊息、待回覆群組訊息、媒體讀取、群組資料
- 4 個寫入工具：發送文字、圖片、影片或文件，均強制使用 `idempotencyKey`
- 1 個事件：`whatsapp.message_received`
- OAuth 2.1 authorization code + PKCE、動態用戶端註冊及 refresh token
- 私聊 owner LID 核對、群組 owner／Bot 成員核對，以及真實 mention／可信引用核對
- 有界訊息保存、事件佇列、重試、防重及安全日誌

Baileys 是非官方 WhatsApp Web 介面，與 WhatsApp／Meta 無關；使用可能涉及帳戶風險，請遵守 WhatsApp 條款，勿作垃圾訊息或大量自動發送。

## 運作方式

```text
WhatsApp 手機
    │ Linked Devices / Baileys WebSocket
    ▼
Baileys bridge ── localhost:4391 ── Cloudflare Tunnel ── HTTPS /mcp
    │                                                       │
    ├─ shared/auth、store.json                              │ OAuth + MCP
    └─ whatsapp.message_received ── signed webhook ─────────▼
                                                        ChatGPT Dot
```

MCP endpoint、OAuth、管理頁及健康檢查共用同一個只聆聽 loopback 的 Node 服務：

- `https://whatsapp.example.com/mcp`
- `https://whatsapp.example.com/admin`
- `https://whatsapp.example.com/healthz`
- OAuth discovery 位於 `/.well-known/oauth-protected-resource/mcp` 及 `/.well-known/oauth-authorization-server`

Cloudflare Tunnel 對外提供 HTTPS；VPS 不需要把 4391 或 4392 開放到公網。

## 已鎖定版本

- Ubuntu 24.04 LTS VPS
- Node.js `24.22.0`
- `@whiskeysockets/baileys` `7.0.0-rc14`
- npm 依 `package-lock.json` 執行 `npm ci`
- Python 3（Ubuntu 24.04 內建版本即可）
- `cloudflared` 官方套件

OpenAI 的 MCP Events 目前需要 MCP 2.0 protocol `2026-07-28`，並使用 webhook delivery；支援範圍、Dot 供應情況及介面仍可能變動，請以 [OpenAI MCP Events 文件](https://developers.openai.com/plugins/build/mcp-events)為準。

部署後採 release symlink：

```text
$HOME/apps/baileys-dot/
├── current -> releases/<release-id>
├── releases/<release-id>/
├── runtime/node -> node-v24.22.0-linux-<arch>
├── shared/                  # 0700；登入、OAuth、訊息及事件狀態
├── supervise.py             # 目前 supervisor
└── shared/admin.token       # 0600
```

`shared` 不屬於 release，更新及回退時不會清除 WhatsApp 登入與 OAuth／事件狀態。

## 1. 準備網域與 Cloudflare Tunnel

以下以 `whatsapp.example.com` 示範；它是文件專用假網域，必須換成你控制的真實 HTTPS 網域。

在 Cloudflare Zero Trust 建立一條專用 Tunnel，新增 Public Hostname：

```text
Hostname: whatsapp.example.com
Service:  http://127.0.0.1:4391
```

從 Tunnel 安裝畫面複製 token，但不要貼到 shell history、README 或 Git。稍後會用標準輸入寫入權限為 0600 的檔案。

在 VPS 安裝官方 `cloudflared` 套件：

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git xz-utils python3 cron
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
sudo apt-get update
sudo apt-get install -y cloudflared
cloudflared --version
```

本專案的 supervisor 會以專用 token 啟動 Tunnel，並把 metrics 限制在 `127.0.0.1:4392`。不要另外安裝同一條 Tunnel 的 systemd service，避免兩份程序互搶。

## 2. 建立 VPS 目錄

以日常的非 root Linux 帳戶登入 VPS：

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
umask 077
install -d -m 0700 \
  "$APP_ROOT" \
  "$APP_ROOT/releases" \
  "$APP_ROOT/runtime" \
  "$APP_ROOT/shared"
```

所有 bridge 狀態都在 `shared`。不要把整個 `shared` 複製到公開 repo 或支援工單。

## 3. 安裝固定 Node.js 版本

以下命令支援常見的 x86_64 及 ARM64 Ubuntu VPS，並先核對 Node 官方 SHA-256：

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
export NODE_VERSION='24.22.0'
case "$(uname -m)" in
  x86_64) NODE_ARCH='x64' ;;
  aarch64|arm64) NODE_ARCH='arm64' ;;
  *) echo '不支援的 CPU 架構' >&2; exit 1 ;;
esac

NODE_TMP="$(mktemp -d)"
cd "$NODE_TMP"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz$" SHASUMS256.txt | sha256sum -c -
tar -xJf "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
mv "node-v${NODE_VERSION}-linux-${NODE_ARCH}" "$APP_ROOT/runtime/"
ln -sfn "node-v${NODE_VERSION}-linux-${NODE_ARCH}" "$APP_ROOT/runtime/node"
cd "$APP_ROOT"
rm -rf "$NODE_TMP"
export PATH="$APP_ROOT/runtime/node/bin:$PATH"

node --version
npm --version
```

預期 Node 顯示 `v24.22.0`。

## 4. 安裝一個 release

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
export RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
export RELEASE_DIR="$APP_ROOT/releases/$RELEASE_ID"
export PATH="$APP_ROOT/runtime/node/bin:$PATH"

git clone --depth 1 https://github.com/miku2339/baileys-dot-bridge.git "$RELEASE_DIR"
cd "$RELEASE_DIR"
npm ci
npm test
python3 -m unittest -v test_supervise.py
```

目前完整本機驗證應為 58 個 Node tests 及 4 個 Python tests 全部通過。測試通過後才切換：

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
export RELEASE_DIR="$(find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"

install -m 0755 "$RELEASE_DIR/supervise.py" "$APP_ROOT/supervise.py"
ln -sfn "$RELEASE_DIR" "$APP_ROOT/current.new"
mv -Tf "$APP_ROOT/current.new" "$APP_ROOT/current"
```

`mv -T` 是 GNU coreutils 行為，Ubuntu 24.04 可直接使用。

## 5. 建立設定與憑證

先在 VPS 寫入非秘密設定：

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
umask 077
cat >"$APP_ROOT/shared/settings.json" <<EOF
{
  "PUBLIC_URL": "https://whatsapp.example.com",
  "DATA_DIR": "$APP_ROOT/shared",
  "ADMIN_TOKEN_FILE": "$APP_ROOT/shared/admin.token",
  "PORT": "4391",
  "LOG_LEVEL": "info"
}
EOF
chmod 0600 "$APP_ROOT/shared/settings.json"
```

把 `whatsapp.example.com` 換成第 1 步設定的網域。正式環境不要設定 `ALLOW_LOCAL_OAUTH_REDIRECTS`。

在自己的電腦開另一個 terminal，以隱藏輸入建立管理員密碼，再經 SSH stdin 傳到 VPS。以下不會把密碼顯示在畫面或寫進遠端 command line：

```sh
bash -c 'read -r -s -p "設定 bridge 管理員密碼（至少 16 字元）: " ADMIN_TOKEN </dev/tty; printf "\n" >/dev/tty; printf "%s\n" "$ADMIN_TOKEN"' \
  | ssh YOUR_VPS 'umask 077; install -d -m 0700 "$HOME/apps/baileys-dot/shared"; cat >"$HOME/apps/baileys-dot/shared/admin.token"; chmod 0600 "$HOME/apps/baileys-dot/shared/admin.token"'
```

把 `YOUR_VPS` 換成你的 SSH host alias 或 `user@host`。請把同一密碼保存在密碼管理器；稍後 OAuth 授權頁需要手動輸入。

用相同方法保存 Cloudflare Tunnel token：

```sh
bash -c 'read -r -s -p "貼上 Cloudflare Tunnel token: " CF_TUNNEL_TOKEN </dev/tty; printf "\n" >/dev/tty; printf "%s\n" "$CF_TUNNEL_TOKEN"' \
  | ssh YOUR_VPS 'umask 077; cat >"$HOME/apps/baileys-dot/shared/cloudflared.token"; chmod 0600 "$HOME/apps/baileys-dot/shared/cloudflared.token"'
```

用 `stat -c '%a %n'` 核對 `shared` 是 700，`admin.token`、`cloudflared.token` 及 `settings.json` 是 600；命令只讀 mode 及路徑，不要讀出內容。

## 6. 啟動及保持運作

supervisor 固定使用 `/usr/local/bin/cloudflared`。若套件安裝到其他位置，先建立 symlink：

```sh
CLOUDFLARED_BIN="$(command -v cloudflared)"
[ "$CLOUDFLARED_BIN" = /usr/local/bin/cloudflared ] \
  || sudo ln -sfn "$CLOUDFLARED_BIN" /usr/local/bin/cloudflared
```

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
python3 "$APP_ROOT/supervise.py" --stop
nohup python3 "$APP_ROOT/supervise.py" </dev/null >/dev/null 2>&1 &
```

supervisor 會同時啟動：

- `runtime/node/bin/node current/server.mjs`
- `/usr/local/bin/cloudflared ... --metrics 127.0.0.1:4392 ... --token-file shared/cloudflared.token`

加入使用者 crontab，標記只屬於這個服務的兩行：

```cron
@reboot nohup python3 "$HOME/apps/baileys-dot/supervise.py" </dev/null >/dev/null 2>&1 & # baileys-dot
*/5 * * * * nohup python3 "$HOME/apps/baileys-dot/supervise.py" </dev/null >/dev/null 2>&1 & # baileys-dot
```

`supervisor.lock` 會阻止重複實例。日誌位於 `shared/logs/service.log`，三個輪替檔合計約 3 MiB；bridge 日誌只保留白名單狀態欄位。

先驗證 loopback，再驗證公開 HTTPS：

```sh
curl -fsS http://127.0.0.1:4391/healthz
curl -fsS https://whatsapp.example.com/healthz
```

兩者都應回傳 `{"ok":true}`。

## 7. 經 SSH 安全地掃描 QR Code

管理頁應只經 SSH port forwarding 開啟，避免在共用或不可信電腦輸入管理員密碼：

```sh
ssh -L 4391:127.0.0.1:4391 YOUR_VPS
```

保持 SSH 連線，然後在本機瀏覽器開啟：

```text
http://127.0.0.1:4391/admin
```

輸入 `admin.token` 對應的管理員密碼，用手機 WhatsApp 的 Linked Devices 掃描 QR Code。重新整理管理頁，直到狀態顯示 `connected` 及 `paired: true`。

管理 cookie 在正式 HTTPS 入口帶 `Secure`；透過 localhost SSH tunnel 配對時，如瀏覽器不保留 session，可直接使用 `https://whatsapp.example.com/admin`，但仍應只在自己的裝置操作。

## 8. 在 ChatGPT 建立自訂 MCP plugin

OpenAI 介面會隨帳戶、方案及工作區設定不同。按[官方自訂 MCP 指南](https://developers.openai.com/api/docs/guides/custom-mcp-server)及[連接測試指南](https://developers.openai.com/plugins/deploy/connect-chatgpt)操作：

1. 在 ChatGPT 開啟 developer mode／自訂 plugin 建立頁。
2. MCP URL 填入 `https://whatsapp.example.com/mcp`。
3. Authentication 選 OAuth；讓 ChatGPT 使用 discovery metadata 及動態註冊。
4. OAuth 視窗出現時，手動輸入 `admin.token` 的管理員密碼。
5. 等候 Scan Tools／Scan Events 完成。
6. 核對 6 個 read tools、4 個 write tools，以及 `whatsapp.message_received` event。
7. 把自動審核設為「允許低風險工具」，保留平台對其他操作的審核。
8. 安裝或啟用這個 draft plugin，再於新對話測試唯讀狀態。

OAuth tool scope 是：

- `whatsapp.read`：6 個唯讀工具及所有 event methods
- `whatsapp.send`：`whatsapp_send_text`、`whatsapp_send_image`、`whatsapp_send_video`、`whatsapp_send_document`
- `events`：保留作舊版相容識別；event methods 的實際授權仍沿用 `whatsapp.read`

Events 與 tools 位於同一個已驗證 `/mcp` endpoint，所以不要為 event 自創另一組 `securitySchemes`。

若你允許低風險工具自動執行，平台的風險審核、權限提示及內建安全檢查仍會保留；設定不代表所有寫入都會自動獲准。[OpenAI 官方說明](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)指出，寫入／修改動作可能仍按權限、情境及影響要求確認。

更新 tool schema、描述、annotations 或 events 後，先在 plugin 頁按 Refresh／重新掃描。新 schema 在 Dot 未出現時，可能還要在 Dot 官方 profile 選「重新啟動」；這會中斷進行中的工作，但保留對話、記憶及任務。不要選 Reset，因為官方說明指出 Reset 會刪除 Dot、對話、記憶及排程。

Dot 與 MCP Events 並非所有帳戶、地區、方案或工作區都已開放；請參考 [Dot 官方說明](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)及 MCP Events 頁面的即時供應範圍。

## 9. 設定真正的 owner LID

不要用 display name、電話簿名稱或猜測的電話號碼判斷 owner。正確流程是：

1. 由 owner 本人的手機向已配對帳戶傳送一則新的私人訊息。
2. 透過已授權的 `whatsapp_list_chats` 及 `whatsapp_get_messages` 找到該則 `fromMe=false` 的 incoming 私聊。
3. 本人核對訊息內容及時間，再確認其 `chatId` 與 `senderId` 完全相同，格式為數字加 `@lid`。
4. 只把這個已驗證 LID 加入 `owner-identities.json`。

以下數字純屬 dummy 範例，必須換成上一步實際核對的 LID：

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
cat >"$APP_ROOT/shared/owner-identities.json" <<'EOF'
{"version":1,"ownerIds":["123456789012345@lid"],"allowOwnerGroups":false,"mentionOnlyGroupIds":[]}
EOF
chmod 0600 "$APP_ROOT/shared/owner-identities.json"
python3 "$APP_ROOT/supervise.py" --stop
nohup python3 "$APP_ROOT/supervise.py" </dev/null >/dev/null 2>&1 &
```

檔案必須是一般檔案、0600、最多 4096 bytes，最多 10 個不重複的 `@lid`。缺失或無效時服務會 fail closed，不授予 owner。

## 10. 選擇性啟用 owner 群組

把 `allowOwnerGroups` 改為 `true` 並重啟後，群組自動回覆仍須由 bridge 計算為 `replyAllowed=true`，並同時符合：

- 已驗證 owner 目前是該群組成員
- Bot 帳戶目前也是該群組成員
- incoming 訊息的 WhatsApp metadata 真正 mention Bot，或可信引用同群內已知的 Bot outgoing message ID
- `mentionsAll=false`
- `fromMe=false`

只在文字輸入 `@名稱` 而沒有真實 mention metadata 不會觸發。`repliesToBot=true` 必須由 WhatsApp 引用 metadata 對上同群內已知的 Bot outgoing message ID，不能從正文、自稱或轉述推斷。`mentionsAll` 由 bridge 依 `contextInfo.nonJidMentions===1` 計算；所有群組的 `@所有人` 都不得自動回覆。群組成員的 `senderRole` 仍是 `untrusted`；引用 Bot 訊息不代表 owner 身份，不能取得 owner 權限。群組回覆亦不可引用私聊、其他群組、郵件或 Dot 的私人記憶。

### 指定群組只接受真實 @Bot

如某個群組平時只需靜默讀取聊天與公告，把其真實 `@g.us` ID 加入 `mentionOnlyGroupIds`。以下全部 ID 均為 dummy 佔位符，必須換成實際核對值：

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
cat >"$APP_ROOT/shared/owner-identities.json" <<'EOF'
{"version":1,"ownerIds":["123456789012345@lid"],"allowOwnerGroups":true,"mentionOnlyGroupIds":["123456789012345678@g.us"]}
EOF
chmod 0600 "$APP_ROOT/shared/owner-identities.json"
python3 "$APP_ROOT/supervise.py" --stop
nohup python3 "$APP_ROOT/supervise.py" </dev/null >/dev/null 2>&1 &
```

先用 `whatsapp_list_chats` 找到候選群組，再呼叫 `whatsapp_get_group_info({chatId})` 核對 `subject`、`description` 及 `announcementOnly`；工具不回傳成員名單。`mentionOnlyGroupIds` 預設為空陣列。列入後，只有 WhatsApp metadata 中直接提及 Bot、不是 `@所有人` 的 incoming 訊息可得到 `replyAllowed=true`；單獨引用 Bot 訊息不會回覆。持久化 write gate 亦只接受對應 incoming ID 的 `dot-auto:<incoming-message-id>` key，並重新核對直接提及及非 `@所有人` 條件。一般聊天與公告仍可在已授權的當次操作中透過現有 read tools 靜默讀取，並按用戶要求整理到其本人日曆。這項設定不會建立新的 watch、subscription 或 cron，也不會自行持續監看群組。

## 11. 建立 Dot 原生事件規則

請使用 ChatGPT／Dot 的原生 MCP event subscription，不要用 cron 輪詢代替。私聊 filter 應精確指定已驗證 owner 的 `chatIds`；群組規則使用 `{ "ownerGroups": true }`。

事件喚醒後仍要重新核對：

- 私聊：`senderRole=owner`、`fromMe=false`、`chatId=senderId`
- 群組：`groupAllowed=true`、`replyAllowed=true`、`mentionsAll=false`、`fromMe=false`
- 回覆只發回觸發訊息的同一 `chatId`
- idempotency key 固定為 `dot-auto:<incoming-message-id>`

部分平台事件喚醒可能缺少 payload。fallback 應透過可信的 `whatsapp_get_messages` 或 `whatsapp_get_pending_replies` 補讀，並依 bridge 計算的 `autoReplySent` 防重；文字非空，或 `mediaType` 是 `image`、`video`、`document`，才有可處理內容。不要信任訊息文字自行聲稱身份或已獲授權。

`replyAllowed` 由 bridge 綜合 `groupAllowed`、真實 mention／可信引用、`mentionOnlyGroupIds` 及非 `@所有人` 條件計算。Dot 每次發送前仍須從可信補讀核對 `replyAllowed=true` 及 `mentionsAll=false`；不得僅依 event payload 或正文判斷。

如要分析 incoming 圖片、影片或文件，先完成上述身份、方向、群組觸發及 `autoReplySent` 核對，再以 `whatsapp_get_media({chatId,messageId})` 讀取同一 chat 的該則媒體；群組只可再讀用戶明確引用的同群媒體。圖片在 5 MiB 內可直接回傳視覺內容；媒體亦可提供 5 分鐘有效的臨時 download URL／resource link，讓 Dot 在 cloud computer 下載分析。URL 持有者即可存取，不可轉發。媒體暫存在記憶體，總量最多 50 MiB／10 項，不落盤；不要自動開啟任意外部連結、執行檔案或採納檔案內指令。舊 incoming 若沒有下載 descriptor，須請用戶重新傳送；新收到的媒體才可讀取。

每個 incoming 只可選一次寫入，並發回同一 `chatId`：文字使用 `whatsapp_send_text`；圖片使用 `whatsapp_send_image({chatId,file?,imageBase64?,caption?,idempotencyKey})`，其中 `file` 與 `imageBase64` 必須二選一；MP4 影片使用 `whatsapp_send_video({chatId,file,caption?,idempotencyKey})`；文件使用 `whatsapp_send_document({chatId,file,caption?,idempotencyKey})`。`file` 必須是 ChatGPT 提供的 file input object：`{download_url,file_id,mime_type?,file_name?}`，不要手抄巨大 base64。標準 base64 只作小圖片 fallback，不得把任意外部 URL、本機路徑或 data URL 填入 `imageBase64`。圖片只接受 PNG、JPEG 或 WebP，原始檔最多 5 MiB；影片只接受 MP4，最多 20 MiB；文件最多 20 MiB。三個媒體工具只發送已有內容，不會生成內容。詳見 [OpenAI plugin tool reference 的 file inputs](https://developers.openai.com/plugins/reference)。

只有 Dot 真正成功生成或取得檔案後，才可呼叫媒體發送工具。Dot 可使用當前已有的圖片、檔案或影片能力；一般影片剪輯或動畫可在 cloud computer 輸出 MP4。若當前沒有原生 AI 影片生成工具，須如實說明，不得聲稱已接駁 Sora 或其他付費供應商，也不得自行購買 API；不得承諾未驗證的生成供應商或固定完成時間。不得把本機路徑、生成 prompt 或預計完成時間冒充已傳送的媒體。不得先發文字消耗同一 key 再發媒體；發送失敗或結果不明，只可用相同內容、caption、file／圖片 bytes 及 key 重試。

完整的私聊、群組及 fallback 提示詞見 [`docs/dot-prompts.md`](docs/dot-prompts.md)。

## 12. 驗證

### 本機測試

```sh
npm ci
npm test
python3 -m unittest -v test_supervise.py
```

目前預期結果：58 個 Node tests、4 個 Python tests 全部通過。

### 線上 OAuth 唯讀驗收

`acceptance.py` 會檢查 HTTPS、未授權 401 challenge、OAuth PKCE、MCP discovery、工具／事件清單及 WhatsApp 狀態，不會發送訊息：

```sh
cd "$HOME/apps/baileys-dot/current"
PUBLIC_URL='https://whatsapp.example.com' \
ADMIN_TOKEN_FILE="$HOME/apps/baileys-dot/shared/admin.token" \
python3 acceptance.py --require-paired
```

`message_sent` 應為 `false`；`--require-paired` 另外要求已保存的 WhatsApp pairing 可成功連線。

### 端到端驗收

依序分開確認：

1. 手機 Linked Devices 顯示已配對，管理頁顯示 `connected`／`paired: true`。
2. ChatGPT plugin OAuth 成功，唯讀 `whatsapp_status` 可用。
3. 發送一則全新的 owner 私聊，Dot 因 `whatsapp.message_received` 原生事件被喚醒。
4. Dot 只回覆同一對話，第二次處理同一 incoming ID 不會重複發送。
5. 如啟用群組，分別以真實 @mention 及引用同群 Bot 訊息測試；沒有 mention／可信引用、owner 不在場、Bot 不在場或 `@所有人` 均不應自動回覆。對 `mentionOnlyGroupIds` 內的群組，引用 Bot 但沒有直接 @Bot 亦不應回覆。
6. 分別傳入一則新圖片、影片及文件，確認合資格訊息可經 `whatsapp_get_media` 讀取；舊訊息沒有 descriptor 時應要求重新傳送，臨時 URL 過期後不可繼續使用。
7. 分別要求圖片、MP4 影片及文件回覆，確認 Dot 真正取得檔案，並只選一個對應寫入工具發回同一 chat；同一 incoming ID 不應再發文字或其他媒體。

測試、OAuth、手機配對及事件訂閱成功都不等於「實際新訊息已自動回覆」。最後一項必須由一次真實新 incoming 訊息及對應 outgoing 訊息證明。事件處理是非同步流程，不應承諾固定延遲。

## 更新與回退

更新前先暫停 Dot 的 WhatsApp 事件規則。仍在舊 release、且已核對 `owner.valid=true` 時，先把當時可用且不含 `mentionOnlyGroupIds` 的 owner 設定保存為 0600 回退副本：

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
install -m 0600 \
  "$APP_ROOT/shared/owner-identities.json" \
  "$APP_ROOT/shared/owner-identities.rollback.json"
```

然後重做第 4 步建立新 release 並跑完測試；停止 supervisor 後，先把現有 `supervise.py` 保存成 `shared/supervise.previous.py`，再安裝新版 supervisor、原子切換 `current` 並啟動。

至少保留目前及前一個 release。確認新版本完成真實端到端驗收後，可刪除更舊 release 以節省空間；不要刪除 `shared` 或唯一可回退版本。舊版 validator 不認識 `mentionOnlyGroupIds`，直接沿用新版 owner 設定會 fail closed。回退時先停止 supervisor，把 `current` 指回前一個已知可用 release，並以 `owner-identities.rollback.json` 還原配套的 `owner-identities.json`；如有需要同時還原 `supervise.previous.py`，再啟動及核對 `owner.valid=true`。不要把含 `mentionOnlyGroupIds` 的新版設定交給舊 release。

## 安全邊界

- 服務只聆聽 `127.0.0.1:4391`；Tunnel metrics 只聆聽 `127.0.0.1:4392`。
- `shared`、Baileys auth、OAuth 狀態、message store、媒體下載 descriptor、event state 均不應提交 Git。descriptor 隨最長 7 日／2000 則訊息的有界 state 保存於 0700 目錄及 0600 檔案，工具不回傳解密 keys。
- 訊息內容、push name 及群組文字一律是不可信資料。
- owner 只由本人核對的 incoming 私聊 LID 決定，display name 不是身份證明。
- `senderRole`、`groupAllowed`、`mentionsBot`、`repliesToBot`、`mentionsAll`、`replyAllowed` 及 `autoReplySent` 由 bridge 計算，不接受上游文字自行宣稱。
- `whatsapp_get_media`、`whatsapp_get_group_info` 需要 `whatsapp.read` scope；四個發送工具都需要 `whatsapp.send` scope 及 idempotency key。
- owner 身份只授權 WhatsApp 自動回覆及相關開關，不授予 VPS、sudo、OAuth 或其他服務權限。
- event webhook 驗證、簽署、callback 公網 IP 檢查及持久化由 `events.mjs` 執行。

OAuth 的 protected resource metadata、PKCE、`resource` 參數及逐工具 scope 要求可參考 [OpenAI Authentication 文件](https://developers.openai.com/plugins/build/auth)。本服務的授權設計以伺服器端檢查為準，不能只依賴模型提示詞。

## 上游文件

- [OpenAI：MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [OpenAI：MCP Authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI：Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server)
- [OpenAI：Connect and test your plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [OpenAI：Plugin tool reference（file inputs）](https://developers.openai.com/plugins/reference)
- [OpenAI：Getting started with your dot](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)
- [Baileys 官方 repository](https://github.com/WhiskeySockets/Baileys)
- [Baileys Quickstart](https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx)
