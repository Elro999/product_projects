"""Telegram delivery. Needs TELEGRAM_BOT_TOKEN in the environment (see README)."""
from __future__ import annotations

import json
import os
import urllib.request


def send(chat_id: str, text: str, token: str | None = None) -> bool:
    token = token or os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token or not chat_id:
        return False
    body = json.dumps({"chat_id": chat_id, "text": text}).encode()
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body, headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response).get("ok", False)
