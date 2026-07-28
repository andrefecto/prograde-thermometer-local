"""
Codec for the DTston / "D+" smart-home UART & LAN framing used by the
ProGrade WiFi Grilling Thermometer.

Frame layout (spec: D+ 串口协议标准 v1.7, assist.dtston.com/sdk/Embedded/D+mcu_1.7.doc)

    offset  size  field
    0       1     header      always 0xAA
    1       1     length      total frame length, header..checksum inclusive
    2       2     packet_id   session/sequence id; reply echoes the request's id
    4       8     device_info 8x 0x00 from the MCU side
    12      2     func        function code (big-endian)
    14      2     reserved    always 0x0000
    16      N     body        function-specific payload
    16+N    1     checksum    two's complement of sum(header..body)

All multi-byte integers are big-endian. length == 17 + N.

The same frame travels end to end: MCU -> UART -> WiFi module -> (LAN TCP or
cloud MQTT) -> app. Over the network the module hex-encodes it as uppercase
ASCII (see char_string()/dt_near_send_data() in the vendor ESP8266 SDK), so
`decode(bytes.fromhex(payload))` parses network captures directly.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field

HEADER = 0xAA
OVERHEAD = 17  # everything except the body

# Function codes that the spec marks as system-fixed, i.e. identical across
# every D+ product. These are the ones we can rely on without guessing.
FUNC_STATUS_QUERY = 0x1001  # app -> device: ask for current state
FUNC_STATUS_REPLY = 0x1801  # device -> app: reply to the above
FUNC_STATUS_REPORT = 0x2000  # device -> app: unsolicited state/alarm report
FUNC_WIFI_PAIR = 0x2001  # MCU -> module: enter pairing, body starts b"QQDM"
FUNC_WIFI_PAIR_REPLY = 0x2801
FUNC_WIFI_STATE = 0x2002  # module -> MCU: rssi + router/cloud link state
FUNC_PRODUCT_TYPE = 0x3001  # module -> MCU: what product are you?
FUNC_PRODUCT_TYPE_REPLY = 0x3801  # MCU -> module: body is 2-byte product type

FUNC_NAMES = {
    FUNC_STATUS_QUERY: "status_query",
    FUNC_STATUS_REPLY: "status_reply",
    FUNC_STATUS_REPORT: "status_report",
    FUNC_WIFI_PAIR: "wifi_pair",
    FUNC_WIFI_PAIR_REPLY: "wifi_pair_reply",
    FUNC_WIFI_STATE: "wifi_state",
    FUNC_PRODUCT_TYPE: "product_type",
    FUNC_PRODUCT_TYPE_REPLY: "product_type_reply",
}


class FrameError(ValueError):
    """Raised when a byte string is not a well-formed D+ frame."""


def checksum(data: bytes) -> int:
    """Two's complement of the running sum, per spec 2.1 (取反再加1)."""
    return (-sum(data)) & 0xFF


@dataclass
class Frame:
    func: int
    body: bytes = b""
    packet_id: int = 0x1000
    device_info: bytes = field(default=bytes(8))

    def __post_init__(self) -> None:
        if len(self.device_info) != 8:
            raise FrameError("device_info must be exactly 8 bytes")
        if OVERHEAD + len(self.body) > 0xFF:
            raise FrameError("body too long: length field is a single byte")

    @property
    def name(self) -> str:
        return FUNC_NAMES.get(self.func, f"unknown_{self.func:04x}")

    def encode(self) -> bytes:
        head = struct.pack(
            ">BBH8sHH",
            HEADER,
            OVERHEAD + len(self.body),
            self.packet_id,
            self.device_info,
            self.func,
            0x0000,
        ) + self.body
        return head + bytes([checksum(head)])

    def hex(self) -> str:
        """Uppercase hex, the form the WiFi module puts on the wire."""
        return self.encode().hex().upper()

    def __str__(self) -> str:
        return f"{self.name}(0x{self.func:04x}) body={self.body.hex(' ') or '-'}"


