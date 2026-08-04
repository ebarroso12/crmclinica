"""Contrato fechado com o protocolo OpenAI Realtime do speech-to-speech."""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

CLIENT_EVENTS = frozenset({"input_audio_buffer.append"})
AUDIO_LIMIT_B64 = 192_000
TRANSCRIPT_EVENTS = {
    "conversation.item.input_audio_transcription.completed": "usuario",
    "response.output_audio_transcript.done": "serena",
    "response.audio_transcript.done": "serena",
}


def safe_client_event(raw: str, maximum_bytes: int) -> str | None:
    if len(raw.encode()) > maximum_bytes:
        raise ValueError("mensagem excede o limite")
    try:
        event = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError("evento JSON inválido") from exc
    if event.get("type") not in CLIENT_EVENTS:
        return None
    audio = event.get("audio")
    if not isinstance(audio, str) or not audio or len(audio) > AUDIO_LIMIT_B64:
        raise ValueError("bloco de áudio inválido")
    return json.dumps({"type": "input_audio_buffer.append", "audio": audio}, separators=(",", ":"))


def session_update(instructions: str, voice: str) -> str:
    # O schema do servidor é estrito; só envia campos confirmados no projeto oficial.
    return json.dumps({
        "type": "session.update",
        "session": {
            "type": "realtime",
            "instructions": instructions,
            "audio": {"output": {"voice": voice}},
        },
    }, separators=(",", ":"))


class TranscriptCollector:
    def __init__(self) -> None:
        self._deltas: dict[str, list[str]] = defaultdict(list)

    def feed(self, event: dict[str, Any]) -> tuple[str, str, str] | None:
        event_type = event.get("type")
        event_key = str(event.get("item_id") or event.get("response_id") or event.get("event_id") or "turn")
        if event_type in {
            "conversation.item.input_audio_transcription.delta",
            "response.output_audio_transcript.delta",
            "response.audio_transcript.delta",
        } and isinstance(event.get("delta"), str):
            self._deltas[event_key].append(event["delta"])
            return None
        role = TRANSCRIPT_EVENTS.get(event_type)
        if not role:
            return None
        transcript = event.get("transcript")
        if not isinstance(transcript, str) or not transcript.strip():
            transcript = "".join(self._deltas.pop(event_key, []))
        else:
            self._deltas.pop(event_key, None)
        transcript = transcript.strip()
        if not transcript:
            return None
        return role, transcript[:8000], event_key
