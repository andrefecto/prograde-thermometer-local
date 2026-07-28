#!/usr/bin/env python3
"""
Listen for the thermometer's telemetry and decode it.

Once AT+NETP points the module at this machine, the module is in transparent
passthrough mode: whatever the thermometer's MCU writes to the UART arrives here
verbatim as UDP payloads. Those are D+ frames, so they decode with protocol.py.

The log it writes is JSONL, one record per frame, which analyze.py reads directly
-- that is how you find the temperature field without ever opening the case.

Usage:
    python3 udp_listen.py --port 17000
    python3 udp_listen.py --port 17000 --log session.jsonl
    python3 udp_listen.py --selftest

Then, with a few readings noted off the LCD:
    python3 analyze.py session.jsonl --observed 15=33 120=72 300=212
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import time

import emax
import protocol

STATE_FUNCS = (protocol.FUNC_STATUS_REPORT, protocol.FUNC_STATUS_REPLY)


def body_columns(body: bytes) -> str:
    """Index the body so offsets can be lined up against the LCD by eye."""
    idx = " ".join(f"{i:>3}" for i in range(len(body)))
    dec = " ".join(f"{b:>3}" for b in body)
    return f"    offset  {idx}\n    value   {dec}"


def describe(fmt: str, frame) -> str:
    """One-line view of a decoded frame, plus an indexed body dump."""
    if fmt == "emax":
        line = f"{frame.name:<14} dev={frame.device_id.hex(':')}"
        if frame.probe_label:
            line += f" probe={frame.probe_label}"
        if frame.body:
            line += f"\n    body[{len(frame.body)}] = {frame.body.hex(' ')}\n"
            line += body_columns(frame.body)
        return line

    line = f"{frame.name:<20} func=0x{frame.func:04x} id=0x{frame.packet_id:04x}"
    if frame.func == protocol.FUNC_WIFI_STATE:
        try:
            st = protocol.decode_wifi_state(frame.body)
            line += (f"  bars={st['signal_bars']} "
                     f"router={'up' if st['router_connected'] else 'down'} "
                     f"cloud={'up' if st['cloud_connected'] else 'down'}")
        except protocol.FrameError:
            pass
    if frame.body:
        line += f"\n    body[{len(frame.body)}] = {frame.body.hex(' ')}"
        if frame.func in STATE_FUNCS:
            line += "\n" + body_columns(frame.body)
    return line


def decode_datagram(data: bytes) -> list[tuple[str, object]]:
    """
    Decode one datagram, returning [(format, frame), ...].

    UDP preserves message boundaries, so a datagram is tried on its own first.
    Two formats are recognised: 'emax', which is what this product's MCU sends,
    and 'dplus', the generic DTston framing, in case a sibling device uses it.
    """
    out: list[tuple[str, object]] = []
    if not data:
        return out

    if data[0] == emax.START:
        buf = bytearray(data)
        out = [("emax", f) for f in emax.iter_frames(buf)]
    elif data[0] == protocol.HEADER:
        buf = bytearray(data)
        out = [("dplus", f) for f in protocol.iter_frames(buf)]
    return out


def listen(port: str, host: str, log_path: str | None,
           duration: float | None) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind((host, port))
    except OSError as exc:
        print(f"could not bind {host}:{port}: {exc}", file=sys.stderr)
        return 1
    sock.settimeout(1.0)

    log = open(log_path, "a", buffering=1) if log_path else None
    # carry-over per sender, only used if a datagram does not decode on its own
    carry: dict[tuple, bytearray] = {}
    started = time.time()
    frames = packets = undecoded = 0

    print(f"listening on udp {host}:{port} -- Ctrl-C to stop")
    print("tip: note the LCD reading, and the seconds shown in each line, every")
    print("     time a frame appears. analyze.py needs those pairs to pin down")
    print("     the temperature bytes.\n")

    try:
        while duration is None or time.time() - started < duration:
            try:
                data, addr = sock.recvfrom(4096)
            except socket.timeout:
                continue
            packets += 1
            ts = time.time()

            found = decode_datagram(data)
            if not found:
                # try again with anything left over from a previous datagram, in
                # case the module split a frame across two
                buf = carry.setdefault(addr, bytearray())
                buf += data
                if len(buf) > 4096:
                    del buf[:-1024]
                found = decode_datagram(bytes(buf))
                if found:
                    buf.clear()

            if not found:
                undecoded += 1
                print(f"[{ts - started:8.2f}s] {addr[0]} {len(data)}B "
                      f"undecoded: {data.hex(' ')}")
                # Log it anyway. An unrecognised format is exactly the thing we
                # most want to keep, so a capture is never wasted.
                if log:
                    log.write(json.dumps({
                        "t": ts, "format": "raw", "src": addr[0],
                        "raw": data.hex(),
                    }) + "\n")
                continue

            for fmt, frame in found:
                frames += 1
                print(f"[{ts - started:8.2f}s] {addr[0]}  {describe(fmt, frame)}")
                if not log:
                    continue
                record = {
                    "t": ts,
                    "format": fmt,
                    "src": addr[0],
                    "body": frame.body.hex(),
                    "raw": frame.encode().hex(),
                }
                if fmt == "emax":
                    record["func"] = frame.type
                    record["device_id"] = frame.device_id.hex()
                    record["probe"] = frame.probe_label
                else:
                    record["func"] = frame.func
                    record["packet_id"] = frame.packet_id
                log.write(json.dumps(record) + "\n")
    except KeyboardInterrupt:
        pass
    finally:
        sock.close()
        if log:
            log.close()

    print(f"\n{packets} datagrams, {frames} frames decoded", end="")
    if undecoded:
        print(f", {undecoded} undecoded (logged raw)", end="")
    print(f", written to {log_path}" if log_path else "")
    return 0


def _selftest() -> int:
    """Send synthetic frames at the listener and confirm they decode and log."""
    import os
    import tempfile
    import threading

    log_path = os.path.join(tempfile.mkdtemp(), "session.jsonl")
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    t = threading.Thread(
        target=listen, args=(port, "127.0.0.1", log_path, 3.0), daemon=True
    )
    t.start()
    time.sleep(0.5)

    dev = bytes.fromhex("69001122")
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    # the real captured frame, verbatim
    s.sendto(bytes.fromhex("3c5401690011223030000400880300001c3e"),
             ("127.0.0.1", port))
    time.sleep(0.15)
    # a second emax frame with a different body
    s.sendto(emax.Frame(emax.TYPE_TEMPERATURE, dev,
                        bytes.fromhex("303000040090030000")).encode(),
             ("127.0.0.1", port))
    time.sleep(0.15)
    # a D+ frame, to prove the other format still decodes
    s.sendto(protocol.Frame(protocol.FUNC_STATUS_REPORT, b"\x01\x02").encode(),
             ("127.0.0.1", port))
    time.sleep(0.15)
    # something in neither format: must still be logged, not dropped
    s.sendto(b"\x99\x88garbage", ("127.0.0.1", port))
    s.close()

    t.join(timeout=6)

    with open(log_path) as fh:
        records = [json.loads(l) for l in fh if l.strip()]
    assert len(records) == 4, f"expected 4 records, got {len(records)}"

    fmts = [r["format"] for r in records]
    assert fmts == ["emax", "emax", "dplus", "raw"], fmts

    # the live frame must survive the round trip through the log
    assert records[0]["raw"] == "3c5401690011223030000400880300001c3e", records[0]
    assert records[0]["body"] == "303000040088030000", records[0]["body"]
    assert records[0]["func"] == emax.TYPE_TEMPERATURE, records[0]
    assert records[0]["device_id"] == "69001122", records[0]
    assert records[0]["probe"] == "00", records[0]

    # every logged frame must re-decode with the codec its format names
    for r in records:
        if r["format"] == "emax":
            emax.decode(bytes.fromhex(r["raw"]))
        elif r["format"] == "dplus":
            protocol.decode(bytes.fromhex(r["raw"]))

    # the undecodable datagram is kept, which is the point
    assert records[3]["raw"] == b"\x99\x88garbage".hex(), records[3]
    assert "body" not in records[3], records[3]

    print("udp_listen.py: self-test passed (live emax frame, second emax frame,\n"
          "  D+ frame, and an unrecognised datagram all logged for analyze.py)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--port", type=int, default=17000,
                    help="the port set in AT+NETP (stock firmware uses 17000)")
    ap.add_argument("--host", default="0.0.0.0",
                    help="address to bind (default all interfaces)")
    ap.add_argument("--log", help="append decoded frames to this .jsonl file")
    ap.add_argument("--seconds", type=float, help="stop after this long")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()
    return listen(args.port, args.host, args.log, args.seconds)


if __name__ == "__main__":
    sys.exit(main())
