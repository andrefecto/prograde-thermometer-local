# Findings

Reference material behind the setup in [README.md](README.md). You don't need any
of this to make the thermometer work — it's here so the result isn't lost.

## The hardware

ProGrade didn't design the electronics. It's a rebadged Fuzhou Emax design built
on Shenzhen DTston's "D+" IoT platform.

| | |
| --- | --- |
| OEM | Fuzhou Emax Electronic Co., Ltd. — hence the `com.emax.pro` app package |
| Model | EM2251, "WIFI Cooking Thermometer", FCC ID `WEC-EM2251`, certified 2017-09-29 |
| PCB | `EM2251WIFI MAIN V1.3`, dated 2016-04-15 |
| Radio | Lierda **LSD4WF-2MD05106** module, own modular grant `N8NLSD4WF2MD05106` |
| Radio SoC | Realtek Ameba, ARM Cortex-M3 @ 166 MHz — *not* an ESP8266 |
| MAC block | `00:95:69` (LSD Science and Technology / Lierda, Hangzhou) |
| Band | 2412–2462 MHz, channels 1–11. 2.4 GHz only |
| Main MCU | unmarked chip-on-board epoxy blob driving a segment LCD |
| Radio mounting | 48-pin castellated module, 32.8 × 23.1 × 3.2 mm — removable |

The FCC internal photos in `reference/fcc/` show the radio desoldered next to its
empty footprint, which is why replacing it was ever on the table. It turned out to
be unnecessary.

## How it talks: pairing mode

Hold the rear button until the display shows `-`, then `AP`. The module raises an
**unsecured** access point called `LivingSmart` and runs a UDP-to-AT-command
bridge on it:

| | |
| --- | --- |
| Subnet | `11.11.11.0/24`, device at **`11.11.11.254`**, client gets `11.11.11.1` |
| Port | **UDP 8800** |
| Hello | send `LSD_WIFI` → reply `<mac>,<model>`, e.g. `009569001122,LSD_F205` |
| Command | send `LSD_WIFI:<AT command>\r\n` → AT output, one datagram per line |

`AT+WSCAN` returns a site survey, one datagram per network:

```
<index>   Infra     <bssid>  <rssi>  <channel>  "<security>"  "<ssid>"
1   Infra     20:be:cd:3b:45:27  -44  11  "WPA2 AES"  "SomeNetwork"
```

The AT dialect is the Hi-Flying HF-LPB100 set — `AT+WMODE`, `AT+NETP`, `AT+WANN`,
`AT+WSKEY`, `AT+WSSSID`, `AT+ENTM`, `AT+WSLQ`, `AT+TCPDIS`, `AT+E`. The help
command is `AT+H`; plain `AT` and `AT+HELP` both answer `+ERR=-2`.

Implemented in `dplus/lsd_wifi.py`.

## How it talks: normal operation

This is the finding that made everything else unnecessary. On a stock unit:

```
AT+NETP  →  +ok=UDP,CLIENT,17000,SMARTSERVER.EMAXTIME.CN
```

The module isn't an MQTT client and doesn't run a LAN control server. It sits in
**transparent passthrough mode** (`AT+ENTM`) and ships the thermometer MCU's raw
serial frames as UDP datagrams to whatever host `AT+NETP` names — `emaxtime`
being Fuzhou Emax, matching the FCC applicant's contact domain.

`AT+NETP` is writable, so you just tell it to send to your own machine. No DNS
spoofing, no cloud impersonation, no proxy, no hardware.

The `ourslinks.com` endpoints (`api.ourslinks.com`, all plain HTTP) belong to the
phone **app**, not the device. Irrelevant once the app is out of the picture.

## The telemetry format

**This is what the device actually sends** — not the D+ framing below. The D+ spec
describes DTston's generic MCU protocol, but this product's MCU uses its own
simpler format, and the WiFi module passes it through verbatim.

Captured frame, 18 bytes, sent roughly once a second:

```
3c 54 01 69 00 11 22 30 30 00 04 00 92 03 00 00 26 3e
<  T  ?  <--dev id--> "0 0" <---- body ----> ck >
```

| offset | size | field |
| --- | --- | --- |
| 0 | 1 | start, `0x3C` `'<'` |
| 1 | 1 | type, `0x54` `'T'` on temperature reports |
| 2 | 1 | unknown, `0x01` observed |
| 3 | 4 | device id — the last four bytes of the module MAC |
| 7 | N | body |
| −2 | 1 | checksum: `sum(frame[:-2]) & 0xFF`, **including** the `'<'` |
| −1 | 1 | end, `0x3E` `'>'` |

Body layout, 9 bytes:

| offset | value | meaning |
| --- | --- | --- |
| 0–1 | `30 30` | ASCII `"00"`, probe/channel index |
| 2 | `00` | constant |
| 3 | `04` | constant. Possibly a 4-bar battery indicator — unconfirmed |
| 5–6 | `92 03` | **probe temperature, little-endian, tenths of a degree Celsius** |
| 7–8 | `00 00` | constant |

Confirmed against the device's own display: raw `914` → 91.4 °C → 196.5 °F while
the LCD read 197 °F. A second capture gave `904` → 90.4 °C → 195 °F.

