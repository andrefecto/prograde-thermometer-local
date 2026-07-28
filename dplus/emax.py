"""
Codec for the telemetry the ProGrade EM2251 actually sends.

Recovered by capturing the live device (see FINDINGS.md). Note this is *not* the
DTston "D+" framing in protocol.py -- that spec describes the platform's generic
MCU protocol, but this product's MCU uses its own simpler format. The WiFi module
is a transparent passthrough, so whatever the MCU emits is what arrives.

Observed frame, 18 bytes:

    3c 54 01 69 00 11 22 30 30 00 04 00 88 03 00 00 1c 3e
    <  T  ?  <--dev id--> "0 0" <---- body ----> ck >

    offset  size  field
    0       1     start        always 0x3C, '<'
    1       1     type         0x54 ('T') on temperature reports
    2       1     unknown      0x01 observed; version or subtype
    3       4     device_id    last four bytes of the module MAC
    7       N     body         product-specific payload
    -2      1     checksum     sum(frame[:-2]) & 0xFF -- includes the '<'
    -1      1     end          always 0x3E, '>'

The first two body bytes are ASCII digits ("00" observed), probably a probe or
channel index; they are left in the body so analyze.py can judge for itself.

Which body bytes carry the temperature is not yet established -- it needs a
capture spanning a range of temperatures. That is what analyze.py is for.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

START = 0x3C  # '<'
END = 0x3E    # '>'
OVERHEAD = 9  # start + type + unknown + 4-byte id + checksum + end

TYPE_TEMPERATURE = 0x54  # 'T'

TYPE_NAMES = {TYPE_TEMPERATURE: "temperature"}


class FrameError(ValueError):
    """Raised when a byte string is not a well-formed Emax frame."""


def checksum(data: bytes) -> int:
    """Low byte of the running sum, from the '<' up to (not incl.) the checksum."""
    return sum(data) & 0xFF


@dataclass
class Frame:
    type: int
    device_id: bytes
    body: bytes = b""
    unknown: int = 0x01

    def __post_init__(self) -> None:
        if len(self.device_id) != 4:
            raise FrameError("device_id must be exactly 4 bytes")

    @property
    def name(self) -> str:
        return TYPE_NAMES.get(self.type, f"type_{self.type:02x}")

    @property
    def probe_label(self) -> str:
        """The leading ASCII digits of the body, if they look like an index."""
        head = self.body[:2]
        if head.isdigit():
            return head.decode("ascii")
        return ""

    def encode(self) -> bytes:
        head = struct.pack(">BBB4s", START, self.type, self.unknown,
                           self.device_id) + self.body
        return head + bytes([checksum(head), END])

    def __str__(self) -> str:
        probe = f" probe={self.probe_label}" if self.probe_label else ""
        return (f"{self.name}(0x{self.type:02x}) "
                f"dev={self.device_id.hex(':')}{probe} "
                f"body={self.body.hex(' ') or '-'}")


def decode(raw: bytes, *, verify: bool = True) -> Frame:
    """
    Parse exactly one frame. Raises FrameError on malformed input.

    Tolerates a quirk seen on real hardware: roughly one frame in eight arrives
    with 0x3E ('>') as its first byte instead of 0x3C ('<'). The rest of the
    frame is intact and its checksum is the one computed for a leading '<', so
    those frames are accepted rather than discarded -- the alternative is losing
    an eighth of the telemetry to a firmware slip.
    """
    if len(raw) < OVERHEAD:
        raise FrameError(f"short frame: {len(raw)} < {OVERHEAD} bytes")
    if raw[0] not in (START, END):
        raise FrameError(f"bad start 0x{raw[0]:02x}, want 0x3c")
    if raw[-1] != END:
        raise FrameError(f"bad end 0x{raw[-1]:02x}, want 0x3e")
    if verify:
        # accept the checksum computed over the bytes as received, or over the
        # same bytes with a corrected leading '<'
        as_received = checksum(raw[:-2])
        corrected = checksum(bytes([START]) + raw[1:-2])
        if raw[-2] not in (as_received, corrected):
            raise FrameError(
                f"checksum 0x{raw[-2]:02x}, computed 0x{as_received:02x} "
                f"(or 0x{corrected:02x} with a corrected start byte)")
    return Frame(
        type=raw[1],
        unknown=raw[2],
        device_id=bytes(raw[3:7]),
        body=bytes(raw[7:-2]),
    )


def iter_frames(buf: bytearray):
    """
    Pull complete frames out of a running byte stream, in place.

    Frames are delimited rather than length-prefixed, so we scan for '<' then the
    next '>' and validate. Consumes what it yields; leaves a trailing partial
    frame in `buf`.
    """
    while True:
        start = buf.find(START)
        if start < 0:
            buf.clear()
            return
        if start:
            del buf[:start]
        end = buf.find(END, OVERHEAD - 1)
        if end < 0:
            return  # no terminator yet
        candidate = bytes(buf[:end + 1])
        try:
            frame = decode(candidate)
        except FrameError:
            del buf[0]  # false start, resync
            continue
        del buf[:end + 1]
        yield frame


def _selftest() -> None:
    live = bytes.fromhex("3c5401690011223030000400880300001c3e")

    f = decode(live)
    assert f.type == TYPE_TEMPERATURE, f
    assert f.name == "temperature", f.name
    assert f.device_id == bytes.fromhex("69001122"), f.device_id
    assert f.unknown == 0x01, f.unknown
    assert f.body == bytes.fromhex("303000040088030000"), f.body.hex()
    assert f.probe_label == "00", f.probe_label

    # re-encoding the parsed frame must reproduce the captured bytes exactly
    assert f.encode() == live, f.encode().hex()
    assert checksum(live[:-2]) == 0x1C

    # the real 197F/91.4C frame: le5:6 of the body is tenths of a degree Celsius
    hot = bytes.fromhex("3c540169001122303000040092030000263e")
    h = decode(hot)
    body = h.body
    assert (body[6] << 8 | body[5]) == 914, body.hex()
    assert abs((body[6] << 8 | body[5]) * 0.1 - 91.4) < 1e-9

    # the observed firmware quirk: leading '>' instead of '<', checksum unchanged
    quirk = bytes([END]) + hot[1:]
    q = decode(quirk)
    assert q.body == h.body, "a stray '>' start byte must not lose the frame"
    assert q.device_id == h.device_id, q

    # corrupt checksum is rejected
    bad = bytearray(live)
    bad[-2] ^= 0xFF
    try:
        decode(bytes(bad))
        raise AssertionError("corrupt checksum should not decode")
    except FrameError:
        pass

    # missing terminator is rejected
    try:
        decode(live[:-1])
        raise AssertionError("missing '>' should not decode")
    except FrameError:
        pass

    # streaming: garbage, a false '<', then two good frames back to back
    buf = bytearray(b"\xff\x3c\x01" + live + live)
    got = list(iter_frames(buf))
    assert len(got) == 2, f"expected 2 frames, got {len(got)}"
    assert not buf, buf.hex()

    # partial frame is retained for the next read
    buf = bytearray(live[:10])
    assert list(iter_frames(buf)) == []
    buf += live[10:]
    assert len(list(iter_frames(buf))) == 1

    print("emax.py: all self-tests pass "
          "(live frame round-trip, checksum, resync, split frame)")


if __name__ == "__main__":
    _selftest()
