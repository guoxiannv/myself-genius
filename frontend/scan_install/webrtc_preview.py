from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable
from uuid import uuid4

from aiortc import (
    RTCConfiguration,
    RTCDataChannel,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)

from scan_install.live_preview import LiveInputRateLimitError, LivePreviewError, LocalLivePreview


DEFAULT_STUN_URLS = ("stun:stun.cloudflare.com:3478",)
FRAME_CHUNK_BYTES = 16 * 1024
MAX_BUFFERED_BYTES = 64 * 1024


class WebRTCPreviewError(RuntimeError):
    """A recoverable WebRTC setup error; the browser should fall back to REST."""


@dataclass
class _PendingInput:
    request_id: str
    after_sequence: int
    received_at: float


@dataclass
class _Peer:
    peer_id: str
    run_id: str
    pc: RTCPeerConnection
    network_fields: dict[str, str]
    signaling_id: str
    created_at: float = field(default_factory=time.monotonic)
    channel: RTCDataChannel | None = None
    answer_payload: dict[str, Any] | None = None
    sender_task: asyncio.Task[None] | None = None
    pending_inputs: list[_PendingInput] = field(default_factory=list)
    inputs_in_flight: int = 0
    diagnostics: dict[str, Any] = field(default_factory=dict)
    dropped_frames: int = 0
    last_drop_log_at: float = 0.0


def candidate_types(sdp: str) -> list[str]:
    return sorted(set(re.findall(r"\btyp\s+(host|srflx|prflx|relay)\b", sdp)))


