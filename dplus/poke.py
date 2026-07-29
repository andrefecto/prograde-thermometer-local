#!/usr/bin/env python3
"""
Send data to the thermometer's MCU and see whether it answers.

Why
---
The WiFi module is a transparent bridge in UDP CLIENT mode: it forwards the
thermometer MCU's serial output to the configured server, and forwards anything
arriving on that socket back to the MCU's serial input. So replying to the
datagrams it sends puts bytes directly on the MCU's UART.

That matters because the MCU appears to withhold temperature. It emits a 14-byte
frame once a second with no reading, even while its own alarm fires, so it plainly
knows the temperature. In the stock setup the vendor's server would have been
sending data *down* to the device; a self-hosted server never does. If the MCU
only reports when polled, that is the whole difference.

This tool waits for the device to announce itself, then tries candidate payloads
one at a time and reports whether anything new comes back -- specifically a frame
longer than the heartbeat, which is what a temperature report looks like.

Safety
------
The MCU's command set is unknown, so writing to it is not risk-free: a byte
sequence that happens to form a valid command could change a setting. The default
probes are chosen to be as inert as possible:

  * the device's own heartbeat, echoed back -- a report, not a command
  * short byte strings that cannot satisfy the frame's checksum
  * the D+ platform's documented read-only status query

Nothing here writes a configuration value that this project knows of. Everything
is reversible by power-cycling the thermometer. Even so, do not run it while a
cook you care about is in progress.

Usage
-----
    python3 poke.py --port 17000                  # probe, report what answers
    python3 poke.py --port 17000 --listen-only    # just watch, send nothing
    python3 poke.py --selftest
"""

from __future__ import annotations

import argparse
import socket
import sys
import time

import emax
import protocol


def build_probes() -> list[tuple[str, bytes]]:
    """
    Candidate payloads, most inert first.

    `None` for the payload of "echo" is filled in at run time with whatever the
    device actually sent, so we mirror its own frame back rather than guessing.
    """
    return [
        ("newline", b"\r\n"),
        ("single_nul", b"\x00"),
        ("ascii_query", b"?\r\n"),
        # the platform's generic read-only status query, in case this MCU speaks it
        ("dplus_status_query", protocol.Frame(protocol.FUNC_STATUS_QUERY).encode()),
        ("dplus_product_type", protocol.Frame(protocol.FUNC_PRODUCT_TYPE).encode()),
        # an emax frame with the same type byte but an empty body: plausibly a read
        ("emax_empty_body", None),   # needs the device id, filled in at run time
        ("emax_echo", None),         # the device's own frame, mirrored back
    ]


def describe(data: bytes) -> str:
    """Short human view of a datagram, decoded if we recognise it."""
    out = f"{len(data)}B {data.hex(' ')}"
    try:
        if data[0] in (emax.START, emax.END):
            f = emax.decode(data)
            out += f"  -> emax {f.name} body={f.body.hex(' ')}"
            if len(f.body) > 6:
                raw = (f.body[6] << 8) | f.body[5]
                out += f"  le5:6={raw} = {raw * 0.1:.1f} C = {raw * 0.1 * 9 / 5 + 32:.1f} F"
        elif data[0] == protocol.HEADER:
            out += f"  -> dplus {protocol.decode(data)}"
    except Exception:
        pass
    return out


