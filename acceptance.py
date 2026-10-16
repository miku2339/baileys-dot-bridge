#!/usr/bin/env python3
"""Read-only live acceptance using the owner's existing local credential file."""

import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


BASE = os.environ.get("PUBLIC_URL", "https://whatsapp.example.com").rstrip("/")
APP_ROOT = Path(os.environ.get("APP_ROOT", Path(__file__).resolve().parent))
ADMIN_TOKEN_FILE = Path(os.environ.get("ADMIN_TOKEN_FILE", APP_ROOT / "shared" / "admin.token"))
RESOURCE = BASE + "/mcp"
REDIRECT = "https://chatgpt.com/connector_platform/oauth/callback"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect)


def request(path, payload=None, form=False, token=None):
    headers = {"User-Agent": "Mozilla/5.0 WhatsApp-Bridge-Acceptance"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None
    if payload is not None:
        body = urllib.parse.urlencode(payload).encode() if form else json.dumps(payload).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
    req = urllib.request.Request(BASE + path, data=body, headers=headers)
    try:
        return opener.open(req, timeout=20)
    except urllib.error.HTTPError as error:
        return error


def main():
    response = request("/healthz")
    assert response.status == 200 and json.load(response) == {"ok": True}
    response = request("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert response.status == 401 and "resource_metadata" in response.headers.get("WWW-Authenticate", "")
    metadata = json.load(request("/.well-known/oauth-protected-resource/mcp"))
    assert metadata["resource"] == RESOURCE
    response = request("/oauth/register", {"client_name": "Deployment acceptance", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"})
    assert response.status == 201
    client = json.load(response)["client_id"]
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    query = urllib.parse.urlencode({"response_type": "code", "client_id": client, "redirect_uri": REDIRECT, "scope": "whatsapp.read", "state": secrets.token_hex(12), "code_challenge": challenge, "code_challenge_method": "S256", "resource": RESOURCE})
    response = request("/oauth/authorize?" + query)
    assert response.status == 200
    csrf = re.search(r'name="csrf" value="([^"]+)"', response.read().decode()).group(1)
    credential = ADMIN_TOKEN_FILE.read_text().strip()
    response = request("/oauth/authorize", {"csrf": csrf, "admin_token": credential}, form=True)
    assert response.status == 303
    code = urllib.parse.parse_qs(urllib.parse.urlparse(response.headers["Location"]).query)["code"][0]
    response = request("/oauth/token", {"grant_type": "authorization_code", "code": code, "client_id": client, "redirect_uri": REDIRECT, "code_verifier": verifier, "resource": RESOURCE}, form=True)
    assert response.status == 200
    token = json.load(response)["access_token"]
    result = {}
    for method, params in [("initialize", {}), ("server/discover", {}), ("tools/list", {}), ("events/list", {}), ("tools/call", {"name": "whatsapp_status", "arguments": {}})]:
        response = request("/mcp", {"jsonrpc": "2.0", "id": 2, "method": method, "params": params}, token=token)
        assert response.status == 200, (method, response.status)
        payload = json.load(response)
        assert "error" not in payload, method
        value = payload["result"]
        if method == "tools/list": result["tools"] = [item["name"] for item in value["tools"]]
        elif method == "events/list": result["events"] = [item["name"] for item in value["events"]]
        elif method == "tools/call":
            state = value["structuredContent"]
            result["whatsapp"] = {"status": state["status"], "paired": state["paired"]}
        else: result[method] = "passed"
    result["https"] = "verified"
    result["unauthorized"] = "401"
    result["oauth_pkce"] = "passed"
    result["message_sent"] = False
    if "--require-paired" in sys.argv:
        for _ in range(30):
            if result["whatsapp"] == {"status": "connected", "paired": True}:
                break
            time.sleep(1)
            response = request("/mcp", {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "whatsapp_status", "arguments": {}}}, token=token)
            state = json.load(response)["result"]["structuredContent"]
            result["whatsapp"] = {"status": state["status"], "paired": state["paired"]}
        assert result["whatsapp"] == {"status": "connected", "paired": True}, "WhatsApp has not connected with its saved pairing"
    print(json.dumps(result))


if __name__ == "__main__":
    main()
