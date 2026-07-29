# homebridge-prograde

HomeKit support for the **ProGrade WiFi grilling thermometer** (Emax EM2251, FCC ID
`WEC-EM2251`) and its rebadges — with no vendor app, no cloud account, and no
hardware modification.

The thermometer's WiFi module can be told where to send its data. Point it at your
Homebridge host and it reports straight to this plugin over UDP. Nothing is
intercepted or proxied, and the vendor's servers are never contacted.

> **The device needs configuring first.** It ships pointed at the manufacturer's
> server. Redirecting it takes one command from the
> [main repository](https://github.com/andrefecto/prograde-thermometer-local) — start
> there, then come back here. This plugin alone won't do anything.

## What appears in HomeKit

| Service | Notes |
| --- | --- |
| **Probe** — temperature sensor | The meat temperature, updating about once a second |
| **Target** — temperature sensor | Only if you set `staticTargetC` |
| **Target Reached** — contact sensor | *Detected* once the probe reaches the target |
| **Battery** | Only if your unit reports one. The EM2251 does not |

HomeKit has no food-probe accessory type, hence the sensor mapping. Services only
appear when there's real data behind them, so you never get a permanently blank tile.

**Use *Target Reached* as an automation trigger** to get a push notification when the
meat is done — Home app → Automation → *An Accessory Detects Something*.

## Install

```bash
npm install -g homebridge-prograde
```

Or from a clone:

```bash
git clone https://github.com/andrefecto/prograde-thermometer-local.git
cd prograde-thermometer-local/homebridge-prograde && npm install -g .
```

If Homebridge runs in Docker, the container must be able to receive UDP on the
listen port. With `--network host` — which most Homebridge setups use, because
HomeKit needs mDNS — there's nothing to do. Otherwise publish the port with
`-p 17000:17000/udp`.

## Configure

The plugin appears in the Homebridge UI as **ProGrade Thermometer**. By hand:

```json
{
  "platform": "ProGradeThermometer",
  "name": "Grill Thermometer",
  "transport": "udp",
  "listenPort": 17000,
  "staticTargetC": 107.2
}
```

`listenPort` must match the port you set on the device. The field mapping defaults
are already correct for the EM2251.

### Why the target is a setting

The thermometer never transmits its own alarm setpoint — it only sends the probe
temperature. So set the target here, in **Celsius**, and the plugin derives the
"reached" state itself. A bonus: you can change it without walking to the grill.

| | `staticTargetC` |
| --- | --- |
| 165 °F | `73.9` |
| 203 °F | `95` |
| 225 °F | `107.2` |

Leave it out and you get the probe temperature alone.

### All options

| Key | Default | Meaning |
| --- | --- | --- |
| `transport` | `udp` | `udp` for a real device, `sim` to try it with none |
| `listenPort` | `17000` | Must match the device's configured port |
| `bindAddress` | `0.0.0.0` | Interface to listen on |
| `staticTargetC` | — | Target in Celsius; enables Target and Target Reached |
| `staleSeconds` | `120` | Mark sensors inactive after this much silence |
| `pollSeconds` | `0` | `0` = passive. The EM2251 reports unprompted |
| `exposeTarget` / `exposeAlarm` / `exposeBattery` | `true` | Suppress individual services |
| `fields.probe` | `le5:6` | Where the temperature is in the message body |
| `fields.scale` / `.offset` / `.unit` | `0.1` / `0` / `C` | `temp = scale * raw + offset` |

Other fields (`fields.target`, `.alarm`, `.battery`) are blank because this device
doesn't send them. If you have a different unit on the same platform, recover its
layout with the tools in the main repo and set them here.

The Home app displays whichever unit your iPhone is set to — HomeKit only carries
Celsius internally and there's no per-accessory override.

## Try it without a thermometer

Set `"transport": "sim"` and restart. You get an accessory whose probe temperature
climbs through a realistic cook — including a stall around 65–70 °C, because
brisket does that — and trips the contact sensor on arrival. Useful for getting
your automations right before the hardware is involved.

## Development

```bash
npm test        # 43 tests
npm run sim     # watch the simulator on the console
```

Tests cover both frame codecs against real captured frames and the vendor spec's
own worked examples, plus the platform driven through a mock HAP to confirm frames
become the right characteristic values.

## Licence

MIT. Not affiliated with ProGrade Grilling, Fuzhou Emax, Lierda or Dtston.