The device transmits **only** the probe temperature. Its alarm setpoint and battery
level are not in the frame — every byte pair was checked for the setpoint (225 °F =
1072 tenths °C, 2250 tenths °F, 225, 107) and none appear.

**Two message shapes.** The 9-byte body above carries a reading. The device also
emits a 14-byte frame with a 5-byte body of `01 01 01 00 00` and no temperature,
about once a second, which appears to be an idle heartbeat. Observed at 80–90 °F
and at 158–160 °F, whereas the temperature frames were observed at ~195 °F during a
real cook. Both checksum correctly, so the short one is deliberate rather than
truncated. What selects between them is unresolved; a 50 °C threshold and the alarm
setpoint have both been ruled out.

**Firmware quirk:** roughly one frame in eight arrives with `0x3E` (`'>'`) as its
first byte instead of `0x3C`. The rest of the frame is intact and its checksum is
the one computed for a leading `'<'`, so both codecs accept it rather than
dropping an eighth of the telemetry.

Implemented in `dplus/emax.py` and `homebridge-prograde/lib/emax.js`, both tested
against real captured frames.

## The D+ frame format (not used by this product)

From DTston's own spec (see Sources). The link is 9600 8N1 over UART
between the thermometer's MCU and the radio module; those same bytes are what
arrive over UDP.

```
 offset  size  field
 0       1     header       always 0xAA
 1       1     length       total frame length, header..checksum
 2       2     packet_id    session id; replies echo the request's id
 4       8     device_info  8 x 0x00 from the MCU side
 12      2     func         function code, big-endian
 14      2     reserved     always 0x0000
 16      N     body         function-specific
 16+N    1     checksum     two's complement of sum(header..body)
```

`length == 17 + N`, all multi-byte fields big-endian,
`checksum = (-sum(frame[:-1])) & 0xFF`.

Function codes documented as identical across every D+ product:

| Code | Direction | Meaning |
| --- | --- | --- |
| `0x1001` / `0x1801` | to device / reply | status query |
| `0x2000` | from device | **state report — the temperature lives here** |
| `0x2001` / `0x2801` | MCU → radio | enter pairing; body starts `"QQDM"` |
| `0x2002` | radio → MCU | signal bars 1–3, router up/down, cloud up/down |
| `0x3001` / `0x3801` | radio → MCU / reply | product type (2 bytes) |

Implemented in `dplus/protocol.py` and `homebridge-prograde/lib/dplus.js`, both
tested against the three worked examples printed in the spec. Kept because sibling
products on this platform do use it, and because it documents the UART link — but
the EM2251's telemetry is the `emax` format above.

`dplus/analyze.py` works on either: it fits every byte and 16-bit pair in a body
against temperatures read off the LCD and reports which field is the probe and at
what scale. Run with no `--observed` it instead ranks fields by how steadily they
climb, which identifies the temperature during a normal cook.

## Security notes

Two things worth knowing, neither introduced by anything here:

- **The pairing AP is unsecured and unauthenticated, and `AT+WSKEY` returns the
  stored WiFi password in cleartext.** Anyone in range of a unit in pairing mode
  can read your network credentials off it. Wipe the config before reselling or
  discarding the device, and prefer a guest/IoT SSID over your main network.
- **The app phones home to Chinese analytics** — `m.data.mob.com`, `d.mob.com`,
  `api.share.mob.com` (MobTech) and `ios.bugly.qq.com` (Tencent Bugly), all
  observed while capturing the app pairing a device. Another reason to stop
  using it.

## Sources

- DTston's own SDKs and protocol docs: [`github.com/dtston-dtcloud`](https://github.com/dtston-dtcloud)
- D+ UART protocol spec v1.7: `http://assist.dtston.com/sdk/Embedded/D+mcu_1.7.doc`
  (HTTP only; HTTPS 404s). Not redistributed here — it carries a confidentiality
  notice for the vendor's OEM partners, and everything this project uses from it
  is documented above.
- [FCC ID WEC-EM2251](https://fccid.io/WEC-EM2251) — the thermometer
- [FCC ID N8NLSD4WF2MD05106](https://fccid.io/N8NLSD4WF2MD05106) — the radio module
- [ProGrade FAQ](http://progradegrill.com/faq/)

## What's in `reference/`

| | |
| --- | --- |
| `fcc/em2251-internal-*.jpg` | FCC teardown photos, showing the removable radio module |
| `fcc/LSD4WF-2MD05106_manual.pdf` | Lierda module manual: pinout, AT command set, electrical specs |

Both are US FCC public records, redistributed here so the teardown stays readable
if those filings move.

Two things are deliberately **not** published:

- The packet capture that recovered the `LSD_WIFI` protocol — it contains a WiFi
  site survey listing neighbouring network names. The protocol it revealed is
  documented above and implemented in `dplus/lsd_wifi.py`.
- DTston's UART protocol spec — see Sources for where to get it.

Frames quoted in this document and used as test vectors have had the device ID
replaced with `69 00 11 22` and their checksums recomputed, so they are structurally
genuine but don't identify a particular unit. The `00:95:69` OUI is real.
