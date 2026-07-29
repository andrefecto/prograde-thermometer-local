#!/usr/bin/env python3
"""
Talk to the thermometer's pairing-mode AP directly, with no vendor app.

Protocol, recovered from a capture of the ProGrade app pairing an EM2251
(see FINDINGS.md). While in AP mode the module runs a UDP-to-AT-command bridge:

    device AP subnet : 11.11.11.0/24, device at 11.11.11.254
    port             : UDP 8800
    hello            : send b"LSD_WIFI"       -> b"<mac>,<model>"
                                                 e.g. b"009569001122,LSD_F205"
    command          : send b"LSD_WIFI:" + at_command + b"\\r\\n"
                       -> zero or more reply datagrams, one output line each

`AT+WSCAN` returns a site survey formatted as

    <index>   Infra     <bssid>  <rssi>  <channel>  "<security>"  "<ssid>"

Everything is plaintext. There is no authentication on this interface, so
anything on the device's AP can drive it.

Usage:
    # join the device's "LivingSmart" AP first, then:
    python3 lsd_wifi.py hello
    python3 lsd_wifi.py scan
    python3 lsd_wifi.py at "AT+WSCAN"
    python3 lsd_wifi.py probe          # enumerate the AT command set
    python3 lsd_wifi.py --selftest
"""

from __future__ import annotations

import argparse
import re
import socket
import sys

DEVICE_IP = "11.11.11.254"
DEVICE_PORT = 8800
PREFIX = b"LSD_WIFI"

# Candidates for enumerating the command set. Ordered least- to most-likely to
# do anything destructive; nothing here writes configuration.
PROBE_COMMANDS = [
    "AT",
    "AT+HELP",
    "AT+H",
    "AT?",
    "AT+LIST",
    "AT+VER",
    "AT+VERSION",
    "AT+WMODE",
    "AT+WSSSID",
    "AT+WSKEY",
    "AT+WANN",
    "AT+WSLQ",
    "AT+WSMAC",
    "AT+SERVER",
    "AT+SRVADDR",
    "AT+SERVERADDR",
    "AT+NETP",
    "AT+TCPDIS",
    "AT+PING",
]


class LsdDevice:
    def __init__(self, host=DEVICE_IP, port=DEVICE_PORT, timeout=3.0):
        self.addr = (host, port)
        self.timeout = timeout

    def _exchange(self, payload: bytes, collect: float | None = None) -> list[bytes]:
        """Send one datagram, gather replies until the socket goes quiet."""
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(self.timeout)
            s.sendto(payload, self.addr)
            replies = []
            deadline_extra = collect if collect is not None else 0.0
            # first reply may take a while (a scan takes ~2.5 s on this module)
            try:
                data, _ = s.recvfrom(4096)
                replies.append(data)
            except socket.timeout:
                return replies
            # then drain anything that follows quickly
            s.settimeout(max(0.6, deadline_extra))
            while True:
                try:
                    data, _ = s.recvfrom(4096)
                    replies.append(data)
                except socket.timeout:
                    break
            return replies

    def hello(self) -> tuple[str, str] | None:
        """Return (mac, model), e.g. ('009569001122', 'LSD_F205')."""
        replies = self._exchange(PREFIX)
        if not replies:
            return None
        text = replies[0].decode("ascii", "replace").strip()
        if "," in text:
            mac, _, model = text.partition(",")
            return mac.strip(), model.strip()
        return text, ""

    def at(self, command: str, collect: float = 3.0) -> list[str]:
        """Send one AT command; return the reply lines."""
        payload = PREFIX + b":" + command.encode("ascii") + b"\r\n"
        replies = self._exchange(payload, collect=collect)
        lines = []
        for r in replies:
            for line in r.decode("ascii", "replace").splitlines():
                if line.strip():
                    lines.append(line.rstrip())
        return lines

    def scan(self) -> list[dict]:
        """Run AT+WSCAN and parse the site survey."""
        rows = []
        pattern = re.compile(
            r"^\s*(\d+)\s+(\S+)\s+([0-9a-fA-F:]+)\s+(-?\d+)\s+(\d+)\s+"
            r'"([^"]*)"\s+"([^"]*)"'
        )
        for line in self.at("AT+WSCAN", collect=4.0):
            m = pattern.match(line)
            if m:
                rows.append({
                    "index": int(m.group(1)),
                    "type": m.group(2),
                    "bssid": m.group(3),
                    "rssi": int(m.group(4)),
                    "channel": int(m.group(5)),
                    "security": m.group(6),
                    "ssid": m.group(7),
                })
        return sorted(rows, key=lambda r: r["index"])


