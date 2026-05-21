#!/usr/bin/env python
# -*- coding: utf-8 -*-
import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path


MOVE_DISTANCE = {
    "forward": 0.5,
    "back": 0.5,
    "left": 0.3,
    "right": 0.3,
    "up": 0.2,
    "down": 0.2,
}


def _candidate_lib_paths(explicit_path: str | None):
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path))

    env_path = os.environ.get("CRAZYFLIE_LIB_PATH")
    if env_path:
        candidates.append(Path(env_path))

    script_path = Path(__file__).resolve()
    workspace_root = script_path.parents[3] if len(script_path.parents) >= 4 else None
    if workspace_root:
        candidates.append(workspace_root / "crazyflie" / "crazyflie-lib-python-master")

    cwd = Path.cwd()
    candidates.append(cwd.parent / "crazyflie" / "crazyflie-lib-python-master")

    unique = []
    seen = set()
    for item in candidates:
        key = str(item)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique


def _append_cflib_path(explicit_path: str | None):
    for lib_path in _candidate_lib_paths(explicit_path):
        cflib_dir = lib_path / "cflib"
        if cflib_dir.exists():
            sys.path.insert(0, str(lib_path))
            return str(lib_path)
    return None


def parse_commands(code: str):
    commands = []
    for raw in code.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("//") or line.startswith("#"):
            continue

        if re.match(r"^cf_test_link\s*\(\s*\)\s*;?$", line):
            commands.append(("test_link", None))
            continue
        if re.match(r"^cf_takeoff\s*\(\s*\)\s*;?$", line):
            commands.append(("takeoff", None))
            continue
        if re.match(r"^cf_land\s*\(\s*\)\s*;?$", line):
            commands.append(("land", None))
            continue

        m = re.match(r"^cf_move\s*\(\s*['\"](forward|back|left|right|up|down)['\"]\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)\s*;?$", line)
        if m:
            distance = float(m.group(2)) if m.group(2) is not None else None
            commands.append(("move", {"dir": m.group(1), "distance": distance}))
            continue

        m = re.match(r"^cf_delay\s*\(\s*([0-9]*\.?[0-9]+)\s*\)\s*;?$", line)
        if m:
            commands.append(("delay", float(m.group(1))))

    return commands


def test_link(cflib_module, radio_driver_cls):
    radio_status = "unknown"
    links = []
    scan_error = None

    try:
        radio_status = radio_driver_cls().get_status()
    except Exception as exc:
        radio_status = f"error: {exc}"

    try:
        scanned = cflib_module.crtp.scan_interfaces()
        links = [item[0] if isinstance(item, (list, tuple)) and len(item) > 0 else str(item) for item in scanned]
    except Exception as exc:
        scan_error = str(exc)

    return radio_status, links, scan_error


def run_flow(uri: str, commands):
    import cflib.crtp
    from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
    from cflib.positioning.motion_commander import MotionCommander
    from cflib.crtp.radiodriver import RadioDriver

    cflib.crtp.init_drivers(enable_debug_driver=False)

    radio_status, links, scan_error = test_link(cflib, RadioDriver)

    has_motion_cmd = any(cmd in ("takeoff", "move", "land") for cmd, _ in commands)
    if not has_motion_cmd:
        ok = len(links) > 0
        return {
            "success": ok,
            "message": "Link OK" if ok else "No Crazyflie link discovered",
            "radioStatus": radio_status,
            "links": links,
            "scanError": scan_error,
            "executed": [],
        }

    executed = []
    with SyncCrazyflie(uri) as scf:
        scf.cf.platform.send_arming_request(True)
        time.sleep(1.0)

        with MotionCommander(scf) as mc:
            # MotionCommander enters hover/takeoff context automatically.
            time.sleep(1.0)
            for cmd, arg in commands:
                if cmd == "test_link":
                    executed.append("test_link")
                elif cmd == "takeoff":
                    executed.append("takeoff")
                    time.sleep(0.5)
                elif cmd == "move":
                    direction = arg.get("dir") if isinstance(arg, dict) else None
                    fallback_dist = MOVE_DISTANCE.get(direction, 0.2)
                    dist = arg.get("distance") if isinstance(arg, dict) else None
                    if dist is None:
                        dist = fallback_dist
                    dist = max(0.01, float(dist))

                    if direction == "forward":
                        mc.forward(dist)
                    elif direction == "back":
                        mc.back(dist)
                    elif direction == "left":
                        mc.left(dist)
                    elif direction == "right":
                        mc.right(dist)
                    elif direction == "up":
                        mc.up(dist)
                    elif direction == "down":
                        mc.down(dist)
                    executed.append(f"move:{direction}:{dist}")
                    time.sleep(0.6)
                elif cmd == "delay":
                    wait_sec = max(0.0, float(arg))
                    executed.append(f"delay:{wait_sec}")
                    time.sleep(wait_sec)
                elif cmd == "land":
                    executed.append("land")
                    break

    return {
        "success": True,
        "message": "Flow executed",
        "radioStatus": radio_status,
        "links": links,
        "scanError": scan_error,
        "executed": executed,
    }


def main():
    parser = argparse.ArgumentParser(description="Run Crazyflie flow from generated Blockly code")
    parser.add_argument("--code-base64", required=True)
    parser.add_argument("--uri", default="radio://0/80/2M")
    parser.add_argument("--lib-path", default=None)
    args = parser.parse_args()

    loaded_from = _append_cflib_path(args.lib_path)
    if not loaded_from:
        print(json.dumps({
            "success": False,
            "message": "Cannot locate crazyflie-lib-python (cflib)",
            "loadedFrom": None,
            "executed": [],
        }, ensure_ascii=False))
        return 1

    try:
        code = base64.b64decode(args.code_base64.encode("utf-8")).decode("utf-8", errors="ignore")
        commands = parse_commands(code)
        if not commands:
            print(json.dumps({
                "success": False,
                "message": "No Crazyflie commands found in generated code",
                "loadedFrom": loaded_from,
                "executed": [],
            }, ensure_ascii=False))
            return 2

        result = run_flow(args.uri, commands)
        result["loadedFrom"] = loaded_from
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("success") else 2
    except Exception as exc:
        print(json.dumps({
            "success": False,
            "message": str(exc),
            "loadedFrom": loaded_from,
            "executed": [],
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
