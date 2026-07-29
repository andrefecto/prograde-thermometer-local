# ProGrade WiFi Thermometer → local control, and HomeKit

Take a cheap WiFi grill thermometer that only works through its manufacturer's app
and cloud, and make it report to **your own server** instead — then into HomeKit via
Homebridge.

No hardware modification, no soldering, no proxying, no DNS spoofing, and after
setup the device never contacts the vendor again.

```
thermometer ──UDP──> your server ──> Homebridge ──> Home app
```

It's this easy because of one finding: the thermometer's WiFi module runs in
**transparent passthrough mode** and can simply be *told* where to send its data,
over a plaintext AT-command interface on its own pairing hotspot. One config write
and it reports to you. The reverse engineering behind that is in
[FINDINGS.md](FINDINGS.md).

---

## Does this fit my thermometer?

This is a rebadged design, so the brand on the box means little. Check the hardware
instead — any one of these is a good sign, and the last is conclusive:

- **FCC ID `WEC-EM2251`** printed on the label
- Pairing mode raises an **open WiFi network called `LivingSmart`**
- The device's MAC address starts **`00:95:69`** (Lierda)
- Definitive test — join `LivingSmart`, then:

  ```bash
  python3 dplus/lsd_wifi.py hello
  ```

  A compatible unit answers with its MAC and a model string:

  ```
  mac   : 009569xxxxxx  (00:95:69:xx:xx:xx)
  model : LSD_F205
  ```