def cmd_hello(dev: LsdDevice) -> int:
    got = dev.hello()
    if not got:
        print(f"no reply from {dev.addr[0]}:{dev.addr[1]}.", file=sys.stderr)
        print("Are you joined to the device's 'LivingSmart' AP, and is it "
              "still in AP mode (display shows 'AP')?", file=sys.stderr)
        return 1
    mac, model = got
    print(f"mac   : {mac}  ({':'.join(mac[i:i+2] for i in range(0, len(mac), 2))})")
    print(f"model : {model}")
    return 0


def suggest_security(scan_security: str) -> str:
    """
    Translate a scan result's security column into the auth,encryption pair
    AT+WSKEY wants.

    AT+WSKEY takes "<auth>,<encryption>,<key>" where auth is one of
    OPEN/SHARED/WPAPSK/WPA2PSK and encryption is NONE/WEP/TKIP/AES. The scan
    reports something friendlier like "WPA2 AES" or "WPA/WPA2 AES", so map it.
    """
    s = scan_security.upper()
    if "WPA2" in s:
        auth = "WPA2PSK"
    elif "WPA" in s:
        auth = "WPAPSK"
    elif "WEP" in s:
        auth = "SHARED"
    else:
        auth = "OPEN"

    if "AES" in s:
        encryption = "AES"
    elif "TKIP" in s:
        encryption = "TKIP"
    elif "WEP" in s:
        encryption = "WEP"
    else:
        encryption = "NONE"
    return f"{auth},{encryption}"


def cmd_scan(dev: LsdDevice) -> int:
    rows = dev.scan()
    if not rows:
        print("no scan results (or no reply).", file=sys.stderr)
        return 1
    print(f"{'ch':>3}  {'rssi':>5}  {'security':<14}  {'--security':<16}  ssid")
    print("-" * 76)
    for r in rows:
        ssid = r["ssid"] or "<hidden>"
        print(f"{r['channel']:>3}  {r['rssi']:>5}  {r['security']:<14}  "
              f"{suggest_security(r['security']):<16}  {ssid}")

    print(f"\n{len(rows)} networks visible to the device.")
    print("This list IS the 2.4 GHz check -- the module has no 5 GHz radio, so if")
    print("your network is not here the device physically cannot join it.")
    print("Use the --security value from your network's row when configuring.")
    return 0


def cmd_at(dev: LsdDevice, command: str, collect: float) -> int:
    lines = dev.at(command, collect=collect)
    if not lines:
        print("(no reply)")
        return 1
    for line in lines:
        print(line)
    return 0


def cmd_probe(dev: LsdDevice) -> int:
    """
    Enumerate the AT command set.

    This is how we find the join command, and -- more interestingly -- whether
    there is a command to set the server address. The SDK's Realtek pairing code
    references `serverAddress` and `softAP_serverIP`, which hints that the device
    can be told which server to talk to at provisioning time. If so, you can
    point it straight at your own machine and skip DNS spoofing entirely.

    Read-only: none of the probed commands set configuration.
    """
    got = dev.hello()
    if not got:
        print("no reply to hello; not on the device AP?", file=sys.stderr)
        return 1
    print(f"device {got[0]} model {got[1]}\n")
    print("probing for supported AT commands (read-only)\n")

    answered = []
    for cmd in PROBE_COMMANDS:
        lines = dev.at(cmd, collect=1.5)
        if lines:
            answered.append(cmd)
            print(f"  {cmd}")
            for line in lines[:8]:
                print(f"        {line}")
            if len(lines) > 8:
                print(f"        ... {len(lines) - 8} more lines")
        else:
            print(f"  {cmd:<16} (no reply)")

    print(f"\n{len(answered)}/{len(PROBE_COMMANDS)} commands answered.")
    if answered:
        print("Anything that echoed its current value can usually also be set "
              "with '=<value>'.")
        print("Look for a server-address command in particular -- see this "
              "function's docstring.")
    return 0


def cmd_help(dev: LsdDevice, collect: float) -> int:
    """Dump the module's own AT command reference (AT+H), in full."""
    lines = dev.at("AT+H", collect=collect)
    if not lines:
        print("no reply to AT+H", file=sys.stderr)
        return 1
    for line in lines:
        print(line)
    print(f"\n({len(lines)} lines)")
    return 0


