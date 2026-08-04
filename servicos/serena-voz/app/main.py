"""Proxy WebSocket entre o CRM e o motor livre speech-to-speech."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid

import httpx
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .protocol import TranscriptCollector, safe_client_event, session_update
from .security import verify_session_token, webhook_signature

app = FastAPI(title="Serena Voz Gateway", docs_url=None, redoc_url=None)

CRM_BASE_URL = os.getenv("CRM_BASE_URL", "").rstrip("/")
CONTEXT_PATH = os.getenv("CRM_CONTEXT_PATH", "/api/serena/voz/contexto")
EVENTS_PATH = os.getenv("CRM_EVENTS_PATH", "/api/serena/voz/eventos")
JWT_SECRET = os.getenv("SERENA_VOZ_JWT_SECRET", "")
WEBHOOK_SECRET = os.getenv("SERENA_VOZ_WEBHOOK_SECRET", "")
UPSTREAM_URL = os.getenv("SPEECH_TO_SPEECH_WS_URL", "ws://127.0.0.1:8080/v1/realtime")
ALLOWED_ORIGINS = frozenset(value.strip() for value in os.getenv("ALLOWED_ORIGINS", "").split(",") if value.strip())
MAX_SESSION_SECONDS = min(int(os.getenv("MAX_SESSION_SECONDS", "900")), 3600)
MAX_MESSAGE_BYTES = min(int(os.getenv("MAX_CLIENT_MESSAGE_BYTES", "262144")), 1_048_576)
SESSION_SLOTS = asyncio.Semaphore(min(int(os.getenv("MAX_CONCURRENT_SESSIONS", "2")), 20))


@app.get("/health")
async def health() -> dict[str, object]:
    configured = bool(CRM_BASE_URL and JWT_SECRET and WEBHOOK_SECRET and ALLOWED_ORIGINS)
    return {"status": "ok" if configured else "not_configured", "configured": configured}


async def fetch_context(token: str) -> dict[str, object]:
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.get(f"{CRM_BASE_URL}{CONTEXT_PATH}", headers={"authorization": f"Bearer {token}"})
        response.raise_for_status()
        return response.json()


async def persist_transcript(session_id: str, role: str, transcript: str, source_id: str) -> None:
    payload = json.dumps({
        "event_id": f"stt:{session_id}:{hashlib.sha256(f'{source_id}:{role}'.encode()).hexdigest()[:24]}",
        "session_id": session_id,
        "role": role,
        "transcript": transcript,
        "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, ensure_ascii=False, separators=(",", ":")).encode()
    timestamp = str(int(time.time()))
    headers = {
        "content-type": "application/json",
        "x-serena-voz-timestamp": timestamp,
        "x-serena-voz-signature": webhook_signature(payload, timestamp, WEBHOOK_SECRET),
    }
    async with httpx.AsyncClient(timeout=10) as client:
        response = await client.post(f"{CRM_BASE_URL}{EVENTS_PATH}", content=payload, headers=headers)
        response.raise_for_status()


async def reject(websocket: WebSocket, code: int, reason: str) -> None:
    await websocket.close(code=code, reason=reason[:120])


@app.websocket("/v1/realtime")
async def realtime(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin", "")
    if origin not in ALLOWED_ORIGINS:
        await websocket.accept()
        await reject(websocket, 4403, "origem não autorizada")
        return
    token = websocket.query_params.get("token", "")
    try:
        claims = verify_session_token(token, JWT_SECRET)
        context = await fetch_context(token)
    except Exception:
        await websocket.accept()
        await reject(websocket, 4401, "sessão inválida")
        return

    await websocket.accept()
    acquired = False
    try:
        await asyncio.wait_for(SESSION_SLOTS.acquire(), timeout=3)
        acquired = True
    except TimeoutError:
        await reject(websocket, 4429, "capacidade temporariamente esgotada")
        return

    try:
        try:
            async with asyncio.timeout(MAX_SESSION_SECONDS):
                async with websockets.connect(UPSTREAM_URL, max_size=2_097_152, open_timeout=15) as upstream:
                    await upstream.send(session_update(str(context["instructions"]), str(context.get("voice") or "serena")))
                    collector = TranscriptCollector()

                    async def browser_to_engine() -> None:
                        while True:
                            raw = await websocket.receive_text()
                            safe = safe_client_event(raw, MAX_MESSAGE_BYTES)
                            if safe is not None:
                                await upstream.send(safe)

                    async def engine_to_browser() -> None:
                        async for raw in upstream:
                            await websocket.send_text(raw)
                            try:
                                event = json.loads(raw)
                            except json.JSONDecodeError:
                                continue
                            completed = collector.feed(event)
                            if completed:
                                role, transcript, source_id = completed
                                await persist_transcript(str(claims["sid"]), role, transcript, source_id)

                    tasks = {
                        asyncio.create_task(browser_to_engine()),
                        asyncio.create_task(engine_to_browser()),
                    }
                    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                    for task in pending:
                        task.cancel()
                    await asyncio.gather(*pending, return_exceptions=True)
                    for task in done:
                        error = task.exception()
                        if error and not isinstance(error, (WebSocketDisconnect, websockets.ConnectionClosed)):
                            raise error
        except (WebSocketDisconnect, websockets.ConnectionClosed):
            pass
        except TimeoutError:
            await reject(websocket, 4408, "tempo máximo atingido")
        except Exception:
            await reject(websocket, 1011, f"falha da sessão {uuid.uuid4().hex[:8]}")
    finally:
        if acquired:
            SESSION_SLOTS.release()