class WebRTCPreviewManager:
    """Run aiortc on one event loop and bridge device JPEG frames over a DataChannel."""

    def __init__(
        self,
        preview: LocalLivePreview,
        *,
        logger: Callable[[dict[str, Any]], None] | None = None,
        stun_urls: tuple[str, ...] | None = None,
        max_peers: int | None = None,
    ) -> None:
        self.preview = preview
        self.logger = logger or (lambda _payload: None)
        configured_stun = os.environ.get("HP_WEBRTC_STUN_URLS", "").strip()
        self.stun_urls = (
            stun_urls
            if stun_urls is not None
            else tuple(item.strip() for item in configured_stun.split(",") if item.strip())
            or DEFAULT_STUN_URLS
        )
        self.max_peers = max(1, max_peers or int(os.environ.get("HP_WEBRTC_MAX_PEERS", "16")))
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()
        self._peers: dict[str, _Peer] = {}
        self._signaling_peers: dict[tuple[str, str], str] = {}

    def config_payload(self) -> dict[str, Any]:
        return {
            "available": True,
            "ice_servers": [{"urls": list(self.stun_urls)}],
            "connect_timeout_ms": 10_000,
            "transport": "datachannel-jpeg",
        }

    def create_answer(
        self,
        *,
        run_id: str,
        sdp: str,
        description_type: str,
        signaling_id: str = "",
        network_fields: dict[str, str] | None = None,
        timeout_sec: float = 20,
    ) -> dict[str, Any]:
        if description_type != "offer" or not sdp or len(sdp) > 200_000:
            raise WebRTCPreviewError("WebRTC offer 无效。")
        signaling_id = signaling_id.strip()[:64] or uuid4().hex
        if not re.fullmatch(r"[A-Za-z0-9_-]+", signaling_id):
            raise WebRTCPreviewError("WebRTC signaling_id 无效。")
        loop = self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(
            self._create_answer(
                run_id=run_id,
                sdp=sdp,
                description_type=description_type,
                signaling_id=signaling_id,
                network_fields=network_fields or {},
            ),
            loop,
        )
        try:
            return future.result(timeout=timeout_sec)
        except TimeoutError as exc:
            future.cancel()
            raise WebRTCPreviewError("WebRTC 信令超时，已回退 REST。") from exc
        except WebRTCPreviewError:
            raise
        except Exception as exc:
            raise WebRTCPreviewError(f"WebRTC 建连失败：{exc}") from exc

    def close(self) -> None:
        if not self._loop:
            return
        future = asyncio.run_coroutine_threadsafe(self._close_all(), self._loop)
        try:
            future.result(timeout=5)
        except Exception:
            pass

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop and self._thread and self._thread.is_alive():
            return self._loop
        with self._start_lock:
            if self._loop and self._thread and self._thread.is_alive():
                return self._loop
            ready = threading.Event()

            def run() -> None:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self._loop = loop
                ready.set()
                loop.run_forever()

            self._thread = threading.Thread(target=run, name="live-preview-webrtc", daemon=True)
            self._thread.start()
            if not ready.wait(timeout=2) or not self._loop:
                raise WebRTCPreviewError("WebRTC 事件循环启动失败。")
            return self._loop

    async def _create_answer(
        self,
        *,
        run_id: str,
        sdp: str,
        description_type: str,
        signaling_id: str,
        network_fields: dict[str, str],
    ) -> dict[str, Any]:
        signaling_key = (run_id, signaling_id)
        existing_peer_id = self._signaling_peers.get(signaling_key)
        if existing_peer_id:
            existing_peer = self._peers.get(existing_peer_id)
            if existing_peer and existing_peer.answer_payload:
                self._log(existing_peer, "webrtc_offer_reused", signaling_id=signaling_id)
                return dict(existing_peer.answer_payload)
            if existing_peer:
                raise WebRTCPreviewError("相同 WebRTC offer 正在处理中，请稍后重试。")
            self._signaling_peers.pop(signaling_key, None)
        if len(self._peers) >= self.max_peers:
            raise WebRTCPreviewError(f"WebRTC 会话已满（最多 {self.max_peers} 个）。")
        configuration = RTCConfiguration(
            iceServers=[RTCIceServer(urls=list(self.stun_urls))],
        )
        pc = RTCPeerConnection(configuration=configuration)
        peer = _Peer(
            peer_id=uuid4().hex,
            run_id=run_id,
            pc=pc,
            network_fields=network_fields,
            signaling_id=signaling_id,
        )
        self._peers[peer.peer_id] = peer
        self._signaling_peers[signaling_key] = peer.peer_id
        asyncio.create_task(self._expire_unconnected_peer(peer.peer_id, timeout_sec=30))

        @pc.on("datachannel")
        def on_datachannel(channel: RTCDataChannel) -> None:
            if channel.label != "harmony-preview":
                channel.close()
                return
            self._attach_channel(peer, channel)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            self._log(
                peer,
                "webrtc_state",
                connection_state=pc.connectionState,
                ice_connection_state=pc.iceConnectionState,
            )
            if pc.connectionState in {"failed", "closed"}:
                await self._remove_peer(peer.peer_id)
            elif pc.connectionState == "disconnected":
                asyncio.create_task(self._expire_disconnected_peer(peer.peer_id, timeout_sec=10))

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=sdp, type=description_type))
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            local = pc.localDescription
            if local is None:
                raise WebRTCPreviewError("WebRTC answer 生成失败。")
            self._log(
                peer,
                "webrtc_answer",
                remote_candidate_types=candidate_types(sdp),
                local_candidate_types=candidate_types(local.sdp),
            )
            peer.answer_payload = {
                "ok": True,
                "peer_id": peer.peer_id,
                "sdp": local.sdp,
                "type": local.type,
                "local_candidate_types": candidate_types(local.sdp),
            }
            return dict(peer.answer_payload)
        except Exception:
            await self._remove_peer(peer.peer_id)
            raise

    def _attach_channel(self, peer: _Peer, channel: RTCDataChannel) -> None:
        peer.channel = channel

        def start_sender() -> None:
            if not peer.sender_task or peer.sender_task.done():
                peer.sender_task = asyncio.create_task(self._send_frames(peer))

        @channel.on("open")
        def on_open() -> None:
            self._log(
                peer,
                "webrtc_channel",
                state="open",
                ordered=channel.ordered,
                max_retransmits=channel.maxRetransmits,
            )
            start_sender()

        @channel.on("close")
        def on_close() -> None:
            self._log(peer, "webrtc_channel", state="closed")
            if peer.sender_task:
                peer.sender_task.cancel()

        @channel.on("message")
        def on_message(message: str | bytes) -> None:
            if isinstance(message, str):
                asyncio.create_task(self._handle_message(peer, message))

        if channel.readyState == "open":
            start_sender()

    async def _handle_message(self, peer: _Peer, raw: str) -> None:
        try:
            message = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return
        kind = str(message.get("type") or "")
        if kind == "input":
            await self._handle_input(peer, message)
            return
        if kind == "diagnostic":
            peer.diagnostics = {
                key: message.get(key)
                for key in (
                    "local_candidate_type",
                    "remote_candidate_type",
                    "candidate_protocol",
                    "current_rtt_ms",
                )
            }
            self._log(peer, "webrtc_diagnostic", **peer.diagnostics)
            return
        if kind == "latency":
            self._log(
                peer,
                "webrtc_latency",
                request_id=str(message.get("request_id") or "")[:64],
                click_to_frame_ms=_safe_number(message.get("click_to_frame_ms")),
                frame_sequence=int(message.get("frame_sequence") or 0),
                frame_bytes=int(message.get("frame_bytes") or 0),
                **peer.diagnostics,
            )

    async def _handle_input(self, peer: _Peer, message: dict[str, Any]) -> None:
        channel = peer.channel
        if not channel or channel.readyState != "open":
            return
        request_id = str(message.get("request_id") or uuid4().hex)[:64]
        payload = message.get("payload")
        if not isinstance(payload, dict):
            return
        started_at = time.monotonic()
        peer.inputs_in_flight += 1
        try:
            frame = await asyncio.to_thread(self.preview.submit_input, peer.run_id, payload)
        except (LiveInputRateLimitError, LivePreviewError) as exc:
            peer.inputs_in_flight -= 1
            self._send_json(
                channel,
                {"type": "input_ack", "request_id": request_id, "ok": False, "error": str(exc)},
            )
            self._log(peer, "webrtc_input", request_id=request_id, status="error", error=str(exc))
            return
        except Exception:
            peer.inputs_in_flight -= 1
            raise
        total_ms = (time.monotonic() - started_at) * 1000
        peer.pending_inputs.append(
            _PendingInput(
                request_id=request_id,
                after_sequence=frame.sequence,
                received_at=started_at,
            )
        )
        peer.inputs_in_flight -= 1
        self._send_json(
            channel,
            {
                "type": "input_ack",
                "request_id": request_id,
                "ok": True,
                "after_sequence": frame.sequence,
                "timings": frame.timings,
            },
        )
        self._log(
            peer,
            "webrtc_input",
            request_id=request_id,
            action=str(payload.get("type") or "unknown")[:24],
            status="ok",
            request_ms=round(total_ms, 3),
            timings=frame.timings,
            **peer.diagnostics,
        )

    async def _send_frames(self, peer: _Peer) -> None:
        sequence = 0
        while peer.channel and peer.channel.readyState == "open":
            try:
                frame = await asyncio.to_thread(
                    self.preview.wait_for_frame,
                    peer.run_id,
                    after_sequence=sequence,
                    timeout_sec=1.5,
                )
                if frame.sequence <= sequence:
                    continue
                sequence = frame.sequence
                while peer.inputs_in_flight > 0:
                    await asyncio.sleep(0.002)
                eligible = [item for item in peer.pending_inputs if frame.sequence > item.after_sequence]
                sent = await self._send_frame(peer, frame, [item.request_id for item in eligible])
                if sent:
                    peer.pending_inputs = [item for item in peer.pending_inputs if item not in eligible]
            except asyncio.CancelledError:
                return
            except LivePreviewError as exc:
                self._log(peer, "webrtc_frame", status="error", error=str(exc))
                await asyncio.sleep(0.5)
            except Exception as exc:
                self._log(peer, "webrtc_frame", status="error", error=str(exc))
                await asyncio.sleep(0.5)

    async def _send_frame(self, peer: _Peer, frame: Any, request_ids: list[str]) -> bool:
        channel = peer.channel
        if not channel or channel.readyState != "open":
            return False
        if channel.bufferedAmount > MAX_BUFFERED_BYTES:
            peer.dropped_frames += 1
            now = time.monotonic()
            if now - peer.last_drop_log_at >= 30:
                self._log(
                    peer,
                    "webrtc_frame",
                    status="dropped",
                    frame_sequence=frame.sequence,
                    frame_bytes=len(frame.data),
                    buffered_bytes=channel.bufferedAmount,
                    dropped_frames=peer.dropped_frames,
                )
                peer.dropped_frames = 0
                peer.last_drop_log_at = now
            return False
        chunks = [
            frame.data[offset:offset + FRAME_CHUNK_BYTES]
            for offset in range(0, len(frame.data), FRAME_CHUNK_BYTES)
        ]
        started_at = time.monotonic()
        self._send_json(
            channel,
            {
                "type": "frame",
                "sequence": frame.sequence,
                "width": frame.width,
                "height": frame.height,
                "size": len(frame.data),
                "chunks": len(chunks),
                "stale": frame.stale,
                "request_ids": request_ids,
            },
        )
        for chunk in chunks:
            channel.send(chunk)
        if request_ids:
            self._log(
                peer,
                "webrtc_frame",
                status="ok",
                frame_sequence=frame.sequence,
                frame_bytes=len(frame.data),
                chunks=len(chunks),
                related_request_ids=request_ids,
                enqueue_ms=round((time.monotonic() - started_at) * 1000, 3),
            )
        return True

    @staticmethod
    def _send_json(channel: RTCDataChannel, payload: dict[str, Any]) -> None:
        if channel.readyState == "open":
            channel.send(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    async def _remove_peer(self, peer_id: str) -> None:
        peer = self._peers.pop(peer_id, None)
        if not peer:
            return
        if peer.sender_task and peer.sender_task is not asyncio.current_task():
            peer.sender_task.cancel()
        signaling_key = (peer.run_id, peer.signaling_id)
        if self._signaling_peers.get(signaling_key) == peer_id:
            self._signaling_peers.pop(signaling_key, None)
        if peer.pc.connectionState != "closed":
            await peer.pc.close()

    async def _expire_unconnected_peer(self, peer_id: str, *, timeout_sec: float) -> None:
        await asyncio.sleep(timeout_sec)
        peer = self._peers.get(peer_id)
        if peer and peer.pc.connectionState != "connected":
            self._log(peer, "webrtc_timeout", phase="connect")
            await self._remove_peer(peer_id)

    async def _expire_disconnected_peer(self, peer_id: str, *, timeout_sec: float) -> None:
        await asyncio.sleep(timeout_sec)
        peer = self._peers.get(peer_id)
        if peer and peer.pc.connectionState == "disconnected":
            self._log(peer, "webrtc_timeout", phase="disconnected")
            await self._remove_peer(peer_id)

    async def _close_all(self) -> None:
        for peer_id in list(self._peers):
            await self._remove_peer(peer_id)

    def _log(self, peer: _Peer, event: str, **payload: Any) -> None:
        self.logger(
            {
                "event": event,
                "peer_id": peer.peer_id,
                "run_id": peer.run_id,
                **peer.network_fields,
                **payload,
            }
        )


def _safe_number(value: Any) -> float:
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return 0.0