# Settings worth reading before and after a change.
SETTINGS = [
    ("AT+VER", "firmware version"),
    ("AT+WMODE", "AP or STA"),
    ("AT+TMODE", "transmission mode (want throughput/transparent)"),
    ("AT+WSSSID", "station-mode SSID"),
    ("AT+WSKEY", "station-mode security and key"),
    ("AT+WANN", "address assignment"),
    ("AT+UART", "serial parameters as the module sees them"),
    ("AT+NETP", "socket A: protocol, role, port, server"),
    ("AT+SOCKB", "socket B: a SECOND destination, if configured"),
    ("AT+TCPLK", "socket A link status"),
    ("AT+TCPLKB", "socket B link status"),
    ("AT+TCPDIS", "socket A disconnect flag"),
    ("AT+WSLK", "STA link status"),
    ("AT+WSLQ", "signal level"),
    ("AT+WSMAC", "MAC"),
]


def cmd_get(dev: LsdDevice) -> int:
    """Read the current configuration."""
    got = dev.hello()
    if not got:
        print("no reply to hello; not on the device AP?", file=sys.stderr)
        return 1
    print(f"device {got[0]} model {got[1]}\n")
    for cmd, what in SETTINGS:
        lines = dev.at(cmd, collect=1.2)
        value = lines[0] if lines else "(no reply)"
        print(f"  {cmd:<12} {value:<52} {what}")
    print("\nNote AT+WSKEY returns the stored WiFi password in plaintext to "
          "anyone\non this AP. That is the module's behaviour, not a bug here.")
    return 0


def cmd_configure(dev: LsdDevice, args) -> int:
    """
    Point the device at your own server, and optionally set its WiFi.

    The module runs in transparent passthrough mode: whatever the thermometer's
    MCU puts on the UART is sent verbatim to the host configured in AT+NETP.
    Repointing AT+NETP at your machine is therefore the whole integration --
    the device stops talking to smartserver.emaxtime.cn and starts talking to
    you, with no interception anywhere.
    """
    got = dev.hello()
    if not got:
        print("no reply to hello; not on the device AP?", file=sys.stderr)
        return 1
    print(f"device {got[0]} model {got[1]}\n")

    before = {}
    for cmd, _ in SETTINGS:
        lines = dev.at(cmd, collect=1.2)
        before[cmd] = lines[0] if lines else "(no reply)"

    # Order matters, and not the way you would guess. Switching AT+WMODE to STA
    # reloads the network profile and RESETS AT+NETP back to the factory server,
    # so the server address has to be written after the mode change, not before.
    # Better still, set the WiFi first, let the device join, then set AT+NETP
    # over the LAN with --host -- the AT bridge stays reachable in station mode.
    writes: list[tuple[str, str]] = []
    if args.ssid is not None:
        writes.append((f"AT+WSSSID={args.ssid}", f"join SSID {args.ssid!r}"))
    if args.open:
        writes.append(("AT+WSKEY=OPEN,NONE,", "clear the key (open network)"))
    elif args.wifi_password is not None:
        writes.append(
            (f"AT+WSKEY={args.security},{args.wifi_password}",
             f"set the key, {args.security}")
        )
    elif args.ssid is not None:
        print(f"\n! --ssid given without --wifi-password, so the existing key is")
        print(f"  kept: {before.get('AT+WSKEY', '(unknown)')}")
        print("  That only works if the new network uses the same password.")
        print("  Add --wifi-password, or --open for an unsecured network.\n")
    if args.station:
        writes.append(("AT+WMODE=STA",
                       "switch to station mode (leaves AP/pairing mode)"))
    if args.server:
        proto = args.proto.upper()
        role = args.role.upper()
        writes.append(
            (f"AT+NETP={proto},{role},{args.server_port},{args.server}",
             f"send data to {args.server}:{args.server_port} over {proto}")
        )
        if args.station:
            print("\n! Setting both --station and --server in one go is "
                  "unreliable: the mode\n  switch can reset AT+NETP even when "
                  "written afterwards. Verify with\n  'get' once the device has "
                  "joined, and re-set --server over the LAN\n  with --host "
                  "<device-ip> if it reverted.\n")

    if not writes:
        print("nothing to do. Pass --server and/or --ssid/--wifi-password, "
              "and --station to switch out of AP mode.")
        print("\ncurrent settings:")
        for cmd, _ in SETTINGS:
            print(f"  {cmd:<12} {before[cmd]}")
        return 0

    print("current:")
    print(f"  AT+NETP      {before.get('AT+NETP')}")
    print(f"  AT+WMODE     {before.get('AT+WMODE')}")
    print(f"  AT+WSSSID    {before.get('AT+WSSSID')}")
    print("\nwill send:")
    for cmd, why in writes:
        shown = re.sub(r"(AT\+WSKEY=[^,]+,)(.*)", r"\1********", cmd)
        print(f"  {shown:<52} {why}")
    if args.reset:
        print(f"  {args.reset_command:<52} reboot so the changes take effect")

    if not args.yes:
        print("\nThis writes to the device. Re-run with --yes to go ahead.")
        print("To undo, hold the rear button to re-enter AP mode and set the "
              "values back;\nthe originals are printed above.")
        return 0

    print()
    ok = True
    for cmd, _ in writes:
        lines = dev.at(cmd, collect=2.0)
        reply = lines[0] if lines else "(no reply)"
        shown = re.sub(r"(AT\+WSKEY=[^,]+,)(.*)", r"\1********", cmd)
        good = reply.startswith("+ok")
        ok = ok and good
        print(f"  {shown:<52} -> {reply}")
        if not good:
            print("     ! not accepted; stopping before anything else is "
                  "changed.")
            return 1

    if args.reset:
        lines = dev.at(args.reset_command, collect=2.0)
        print(f"  {args.reset_command:<52} -> "
              f"{lines[0] if lines else '(no reply, which is normal on reset)'}")

    print("\nDone. If you switched to station mode the AP disappears and this "
          "tool can no\nlonger reach it -- hold the rear button to get back to "
          "pairing mode.")
    if args.server:
        print(f"\nNow listen on your server:")
        print(f"    python3 udp_listen.py --port {args.server_port}")
    return 0 if ok else 1


