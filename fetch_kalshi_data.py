#!/usr/bin/env python3
"""
Backtest of the Mode 4a strategy changes against last night's resolved trades.

Changes under test:
  1. Remove the hard +15c take-profit (winners ride to resolution).
  2. NO-side distance gate: skip NO entries when BTC >= NO_MAX_DISTANCE
     points above the strike (the overnight loss cluster).
  3. No hour filter (one night of hourly data is too noisy to trust).

Honesty note: the live bot stops logging price ticks the moment it takes
profit, so we do NOT know the true resolution of the 41 TP'd trades. We
model "hold to resolution" using the market-implied probability at the exit
moment (exitMid = our side's mid = market P(win)), and report a pessimistic
(all hold-trades lose) / optimistic (all win) band around it.
"""
import json, sys

NO_MAX_DISTANCE = 50
NO_MIN_CONFLUENCE = 6
STATE = sys.argv[1] if len(sys.argv) > 1 else "dashboard/btc_paper_state.json"

trades = [t for t in json.load(open(STATE))["mode4a"]["trades"] if t.get("resolved")]


def category(t):
    er = str(t.get("exitReason") or "")
    if "TP" in er:
        return "TP"
    if "SL" in er:
        return "SL"
    return "HELD"


def hold_outcome(t):
    """EV / optimistic / pessimistic pnl if held to resolution."""
    p = t.get("exitMid")
    if p is None:                       # genuine held trade: use actual pnl
        return t["pnl"], t["pnl"], t["pnl"]
    payout, cost = t["payout"], t["cost"]
    return p * payout - cost, payout - cost, -cost


def gated_out(t):
    if t["side"] != "NO":
        return False
    return (t.get("distance", 0) >= NO_MAX_DISTANCE
            or t.get("confluenceScore", 0) < NO_MIN_CONFLUENCE)


def run(keep_salvage_sl):
    ev = opt = pes = 0.0
    kept = removed = 0
    for t in trades:
        if gated_out(t):
            removed += 1
            continue
        kept += 1
        c = category(t)
        if c == "TP":                                   # no longer exits early
            e, o, p = hold_outcome(t)
        elif c == "SL":
            if keep_salvage_sl:
                e = o = p = t["pnl"]                     # SL still fires
            else:
                e, o, p = hold_outcome(t)               # remove SL -> hold
        else:                                           # already held
            e = o = p = t["pnl"]
        ev += e; opt += o; pes += p
    return ev, opt, pes, kept, removed


baseline = sum(t["pnl"] for t in trades)
print(f"Trades analyzed : {len(trades)}")
print(f"Baseline (actual): {baseline:+.2f}\n")

for label, keep_sl in [("A  remove TP, KEEP salvage SL", True),
                       ("B  remove BOTH TP and SL", False)]:
    ev, opt, pes, kept, removed = run(keep_sl)
    print(f"Variant {label}")
    print(f"   kept {kept} trades (NO-gate removed {removed})")
    print(f"   expected (market-implied): {ev:+.2f}")
    print(f"   band: pessimistic {pes:+.2f}  ..  optimistic {opt:+.2f}\n")

# Incremental attribution (market-implied, salvage SL kept)
def total(gate, notp):
    s = 0.0
    for t in trades:
        if gate and gated_out(t):
            continue
        if notp and category(t) == "TP":
            s += hold_outcome(t)[0]
        else:
            s += t["pnl"]
    return s

print("Incremental contribution (market-implied):")
print(f"   actual                : {total(False, False):+.2f}")
print(f"   + NO-gate only        : {total(True,  False):+.2f}")
print(f"   + remove-TP only      : {total(False, True ):+.2f}")
print(f"   + both                : {total(True,  True ):+.2f}")
