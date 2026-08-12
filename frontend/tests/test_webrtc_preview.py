from __future__ import annotations

import asyncio
import json
import threading
import time
import unittest

try:
    from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
    from scan_install.live_preview import Frame
    from scan_install.webrtc_preview import WebRTCPreviewError, WebRTCPreviewManager, candidate_types
except ImportError:  # pragma: no cover - REST-only environments skip integration coverage
    RTCConfiguration = None


@unittest.skipIf(RTCConfiguration is None, "aiortc is not installed")
class WebRTCPreviewTests(unittest.TestCase):
    def test_candidate_types_are_extracted_without_addresses(self) -> None:
        sdp = "a=candidate:1 1 UDP 1 10.0.0.1 1234 typ host\r\na=candidate:2 1 UDP 1 1.2.3.4 5678 typ srflx\r\n"
        self.assertEqual(candidate_types(sdp), ["host", "srflx"])

    def test_invalid_signaling_id_is_rejected(self) -> None:
        manager = WebRTCPreviewManager(_FakePreview(), stun_urls=())
        with self.assertRaisesRegex(WebRTCPreviewError, "signaling_id"):
            manager.create_answer(
                run_id="w" * 32,
                sdp="offer-sdp",
                description_type="offer",
                signaling_id="invalid id",
            )

    def test_datachannel_delivers_frame_input_ack_and_correlated_frame(self) -> None:
        asyncio.run(self._exercise_datachannel())

    async def _exercise_datachannel(self) -> None:
        preview = _FakePreview()
        events: list[dict] = []
        manager = WebRTCPreviewManager(preview, logger=events.append, stun_urls=())
        pc = RTCPeerConnection(configuration=RTCConfiguration(iceServers=[]))
        channel = pc.createDataChannel("harmony-preview", ordered=True)
        channel_open = asyncio.Event()
        messages: list[object] = []

        @channel.on("open")
        def on_open() -> None:
            channel_open.set()

        @channel.on("message")
        def on_message(message: object) -> None:
            messages.append(message)

        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        assert pc.localDescription is not None
        answer = await asyncio.to_thread(
            manager.create_answer,
            run_id="w" * 32,
            sdp=pc.localDescription.sdp,
            description_type=pc.localDescription.type,
            signaling_id="signal-test",
        )
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
        try:
            await asyncio.wait_for(channel_open.wait(), timeout=3)
        except asyncio.TimeoutError:
            self.fail(f"channel did not open: state={channel.readyState}, events={events!r}")
        reused_answer = await asyncio.to_thread(
            manager.create_answer,
            run_id="w" * 32,
            sdp=pc.localDescription.sdp,
            description_type=pc.localDescription.type,
            signaling_id="signal-test",
        )
        self.assertEqual(reused_answer["peer_id"], answer["peer_id"])
        self.assertTrue(any(event.get("event") == "webrtc_offer_reused" for event in events))
        try:
            await _wait_until(lambda: any(isinstance(item, bytes) for item in messages))
        except TimeoutError:
            self.fail(f"frame not delivered; events={events!r}; messages={messages!r}")
        self.assertFalse(
            any(
                event.get("event") == "webrtc_frame" and event.get("status") == "ok"
                for event in events
            )
        )

        request_id = "request-1"
        channel.send(
            json.dumps(
                {
                    "type": "input",
                    "request_id": request_id,
                    "payload": {"type": "tap", "point": {"x": 0.5, "y": 0.5}},
                }
            )
        )
        await _wait_until(
            lambda: any(
                isinstance(item, str)
                and json.loads(item).get("type") == "frame"
                and request_id in json.loads(item).get("request_ids", [])
                for item in messages
            )
        )
        self.assertEqual(preview.inputs[0]["type"], "tap")
        self.assertTrue(any(event.get("event") == "webrtc_input" for event in events))
        await pc.close()
        manager.close()


class _FakePreview:
    def __init__(self) -> None:
        self.condition = threading.Condition()
        self.sequence = 1
        self.inputs: list[dict] = []

    def _frame(self, sequence: int | None = None) -> Frame:
        return Frame(
            data=b"fake-jpeg",
            width=10,
            height=20,
            sequence=self.sequence if sequence is None else sequence,
        )

    def wait_for_frame(self, _run_id: str, *, after_sequence: int, timeout_sec: float) -> Frame:
        with self.condition:
            if self.sequence <= after_sequence:
                self.condition.wait(timeout=timeout_sec)
            return self._frame()

    def submit_input(self, _run_id: str, payload: dict) -> Frame:
        with self.condition:
            previous = self._frame()
            self.inputs.append(payload)
            self.sequence += 1
            self.condition.notify_all()
            return Frame(
                data=previous.data,
                width=previous.width,
                height=previous.height,
                sequence=previous.sequence,
                timings={"input_ms": 1.0, "total_ms": 1.0, "refresh_queued": 1},
            )


async def _wait_until(predicate, timeout: float = 3) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise TimeoutError("condition not reached")
        await asyncio.sleep(0.01)


if __name__ == "__main__":
    unittest.main()