def _selftest() -> int:
    """Run a stand-in device on localhost and exercise the client against it."""
    import threading

    srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    srv.bind(("127.0.0.1", 0))
    port = srv.getsockname()[1]
    state: dict[str, str] = {}
    survey = [
        b'1   Infra     20:be:cd:3b:45:27  -44  11  "WPA2 AES"  "Homenet"\r\n',
        b'2   Infra     c4:f1:74:41:4c:44  -52  6  "WPA2 AES"  ""\r\n',
        b'3   Infra     c4:f1:74:41:4c:4a  -52  6  "OPEN"  ""\r\n',
    ]

    def fake_device():
        srv.settimeout(15)
        while True:
            try:
                data, peer = srv.recvfrom(4096)
            except (socket.timeout, OSError):
                return
            if data == PREFIX:
                srv.sendto(b"009569001122,LSD_F205", peer)
            elif data.startswith(PREFIX + b":"):
                cmd = data[len(PREFIX) + 1:].strip().decode()
                if cmd == "AT+WSCAN":
                    for line in survey:
                        srv.sendto(line, peer)
                elif cmd == "AT+VER":
                    srv.sendto(b"LSD_F205 v1.2.3\r\n", peer)
                elif cmd == "AT+NETP":
                    srv.sendto(b"+ok=UDP,CLIENT,17000,SMARTSERVER.EMAXTIME.CN",
                               peer)
                elif cmd.startswith("AT+NETP="):
                    state["netp"] = cmd.split("=", 1)[1]
                    srv.sendto(b"+ok", peer)
                elif cmd.startswith("AT+WSKEY="):
                    state["key"] = cmd.split("=", 1)[1]
                    srv.sendto(b"+ok", peer)
                elif cmd == "AT+WMODE":
                    srv.sendto(b"+ok=AP", peer)
                elif cmd.startswith("AT+"):
                    srv.sendto(b"+ERR=-2", peer)
                # anything else: silence, like a real unsupported command

    threading.Thread(target=fake_device, daemon=True).start()
    dev = LsdDevice("127.0.0.1", port, timeout=3.0)

    assert dev.hello() == ("009569001122", "LSD_F205"), dev.hello()

    rows = dev.scan()
    assert len(rows) == 3, rows
    assert rows[0]["ssid"] == "Homenet" and rows[0]["channel"] == 11, rows[0]
    assert rows[0]["rssi"] == -44 and rows[0]["security"] == "WPA2 AES", rows[0]
    assert rows[1]["ssid"] == "", rows[1]
    assert rows[2]["security"] == "OPEN", rows[2]

    assert dev.at("AT+VER", collect=1.0) == ["LSD_F205 v1.2.3"], dev.at("AT+VER")
    assert dev.at("AT+NETP", collect=1.0) == [
        "+ok=UDP,CLIENT,17000,SMARTSERVER.EMAXTIME.CN"
    ], dev.at("AT+NETP")
    assert dev.at("AT+NOPE2", collect=1.0) == ["+ERR=-2"], "unsupported -> +ERR"

    # repointing the server is the whole integration; check it round-trips
    assert dev.at("AT+NETP=UDP,CLIENT,17000,192.168.1.50", collect=1.0) == ["+ok"]
    assert state["netp"] == "UDP,CLIENT,17000,192.168.1.50", state

    # the WSKEY masker must not leak the password into logs
    masked = re.sub(r"(AT\+WSKEY=[^,]+,)(.*)", r"\1********",
                    "AT+WSKEY=WPA2PSK,AES,hunter2")
    assert masked == "AT+WSKEY=WPA2PSK,********", masked

    # scan security strings must map to valid AT+WSKEY auth,encryption pairs
    for scanned, expected in [
        ("WPA2 AES", "WPA2PSK,AES"),
        ("WPA/WPA2 AES", "WPA2PSK,AES"),
        ("WPA AES", "WPAPSK,AES"),
        ("WPA2 TKIP", "WPA2PSK,TKIP"),
        ("OPEN", "OPEN,NONE"),
        ("WEP", "SHARED,WEP"),
    ]:
        assert suggest_security(scanned) == expected, \
            f"{scanned!r} -> {suggest_security(scanned)!r}, want {expected!r}"

    # a key set through the real command path must round-trip
    assert dev.at("AT+WSKEY=WPA2PSK,AES,hunter2", collect=1.0) == ["+ok"]
    assert state["key"] == "WPA2PSK,AES,hunter2", state

    srv.close()
    print("lsd_wifi.py: self-test passed (hello, scan parsing incl. hidden/OPEN "
          "rows,\n  AT echo, +ERR handling, AT+NETP and AT+WSKEY round-trips,\n"
          "  scan-security mapping, password masking)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("action", nargs="?",
                    choices=["hello", "scan", "at", "probe", "help", "get",
                             "configure"],
                    help="what to do")
    ap.add_argument("command", nargs="?", help="the AT command, for 'at'")
    ap.add_argument("--host", default=DEVICE_IP)
    ap.add_argument("--port", type=int, default=DEVICE_PORT)
    ap.add_argument("--timeout", type=float, default=4.0)
    ap.add_argument("--collect", type=float, default=3.0,
                    help="how long to keep gathering reply datagrams")

    g = ap.add_argument_group("configure")
    g.add_argument("--server", help="host/IP the device should send data to")
    g.add_argument("--server-port", type=int, default=17000,
                   help="port on that host (stock firmware uses 17000)")
    g.add_argument("--proto", default="UDP", choices=["UDP", "TCP", "udp", "tcp"])
    g.add_argument("--role", default="CLIENT",
                   choices=["CLIENT", "SERVER", "client", "server"])
    g.add_argument("--ssid", help="WiFi network for the device to join")
    g.add_argument("--wifi-password", help="that network's key")
    g.add_argument("--security", default="WPA2PSK,AES",
                   help="auth,encryption for AT+WSKEY (default 'WPA2PSK,AES'). "
                        "Run 'scan' to see the right value for your network.")
    g.add_argument("--open", action="store_true",
                   help="the target network has no password")
    g.add_argument("--station", action="store_true",
                   help="also switch to station mode (leaves pairing mode)")
    g.add_argument("--reset", action="store_true",
                   help="reboot the module after writing")
    g.add_argument("--reset-command", default="AT+Z",
                   help="the reboot command (check 'help' output first)")
    g.add_argument("--yes", action="store_true",
                   help="actually write. Without this, configure is a dry run.")

    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return _selftest()
    if not args.action:
        ap.error("give an action (hello, scan, at, probe) or --selftest")

    dev = LsdDevice(args.host, args.port, args.timeout)
    if args.action == "hello":
        return cmd_hello(dev)
    if args.action == "scan":
        return cmd_scan(dev)
    if args.action == "probe":
        return cmd_probe(dev)
    if args.action == "help":
        return cmd_help(dev, max(args.collect, 6.0))
    if args.action == "get":
        return cmd_get(dev)
    if args.action == "configure":
        return cmd_configure(dev, args)
    if args.action == "at":
        if not args.command:
            ap.error("'at' needs a command, e.g. at \"AT+WSCAN\"")
        return cmd_at(dev, args.command, args.collect)
    return 2


if __name__ == "__main__":
    sys.exit(main())
