#!/usr/bin/env python3
"""
Work out which bytes of a telemetry frame's body carry the probe temperature.

Reads the JSONL that udp_listen.py writes, in either format it decodes: 'emax',
which is what this product's MCU sends, or 'dplus', the generic DTston framing.
Neither documents its body layout -- the D+ spec's worked example is an air
purifier -- so the layout has to be recovered from observation.

Two modes:

  1. Structure pass (no annotations needed): show which body offsets are
     constant and which vary, so you can ignore the dead ones.

  2. Correlation pass: given readings you noted off the thermometer's own LCD,
     score every candidate field -- each single byte, and each adjacent 2-byte
     pair in both endiannesses -- by how well it fits a linear model
     temp = a * raw + b. A field that is really the temperature fits almost
     perfectly (r^2 > 0.99) with a recognisable scale: a == 1 for whole degrees,
     a == 0.1 for tenths, a == 0.555 if it is Celsius and you logged Fahrenheit.

Usage:
    python3 analyze.py session.jsonl
    python3 analyze.py session.jsonl --observed 12.5=72 40.0=115 61.2=140
    python3 analyze.py --selftest
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict

from protocol import FUNC_STATUS_REPORT


def load(path: str) -> list[dict]:
    records = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def candidate_fields(body: bytes) -> dict[str, int]:
    """Every plausible numeric field in a body: bytes and 16-bit pairs."""
    fields: dict[str, int] = {}
    for i, b in enumerate(body):
        fields[f"b{i}"] = b
    for i in range(len(body) - 1):
        fields[f"be{i}:{i+1}"] = (body[i] << 8) | body[i + 1]
        fields[f"le{i}:{i+1}"] = (body[i + 1] << 8) | body[i]
    return fields


def structure_pass(bodies: list[bytes]) -> None:
    """Report which offsets move and which are dead, across all samples."""
    if not bodies:
        print("no bodies to analyse")
        return
    width = max(len(b) for b in bodies)
    print(f"{len(bodies)} samples, body length "
          f"{min(len(b) for b in bodies)}..{width}\n")
    print(f"{'off':>4}  {'distinct':>8}  {'min':>4}  {'max':>4}  values")
    print("-" * 64)
    for i in range(width):
        vals = [b[i] for b in bodies if len(b) > i]
        if not vals:
            continue
        uniq = sorted(set(vals))
        shown = ", ".join(str(v) for v in uniq[:8])
        if len(uniq) > 8:
            shown += f", ... (+{len(uniq) - 8})"
        flag = "  <- constant" if len(uniq) == 1 else ""
        print(f"{i:>4}  {len(uniq):>8}  {min(vals):>4}  {max(vals):>4}  "
              f"{shown}{flag}")
    print("\nOffsets with many distinct, steadily-changing values are the "
          "temperature candidates.\nRe-run with --observed to confirm.")


def linfit(xs: list[float], ys: list[float]) -> tuple[float, float, float]:
    """Least-squares fit y = a*x + b. Returns (a, b, r_squared)."""
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx == 0:
        return 0.0, my, 0.0
    a = sxy / sxx
    b = my - a * mx
    syy = sum((y - my) ** 2 for y in ys)
    if syy == 0:
        return a, b, 0.0
    resid = sum((y - (a * x + b)) ** 2 for x, y in zip(xs, ys))
    return a, b, 1.0 - resid / syy


def interpret(a: float) -> str:
    """Name the scale factor if it matches a familiar encoding."""
    for scale, label in (
        (1.0, "whole degrees, same unit as your readings"),
        (0.1, "tenths of a degree"),
        (0.5, "half degrees"),
        (0.05, "twentieths"),
        (1.8, "raw is Celsius, readings are Fahrenheit"),
        (0.18, "raw is tenths of Celsius, readings are Fahrenheit"),
        (0.5555, "raw is Fahrenheit, readings are Celsius"),
    ):
        if abs(a - scale) < 0.03 * max(scale, 0.1):
            return label
    return "unrecognised scale"


def correlation_pass(records: list[dict], observed: list[tuple[float, float]],
                     top: int = 8) -> None:
    """Match each annotated reading to the nearest frame, then score fields."""
    if len(observed) < 3:
        print("need at least 3 observations for a meaningful fit", file=sys.stderr)
        return

    t0 = min(r["t"] for r in records)
    # pair each observation with the closest-in-time state report
    samples: list[tuple[bytes, float]] = []
    for offset_s, temp in observed:
        target = t0 + offset_s
        best = min(records, key=lambda r: abs(r["t"] - target))
        drift = abs(best["t"] - target)
        if drift > 30:
            print(f"! observation at {offset_s}s is {drift:.0f}s from the "
                  f"nearest frame; ignoring")
            continue
        samples.append((bytes.fromhex(best["body"]), temp))

    if len(samples) < 3:
        print("not enough usable observations after time matching")
        return

    # score every field that is present in all samples
    per_field: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for body, temp in samples:
        for name, raw in candidate_fields(body).items():
            per_field[name].append((float(raw), temp))

    scored = []
    for name, pairs in per_field.items():
        if len(pairs) != len(samples):
            continue
        xs = [p[0] for p in pairs]
        ys = [p[1] for p in pairs]
        if len(set(xs)) < 2:
            continue  # constant field cannot encode a changing temperature
        a, b, r2 = linfit(xs, ys)
        scored.append((r2, name, a, b))

    scored.sort(reverse=True)
    print(f"\nscored {len(scored)} candidate fields against "
          f"{len(samples)} observations\n")
    print(f"{'r^2':>7}  {'field':<10}  {'temp = a*raw + b':<26}  interpretation")
    print("-" * 78)
    for r2, name, a, b in scored[:top]:
        model = f"{a:.4g} * raw + {b:.4g}"
        note = interpret(a) if r2 > 0.99 else ""
        print(f"{r2:>7.4f}  {name:<10}  {model:<26}  {note}")

    if scored and scored[0][0] > 0.999:
        r2, name, a, b = scored[0]
        print(f"\nStrong match: field {name} with temp = {a:.4g}*raw + {b:.4g} "
              f"(r^2={r2:.5f}).")
        print("Confirm it by pulling the probe out of the meat and watching "
              "that field track the LCD down.")
    else:
        print("\nNo decisive match. Collect readings across a wider temperature "
              "range (ice water to boiling water is ideal) and try again.")


def rising_pass(records: list[dict], top: int = 8) -> None:
    """
    Find the temperature field without any LCD readings at all.

    During a cook the probe temperature climbs steadily and almost never falls,
    which is a strong signature: the temperature field should be the one that
    rises monotonically and tracks elapsed time closely. Counters and flags do
    not behave like that, and constants are excluded outright.

    This narrows the candidates before you have written anything down. One or two
    readings then pin the scale, via --observed.
    """
    ordered = sorted(records, key=lambda r: r["t"])
    bodies = [bytes.fromhex(r["body"]) for r in ordered]
    times = [r["t"] - ordered[0]["t"] for r in ordered]
    if len(bodies) < 4:
        print("need at least 4 frames to judge a trend")
        return

    per_field: dict[str, list[float]] = defaultdict(list)
    for body in bodies:
        for name, raw in candidate_fields(body).items():
            per_field[name].append(float(raw))

    scored = []
    for name, values in per_field.items():
        if len(values) != len(bodies) or len(set(values)) < 2:
            continue  # missing from some frames, or constant
        deltas = [b - a for a, b in zip(values, values[1:])]
        rising = sum(1 for d in deltas if d >= 0) / len(deltas)
        spread = max(values) - min(values)
        _, _, r2 = linfit(times, values)
        # a byte that wraps 255->0 looks like a big drop; penalise those
        wraps = sum(1 for d in deltas if d < -100)
        scored.append((rising, r2, spread, wraps, name, values))

    # rank by monotonicity first, then how linearly it tracks time
    scored.sort(key=lambda s: (round(s[0], 3), round(s[1], 3), s[2]), reverse=True)

    print(f"\nfields that rise over {len(bodies)} frames spanning "
          f"{times[-1] / 60:.1f} minutes\n")
    print(f"{'field':<10}  {'rising':>7}  {'r2 vs t':>8}  {'raw range':<15}  "
          f"as whole deg     as tenths")
    print("-" * 82)
    for rising, r2, spread, wraps, name, values in scored[:top]:
        lo, hi = min(values), max(values)
        flag = "  <- byte wraps" if wraps else ""
        print(f"{name:<10}  {rising * 100:>6.0f}%  {r2:>8.4f}  "
              f"{lo:>6.0f}..{hi:<7.0f}  "
              f"{lo:>6.0f}..{hi:<7.0f}  {lo / 10:>6.1f}..{hi / 10:<7.1f}{flag}")

    if scored:
        best = scored[0]
        print(f"\nBest candidate: {best[4]}, rising in {best[0] * 100:.0f}% of "
              f"steps, r^2 {best[1]:.4f} against time.")
        print("Compare its two range columns against what the display actually "
              "did during\nthe cook -- whichever column looks like real "
              "temperatures tells you the scale.")
        print("Then confirm properly with --observed once you have a couple of "
              "readings.")


def parse_observed(items: list[str]) -> list[tuple[float, float]]:
    out = []
    for item in items:
        try:
            offset, temp = item.split("=")
            out.append((float(offset), float(temp)))
        except ValueError:
            raise SystemExit(f"bad --observed entry {item!r}; want SECONDS=TEMP")
    return out


def selftest() -> int:
    """Synthetic body where offset 4:5 is a big-endian tenths-of-a-degree field."""
    import random

    random.seed(7)
    records, observed = [], []
    for i, temp in enumerate([72.0, 96.5, 115.0, 140.2, 165.9, 203.4]):
        body = bytearray(12)
        body[0] = 2               # constant: "on"
        body[1] = random.randrange(4)   # noise
        raw = int(round(temp * 10))
        body[4] = (raw >> 8) & 0xFF
        body[5] = raw & 0xFF
        body[9] = 1               # constant
        t = 1000.0 + i * 10
        records.append({"t": t, "func": FUNC_STATUS_REPORT, "body": body.hex()})
        observed.append((i * 10.0, temp))

    bodies = [bytes.fromhex(r["body"]) for r in records]
    structure_pass(bodies)
    correlation_pass(records, observed)

    # verify the analyzer actually picks the planted field
    per_field: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for (body, (_, temp)) in zip(bodies, observed):
        for name, raw in candidate_fields(body).items():
            per_field[name].append((float(raw), temp))
    best = max(
        ((linfit([p[0] for p in v], [p[1] for p in v])[2], k)
         for k, v in per_field.items() if len(set(p[0] for p in v)) > 1),
    )
    assert best[1] == "be4:5", f"expected be4:5, analyzer chose {best[1]}"
    a = linfit([p[0] for p in per_field["be4:5"]],
               [p[1] for p in per_field["be4:5"]])[0]
    assert abs(a - 0.1) < 1e-6, a
    assert "tenths" in interpret(a), interpret(a)
    print("\nanalyze.py: self-test passed "
          "(planted be4:5 tenths-of-a-degree field recovered)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("log", nargs="?", help="a .jsonl capture from udp_listen.py")
    ap.add_argument("--observed", nargs="+", metavar="SECONDS=TEMP", default=[],
                    help="readings you noted off the LCD, as offset=temperature")
    ap.add_argument("--func", type=lambda s: int(s, 16), default=None,
                    help="only analyse this message type, in hex "
                         "(default: whichever is most common in the log)")
    ap.add_argument("--rising", action="store_true",
                    help="rank fields by how steadily they climb, which finds "
                         "the temperature during a cook with no LCD readings")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        return selftest()
    if not args.log:
        ap.error("give a .jsonl capture, or --selftest")

    records = load(args.log)
    usable = [r for r in records if r.get("body")]
    if not usable:
        raw = sum(1 for r in records if r.get("format") == "raw")
        print(f"no decoded frames with a body in {args.log}")
        if raw:
            print(f"({raw} datagram(s) were logged raw because they did not "
                  f"decode. Paste one to me and I'll work out the format.)")
        return 1

    if args.func is not None:
        chosen = args.func
    else:
        # Take the most common message type present rather than assuming a
        # particular protocol's codes -- this log may be emax or D+.
        counts = Counter(r["func"] for r in usable if "func" in r)
        if not counts:
            chosen = None
        else:
            chosen = counts.most_common(1)[0][0]

    if chosen is not None:
        records = [r for r in usable if r.get("func") == chosen]
        if not records:
            present = sorted({r["func"] for r in usable if "func" in r})
            print(f"no frames with type 0x{chosen:02x}. Present: "
                  f"{', '.join(f'0x{f:02x}' for f in present)}")
            return 1
        label = f"type 0x{chosen:02x}"
    else:
        records = usable
        label = "all frames"

    fmts = sorted({r.get("format", "dplus") for r in records})
    print(f"analysing {len(records)} frames ({label}, format "
          f"{'/'.join(fmts)}) from {args.log}\n")
    structure_pass([bytes.fromhex(r["body"]) for r in records])
    if args.rising or not args.observed:
        rising_pass(records)
    if args.observed:
        correlation_pass(records, parse_observed(args.observed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