The underlying platform is Shenzhen Dtston's "D+", and the radio is a Lierda
LSD4WF module speaking a Hi-Flying-style AT command set. Both are used across many
products, so **other brands and models may well work.** If `hello` answers on your
device, most of this applies — the one thing likely to differ is which bytes carry
the temperature, and there's a tool for that. Reports welcome; see
[Contributing](#contributing).

## Requirements

- Python 3.8+ on any machine that can join WiFi (standard library only — no `pip
  install`)
- Homebridge, if you want the HomeKit half. The tools work without it
- A **2.4 GHz** network. The radio has no 5 GHz support
- The thermometer and Homebridge on the same LAN

## Not affiliated

Independent interoperability work on hardware the author owns. Not affiliated with,
endorsed by, or connected to ProGrade Grilling, Fuzhou Emax Electronic, Lierda
Science & Technology, or Shenzhen Dtston.

Nothing here reflashes firmware or modifies hardware. Every change is a
configuration write that can be reversed — see [Rollback](#rollback). That said, it
is unsupported by the manufacturer and comes with no warranty. Read
[Security notes](#security-notes) before putting the device on your main network.

---

## What runs where

| | Where | How long |
| --- | --- | --- |
| `dplus/lsd_wifi.py` | a laptop, joined to the thermometer's hotspot | steps 1 and 2 |
| `dplus/udp_listen.py`, `analyze.py` | your server | **temporary** — step 3 only |
| `homebridge-prograde` | your Homebridge host | **permanent** |

**There is no long-running Python service.** The plugin does the listening itself.
The scripts configure the device and, once, work out its message layout.

Examples below use `192.168.1.50` for the server and `192.168.1.42` for the
thermometer. Substitute your own.

---

## Step 1 — Point the thermometer at your WiFi

**Reserve a static address for your server first** in your router's admin app (eero,
UniFi, ASUS, OpenWrt — whatever you have). The thermometer stores that address
literally, so if DHCP moves it, the thermometer goes quiet.

**Put the thermometer in pairing mode:** hold the button on the back until the
display shows `-`, which becomes `AP` after a second.

**Join its hotspot:** connect your laptop to the open network `LivingSmart`. If it
asks for a password, try `12345678`.

**Save the existing settings — this is your rollback:**

```bash
python3 dplus/lsd_wifi.py get | tee reference/stock-config.txt
```

A stock unit ends with `AT+NETP  +ok=UDP,CLIENT,17000,SMARTSERVER.EMAXTIME.CN`. No
reply means it has dropped out of pairing mode — hold the button again.

> That file contains your WiFi password in cleartext, because the device hands it
> over on request. It's in `.gitignore`. Keep it, don't commit it.

**Ask the device which networks it can see:**

```bash
python3 dplus/lsd_wifi.py scan
```

```
 ch   rssi  security        --security        ssid
--------------------------------------------------------------------
 11    -44  WPA2 AES        WPA2PSK,AES       MyNetwork
  6    -52  OPEN            OPEN,NONE
```

**This list is your 2.4 GHz check.** If your network isn't in it, the device can't
join no matter what you configure. The `--security` column is already translated
into the format the next command wants.

**Set the WiFi:**

```bash
python3 dplus/lsd_wifi.py configure \
    --ssid "MyNetwork" --wifi-password "my-wifi-password" \
    --station --yes
```

Quote both values — spaces and characters like `&` need it. Use `--open` instead of
`--wifi-password` for an unsecured network, and `--security` if `scan` showed
something other than the default `WPA2PSK,AES`. Drop `--yes` for a dry run, which
prints your current settings and masks the password.

Every command should answer `+ok`. Then **power-cycle the thermometer** and put your
laptop back on your normal network.

The server address is deliberately *not* set here: switching to station mode resets
it, so it has to be written afterwards.

---

## Step 2 — Point it at your server

Once the thermometer has joined your network, its AT interface stays reachable
there. No more pairing mode.

**Find its address** in your router's client list, or by MAC:

```bash
ip neigh | grep -i "00:95:69"
```

**Write the server address**, substituting both IPs:

```bash
python3 dplus/lsd_wifi.py configure --host 192.168.1.42 \
    --server 192.168.1.50 --server-port 17000 --yes
```

**Verify it stuck.** This is the step that catches the reset:

```bash
python3 dplus/lsd_wifi.py get --host 192.168.1.42 | grep NETP
```

You want `+ok=UDP,CLIENT,17000,192.168.1.50`. If it still names
`SMARTSERVER.EMAXTIME.CN`, re-run the configure.

> Because the AT interface answers over the LAN, you can re-check or change any
> setting at any time with `get --host …` and `configure --host …`.

### Alternative: the module's own web UI

The radio module also serves a configuration page, which does the same job without
the command line:

> `http://<device-ip>` → log in with **admin / admin** → **Network parameter
> settings** → protocol `UDP`, port `17000`, server address = your Homebridge host.

Useful as a cross-check, since it shows the same values `lsd_wifi.py get` reports.
Some pages render in Chinese depending on the firmware build. Note this panel is
unauthenticated beyond those default credentials — see
[Security notes](#security-notes).

---

## Step 3 — Confirm data arrives

Copy the scripts to your server temporarily and listen:

```bash
scp -r dplus user@192.168.1.50:~/prograde-dplus
ssh user@192.168.1.50
cd ~/prograde-dplus
python3 udp_listen.py --port 17000 --log session.jsonl
```

**Make sure the thermometer is actually measuring.** It transmits only when it has a
reading, so: probe plugged in, a real number on the display, and the unit awake — it
sleeps after 15 minutes with no temperature change above 122 °F / 50 °C.

Within a second or two:

```
[   0.63s] 192.168.1.42  temperature    dev=69:00:11:22 probe=00
    body[9] = 30 30 00 04 00 92 03 00 00
    offset    0   1   2   3   4   5   6   7   8
    value    48  48   0   4   0 146   3   0   0
```

Bytes 5–6 read little-endian are the temperature in tenths of a degree Celsius —
`0x0392` = 914 = 91.4 °C = 197 °F here.

Roughly one frame in eight arrives with a stray `>` start byte. The decoder accepts
those, so it isn't a problem.

**Nothing arriving?** See [Troubleshooting](#troubleshooting).

### The temperature mapping is already known

For the EM2251 you don't need to work anything out:

| | |
| --- | --- |
| Field | `le5:6` — little-endian 16-bit at body offsets 5–6 |
| Scale | `0.1` |
| Unit | `C` — tenths of a degree Celsius |

Verified against the device's own display: raw `914` → 91.4 °C → 196.5 °F, LCD read
197 °F. These are the plugin's defaults, so there's nothing to configure.

<details>
<summary>Different model, or readings look wrong? Recover the mapping</summary>

With a capture in hand, note the LCD reading and the seconds figure printed on each
line, then:

```bash
python3 analyze.py session.jsonl --observed 30=195 600=197 1800=203
```

It scores every byte and 16-bit pair against your readings and reports which field
is the temperature and at what scale, looking for `r² > 0.999`.

An ordinary cook works fine as the temperature sweep — no ice-water-to-boiling test
needed. Run with **no** `--observed` and it instead ranks fields by how steadily
they climb, which narrows things down before you've written anything down.

Put the winning field, scale and offset into `fields` in the plugin config.
</details>

---

## Step 4 — Install the Homebridge plugin

**Stop `udp_listen.py` first** — it and Homebridge can't both bind the port.

```bash
npm install -g homebridge-prograde
```

Or from this clone: `cd homebridge-prograde && npm install -g .`

**Docker:** the container must be able to receive UDP 17000. With `--network host`
— which most Homebridge setups use, because HomeKit needs mDNS — nothing to do.
Otherwise add `-p 17000:17000/udp`. Check with:

```bash
docker inspect -f '{{.HostConfig.NetworkMode}}' homebridge
```

**Configure.** In the Homebridge UI it appears as **ProGrade Thermometer**, or by
hand:

```json
{
  "platform": "ProGradeThermometer",
  "name": "Grill Thermometer",
  "transport": "udp",
  "listenPort": 17000,
  "staticTargetC": 107.2
}
```

Restart Homebridge. You're done with the Python scripts on the server —
`rm -rf ~/prograde-dplus`.

Full option reference: [`homebridge-prograde/README.md`](homebridge-prograde/README.md).

### The target temperature and the remote alarm

The thermometer keeps its alarm setpoint to itself — it only ever sends the probe
temperature. So set the target in the plugin, in **Celsius**, and it publishes a
**Target** sensor plus a **Target Reached** contact sensor. You also get to change
the target without walking out to the grill.

| You want | `staticTargetC` |
| --- | --- |
| 165 °F | `73.9` |
| 203 °F | `95` |
| 225 °F | `107.2` |

### Battery level

Not available on this model. The messages are nine bytes and contain the probe
label, the temperature, and zeros. One byte (`body[3]`, constantly `0x04`) *might* be
a four-bar battery indicator — if you ever see it drop as the battery runs down,
please open an issue.

---

## Step 5 — Verify

The Homebridge log should show:

```
listening for device telemetry on udp 0.0.0.0:17000
published "Grill Thermometer" to HomeKit
```

In the Home app: **Probe**, **Target**, and **Target Reached**.

**Set up an automation on Target Reached** to get a push notification when the meat
is done — Home app → Automation → *An Accessory Detects Something* → Target Reached
→ Detected. That's the part that makes this worth doing.

The Home app shows whichever unit your iPhone is set to; HomeKit only carries
Celsius internally and there's no per-accessory override.

---

## Troubleshooting

| Problem | Cause and fix |
| --- | --- |
| `0 datagrams` in step 3 | **Usually it's asleep.** Display and radio shut off after 15 minutes with no change above 122 °F / 50 °C. Put the probe in hot water and power-cycle. |
| Still nothing | `sudo tcpdump -n -i any udp port 17000`. Packets there but not in `udp_listen.py` means a firewall — `sudo ufw allow 17000/udp`. Nothing at all means the device isn't sending. |
| Device isn't sending | Re-run `lsd_wifi.py get --host <device-ip>`. Check `AT+NETP` names your server, `AT+WSSSID` your network, `AT+WMODE` says `STA`. |
| `lsd_wifi.py` gets no reply | In step 1, you're not on `LivingSmart` or it left pairing mode — hold the rear button until the display reads `AP`. Later, check the device IP. |
| It won't join the network | Run `scan`. Not listed means 5 GHz-only or out of range. Listed means re-check the password and that `--security` matches its row. |
| `AT+WSKEY` rejected | `--security` wants `<auth>,<encryption>`: auth `OPEN`/`SHARED`/`WPAPSK`/`WPA2PSK`, encryption `NONE`/`WEP`/`TKIP`/`AES`. Take it from `scan`. |
| Temperatures wildly wrong | The field mapping doesn't match your unit — see the recover-the-mapping section in step 3. |
| Off by a constant factor | Wrong `fields.scale`, or `fields.unit` doesn't match what the device reports in. |
| Accessory shows "No Response" | Homebridge isn't receiving. If not on host networking, the UDP port isn't published. |
| Temperature never updates; log says "heartbeat frames with no temperature" | Your acknowledgement is not reaching the device. It only reports when its heartbeat is echoed back — see [How the device decides to report](#how-the-device-decides-to-report). Check `acknowledge` is not set to `false`, and that nothing is blocking outbound UDP to the device. |
| Display shows `LLL` or `HHH` | Probe shorted by heat or water damage. A hardware fault, not a config problem. |

---

## How the device decides to report

Worth understanding, because it is unintuitive: **the thermometer will not send a
temperature unless you acknowledge it.**

Left alone it sends a short heartbeat once a second and no reading at all — not
even while its own alarm is going off. Echo that datagram straight back and it
replies with the probe temperature. The vendor's server evidently acknowledged
every packet, and the MCU treats that as permission to report.

Both `udp_listen.py` and the plugin do this automatically. You only need to know
about it if you write your own client, or if you see heartbeat frames and no
temperatures — in which case something is dropping your echo.

**Not transmitted at all:** the alarm setpoint and battery level. That is why the
target is a plugin setting rather than read from the device.

## Rollback

Nothing was flashed. To restore factory behaviour, re-enter pairing mode and write
back the values from your step 1 `reference/stock-config.txt`, in particular:

```bash
python3 dplus/lsd_wifi.py at "AT+NETP=UDP,CLIENT,17000,SMARTSERVER.EMAXTIME.CN"
```

Power-cycle. The vendor app works again.

---

## Security notes

Findings about the device, not things this project introduces. Worth knowing:

- **The pairing hotspot is open and unauthenticated**, and `AT+WSKEY` returns the
  stored WiFi password in cleartext to anything that joins it. Anyone in range of a
  unit in pairing mode can read your network credentials off it.
- **The AT interface stays open on your LAN** in station mode, with no
  authentication. Any host on the network can reconfigure the device.
- **The module has a web UI on port 80** with default credentials.
- **The vendor app** contacts third-party analytics (MobTech, Tencent Bugly)
  independently of the thermometer.

Put this device on a **guest or IoT SSID**, not your main network. Wipe its config
before reselling or discarding it.

---

## What's in here

| Path | Purpose |
| --- | --- |
| `dplus/lsd_wifi.py` | Talk to the device: `hello`, `get`, `scan`, `configure`, `help`, `at` |
| `dplus/udp_listen.py` | Receive and decode telemetry; logs JSONL for `analyze.py` |
| `dplus/analyze.py` | Work out which body bytes hold the temperature |
| `dplus/emax.py` | Codec for this product's telemetry format |
| `dplus/protocol.py` | Codec for the generic Dtston "D+" framing |
| `homebridge-prograde/` | The Homebridge plugin |
| `reference/fcc/` | FCC teardown photos and the radio module manual |
| [`FINDINGS.md`](FINDINGS.md) | Hardware identification, protocols, how this was found |

Every script takes `--help`, and each has a `--selftest` that runs with no device
attached:

```bash
python3 dplus/protocol.py
python3 dplus/emax.py
python3 dplus/analyze.py --selftest
python3 dplus/lsd_wifi.py --selftest
python3 dplus/udp_listen.py --selftest
cd homebridge-prograde && npm test
```

---

## Contributing

Compatibility reports for other brands and models are the most useful thing you can
send. A good one has:

1. The **FCC ID** from the label, and the brand and model name
2. Output of `python3 dplus/lsd_wifi.py get` — **redact the `AT+WSKEY` line**, it
   contains your WiFi password
3. A few frames from `udp_listen.py`, plus what the display read at the time

That last item is enough for me to work out the temperature mapping for your model.
Issues and pull requests welcome.