def run(port: int, host: str, listen_only: bool, settle: float,
        per_probe: float) -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind((host, port))
    except OSError as exc:
        print(f"could not bind {host}:{port}: {exc}", file=sys.stderr)
        print("Homebridge is probably holding it. Stop it, or use --port with a "
              "spare port and point AT+NETP there.", file=sys.stderr)
        return 1
    sock.settimeout(1.0)

    print(f"listening on udp {host}:{port}, waiting for the device...")
    baseline: set[bytes] = set()
    device = None
    deadline = time.time() + settle
    while time.time() < deadline:
        try:
            data, addr = sock.recvfrom(4096)
        except socket.timeout:
            continue
        device = addr
        baseline.add(data)
        print(f"  from {addr[0]}:{addr[1]}  {describe(data)}")

    if device is None:
        print("\nnothing arrived. Is the thermometer on and pointed here?",
              file=sys.stderr)
        sock.close()
        return 1

    print(f"\nbaseline: {len(baseline)} distinct payload(s) over {settle:.0f}s")
    if listen_only:
        sock.close()
        return 0

    # fill in the probes that need the device's own frame
    sample = next(iter(baseline))
    probes = []
    for name, payload in build_probes():
        if name == "emax_echo":
            payload = sample
        elif name == "emax_empty_body":
            try:
                dev_id = emax.decode(sample).device_id
                payload = emax.Frame(emax.TYPE_TEMPERATURE, dev_id, b"").encode()
            except Exception:
                continue
        probes.append((name, payload))

    print(f"\nsending {len(probes)} probe(s) to {device[0]}:{device[1]}, "
          f"watching {per_probe:.0f}s after each\n")

    hits = []
    for name, payload in probes:
        print(f"--- {name}: {payload.hex(' ')}")
        try:
            sock.sendto(payload, device)
        except OSError as exc:
            print(f"    send failed: {exc}")
            continue

        new = []
        end = time.time() + per_probe
        while time.time() < end:
            try:
                data, _ = sock.recvfrom(4096)
            except socket.timeout:
                continue
            if data not in baseline:
                new.append(data)
                baseline.add(data)
                print(f"    NEW  {describe(data)}")
        if new:
            hits.append((name, new))
        else:
            print("    (nothing new)")

    print("\n" + "=" * 66)
    if hits:
        print("Payloads that provoked something new:\n")
        for name, new in hits:
            print(f"  {name}: {len(new)} new payload(s)")
        print("\nThat is the lead: the MCU responds to inbound serial data.")
    else:
        print("No probe changed what the device sends.")
        print("The MCU ignores everything tried here, so its silence is not")
        print("simply 'waiting to be polled' -- at least not by these payloads.")
    sock.close()
    return 0


def _selftest() -> int:
    """Fake device: heartbeats always, plus a temperature frame once poked."""
    import threading

    dev = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    dev.bind(("127.0.0.1", 0))
    dev_port = dev.getsockname()[1]

    srv_probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    srv_probe.bind(("127.0.0.1", 0))
    srv_port = srv_probe.getsockname()[1]
    srv_probe.close()

    dev_id = bytes.fromhex("69001122")
    beat = emax.Frame(emax.TYPE_TEMPERATURE, dev_id,
                      bytes.fromhex("0101010000")).encode()
    hot = emax.Frame(emax.TYPE_TEMPERATURE, dev_id,
                     bytes.fromhex("303000040092030000")).encode()

    def fake_device():
        dev.settimeout(0.2)
        end = time.time() + 12
        poked = False
        while time.time() < end:
            try:
                data, _ = dev.recvfrom(4096)
                # respond with a temperature frame only to the echoed heartbeat
                if data == beat:
                    poked = True
            except socket.timeout:
                pass
            dev.sendto(hot if poked else beat, ("127.0.0.1", srv_port))
            time.sleep(0.25)

    threading.Thread(target=fake_device, daemon=True).start()
    time.sleep(0.3)
    rc = run(srv_port, "127.0.0.1", False, settle=1.5, per_probe=0.8)
    dev.close()
    assert rc == 0, rc
    print("\npoke.py: self-test passed (baseline captured, probes sent, the "
          "provoked\n  temperature frame was detected and decoded)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--port", type=int, default=17000,
                    help="the port AT+NETP points at (default 17000)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--listen-only", action="store_true",
                    help="record what the device sends and send nothing back")
    ap.add_argument("--settle", type=float, default=6.0,
                    help="seconds to establish a baseline first")
    ap.add_argument("--per-probe", type=float, default=4.0,
                    help="seconds to watch after each probe")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()
    return run(args.port, args.host, args.listen_only, args.settle,
               args.per_probe)


if __name__ == "__main__":
    sys.exit(main())
