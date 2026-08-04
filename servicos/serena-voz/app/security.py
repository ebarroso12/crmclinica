"""Primitivas pequenas, sem dependência, para JWT HS256 e HMAC de webhook."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_session_token(token: str, secret: str, now: int | None = None) -> dict[str, Any]:
    if not token or not secret:
        raise ValueError("token ausente")
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("token malformado")
    header, payload, signature = parts
    expected = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    try:
        received = _b64url_decode(signature)
        claims = json.loads(_b64url_decode(payload))
        algorithm = json.loads(_b64url_decode(header)).get("alg")
    except (ValueError, json.JSONDecodeError) as exc:
        raise ValueError("token malformado") from exc
    if algorithm != "HS256" or not hmac.compare_digest(received, expected):
        raise ValueError("assinatura inválida")
    current = int(time.time()) if now is None else now
    if not isinstance(claims.get("exp"), int) or claims["exp"] <= current:
        raise ValueError("token expirado")
    if claims.get("typ") != "serena_voz" or claims.get("aud") != "serena-voz-gateway":
        raise ValueError("escopo inválido")
    if not isinstance(claims.get("sid"), str) or not claims["sid"].startswith("sv_"):
        raise ValueError("sessão inválida")
    return claims


def webhook_signature(body: bytes, timestamp: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"
