#!/usr/bin/env python3
"""Standalone strict Node TAP evidence parser; no app or network operations."""
import hashlib
import re


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def inspect_tap(data: bytes) -> dict:
    text = data.decode("utf-8")
    if not data or len(re.findall(r"^TAP version 13$", text, re.M)) != 1:
        raise ValueError("empty or invalid TAP header")
    counts = {}
    for key in ("tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"):
        values = re.findall(rf"^# {key} (\d+)$", text, re.M)
        if len(values) != 1:
            raise ValueError(f"incomplete/duplicate TAP {key} footer")
        counts[key] = int(values[0])
    if not re.fullmatch(r"# duration_ms [\d.]+", text.rstrip().splitlines()[-1]):
        raise ValueError("missing terminal TAP duration")
    plans = re.findall(r"^1\.\.(\d+)$", text, re.M)
    top = [int(n) for n in re.findall(r"^(?:not )?ok (\d+)(?:\s|$)", text, re.M)]
    points = re.findall(r"^\s*(?:not )?ok \d+(?:\s|$)", text, re.M)
    if len(plans) != 1 or top != list(range(1, int(plans[0]) + 1)):
        raise ValueError("TAP top-level plan/result mismatch")
    if len(points) != counts["tests"] + counts["suites"]:
        raise ValueError("TAP total result points mismatch")
    if counts["tests"] != sum(counts[k] for k in ("pass", "fail", "cancelled", "skipped", "todo")):
        raise ValueError("TAP counter arithmetic mismatch")
    return {
        "log_complete": True, "log_bytes": len(data), "log_sha256": digest(data),
        "tap_plan": int(plans[0]), "tap_result_points": len(points), "tap_counts": counts,
    }
