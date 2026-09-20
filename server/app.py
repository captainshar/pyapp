"""Captions kiosk server.

Serves the caption page and relays microphone audio to Deepgram's streaming
speech-to-text, adding speaker labels (diarization) on the way back.

Nothing is stored. Audio is forwarded frame by frame and dropped; transcripts
exist only in the browser tab and vanish when it closes.
"""

import asyncio
import json
import logging
import os
from pathlib import Path
from urllib.parse import urlencode

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("captions")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "").strip()
DEEPGRAM_MODEL = os.environ.get("DEEPGRAM_MODEL", "nova-3")
DEEPGRAM_LANGUAGE = os.environ.get("DEEPGRAM_LANGUAGE", "en-US")

# The browser's AudioWorklet sends mono 16-bit PCM at this rate.
SAMPLE_RATE = 16000

# Deepgram closes an idle socket after ~10s. Pausing stops the audio, so the
# relay sends a keepalive well inside that window to hold the connection open.
KEEPALIVE_SECONDS = 5.0

app = FastAPI(title="Captions")


def deepgram_url() -> str:
    params = {
        "model": DEEPGRAM_MODEL,
        "language": DEEPGRAM_LANGUAGE,
        "encoding": "linear16",
        "sample_rate": SAMPLE_RATE,
        "channels": 1,
        # Speaker labels. This is the whole reason for the server hop.
        "diarize": "true",
        # Partial results keep the screen moving like TV captions instead of
        # sitting blank until someone finishes a sentence.
        "interim_results": "true",
        "punctuate": "true",
        "smart_format": "true",
    }
    return "wss://api.deepgram.com/v1/listen?" + urlencode(params)


async def connect_deepgram():
    """Open the upstream socket, tolerating either websockets API generation."""
    url = deepgram_url()
    headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}
    try:
        return await websockets.connect(url, additional_headers=headers)
    except TypeError:  # websockets < 14 spells it differently
        return await websockets.connect(url, extra_headers=headers)


@app.get("/api/config")
async def config():
    """Tells the page which engine to drive."""
    return {
        "engine": "deepgram" if DEEPGRAM_API_KEY else "webspeech",
        "language": DEEPGRAM_LANGUAGE,
        "sampleRate": SAMPLE_RATE,
    }


def extract_caption(payload: dict):
    """Turn a Deepgram Results message into the minimal shape the page draws.

    Returns None for the empty results Deepgram emits during silence.
    """
    if payload.get("type") != "Results":
        return None

    alt = (payload.get("channel") or {}).get("alternatives") or [{}]
    alt = alt[0]
    transcript = (alt.get("transcript") or "").strip()
    if not transcript:
        return None

    # With diarize=true every word carries a speaker index. Group consecutive
    # words by speaker so one utterance from two people renders as two blocks.
    segments = []
    for word in alt.get("words") or []:
        speaker = word.get("speaker")
        text = word.get("punctuated_word") or word.get("word") or ""
        if not text:
            continue
        if segments and segments[-1]["speaker"] == speaker:
            segments[-1]["text"] += " " + text
        else:
            segments.append({"speaker": speaker, "text": text})

    if not segments:
        # No word-level detail (rare, and on interim results for some models).
        segments = [{"speaker": None, "text": transcript}]

    return {
        "type": "caption",
        "isFinal": bool(payload.get("is_final")),
        "segments": segments,
    }


@app.websocket("/ws/transcribe")
async def transcribe(client: WebSocket):
    await client.accept()

    if not DEEPGRAM_API_KEY:
        await client.send_text(json.dumps({"type": "error", "reason": "no-api-key"}))
        await client.close()
        return

    try:
        upstream = await connect_deepgram()
    except Exception as exc:
        log.warning("deepgram connect failed: %s", exc)
        await client.send_text(json.dumps({"type": "error", "reason": "upstream"}))
        await client.close()
        return

    await client.send_text(json.dumps({"type": "ready", "engine": "deepgram"}))

    async def pump_audio():
        """Browser -> Deepgram."""
        while True:
            message = await client.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await upstream.send(message["bytes"])
            elif message.get("text"):
                # The page sends {"type":"stop"} when it is done talking.
                if json.loads(message["text"]).get("type") == "stop":
                    break
        # Ask Deepgram to flush whatever is buffered before we tear down.
        await upstream.send(json.dumps({"type": "CloseStream"}))

    async def pump_captions():
        """Deepgram -> browser."""
        async for raw in upstream:
            if isinstance(raw, bytes):
                continue
            caption = extract_caption(json.loads(raw))
            if caption:
                await client.send_text(json.dumps(caption))

    async def keepalive():
        while True:
            await asyncio.sleep(KEEPALIVE_SECONDS)
            await upstream.send(json.dumps({"type": "KeepAlive"}))

    tasks = [asyncio.create_task(c()) for c in (pump_audio, pump_captions, keepalive)]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                log.warning("relay ended: %s", exc)
    finally:
        await upstream.close()
        try:
            await client.close()
        except RuntimeError:
            pass  # already closed from the other end


@app.get("/")
async def index():
    # No-store so a kiosk tablet never boots into a stale cached build.
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")


def main():
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))


if __name__ == "__main__":
    main()