def decode(raw: bytes, *, verify: bool = True) -> Frame:
    """Parse exactly one frame. Raises FrameError on malformed input."""
    if len(raw) < OVERHEAD:
        raise FrameError(f"short frame: {len(raw)} < {OVERHEAD} bytes")
    if raw[0] != HEADER:
        raise FrameError(f"bad header 0x{raw[0]:02x}, want 0x{HEADER:02x}")
    length = raw[1]
    if length < OVERHEAD:
        raise FrameError(f"length field {length} below minimum {OVERHEAD}")
    if len(raw) != length:
        raise FrameError(f"length field says {length}, got {len(raw)} bytes")
    if verify:
        want = checksum(raw[:-1])
        if raw[-1] != want:
            raise FrameError(f"checksum 0x{raw[-1]:02x}, computed 0x{want:02x}")

    packet_id, device_info, func = struct.unpack(">H8sH", raw[2:14])
    return Frame(
        func=func,
        body=raw[16:-1],
        packet_id=packet_id,
        device_info=device_info,
    )


def iter_frames(buf: bytearray):
    """
    Pull complete frames out of a running byte stream, in place.

    Consumes what it yields and leaves any partial trailing frame in `buf`, so
    it is safe to call repeatedly as more bytes arrive from a serial tap.
    Resynchronises by discarding bytes until a valid frame is found.
    """
    while True:
        start = buf.find(HEADER)
        if start < 0:
            buf.clear()
            return
        if start:
            del buf[:start]
        if len(buf) < 2:
            return
        length = buf[1]
        if length < OVERHEAD:
            del buf[0]  # not a real header, skip it
            continue
        if len(buf) < length:
            return  # wait for the rest
        candidate = bytes(buf[:length])
        try:
            frame = decode(candidate)
        except FrameError:
            del buf[0]  # false 0xAA, resync
            continue
        del buf[:length]
        yield frame


def decode_wifi_state(body: bytes) -> dict:
    """Body of FUNC_WIFI_STATE (0x2002): 3 bytes, per spec section 'Wifi网络状态'."""
    if len(body) < 3:
        raise FrameError("wifi_state body must be at least 3 bytes")
    rssi, router, cloud = body[0], body[1], body[2]
    return {
        "signal_bars": rssi,  # 1=weak, 2=medium, 3=strong
        "router_connected": router == 0x00,
        "cloud_connected": cloud == 0x00,
    }


# --- self-test against the three worked examples printed in the v1.7 spec ---


def _selftest() -> None:
    # Example 1: get product type request.
    v1 = bytes.fromhex("aa111000000000000000000030010000" "04")
    f1 = decode(v1)
    assert f1.func == FUNC_PRODUCT_TYPE, f1
    assert f1.body == b"", f1.body
    assert Frame(FUNC_PRODUCT_TYPE).encode() == v1, Frame(FUNC_PRODUCT_TYPE).hex()

    # Example 2: MCU replies with product type 0x0123.
    v2 = bytes.fromhex("aa1310000000000000000000380100000123d6")
    f2 = decode(v2)
    assert f2.func == FUNC_PRODUCT_TYPE_REPLY and f2.body == b"\x01\x23", f2
    assert Frame(FUNC_PRODUCT_TYPE_REPLY, b"\x01\x23").encode() == v2

    # Example 3: WiFi pair request. Spec prints the body as 51 51 44 4D
    # ("QQDM") followed by zero padding out to a total frame length of 0x20.
    v3 = Frame(FUNC_WIFI_PAIR, b"QQDM" + bytes(11)).encode()
    assert v3[-1] == 0xD2, f"checksum {v3[-1]:#02x} != 0xd2"
    assert v3[1] == 0x20, f"length {v3[1]:#02x} != 0x20"
    f3 = decode(v3)
    assert f3.body.startswith(b"QQDM"), f3.body

    # Streaming resync: garbage, then two good frames back to back.
    buf = bytearray(b"\xff\x00\xaa\x02" + v1 + v2)
    got = list(iter_frames(buf))
    assert [f.func for f in got] == [FUNC_PRODUCT_TYPE, FUNC_PRODUCT_TYPE_REPLY], got
    assert not buf, buf

    # Partial frame is retained for the next read.
    buf = bytearray(v2[:5])
    assert list(iter_frames(buf)) == []
    buf += v2[5:]
    assert [f.func for f in iter_frames(buf)] == [FUNC_PRODUCT_TYPE_REPLY]

    # wifi_state decode
    st = decode_wifi_state(b"\x03\x00\x01")
    assert st == {
        "signal_bars": 3,
        "router_connected": True,
        "cloud_connected": False,
    }, st

    print("protocol.py: all self-tests pass (3/3 spec vectors + stream resync)")


if __name__ == "__main__":
    _selftest()
