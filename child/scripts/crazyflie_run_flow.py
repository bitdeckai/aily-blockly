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

DEFAULT_URI = "radio://0/80/2M"
DEFAULT_ADDRESS_HEX = "E7E7E7E7E7"


def _candidate_lib_paths(explicit_path: str | None):
    def append_repo_variants(base: Path, result: list[Path]):
        result.append(base)
        name = base.name.lower()
        if name == "crazyflie-lib-python":
            result.append(base.with_name("crazyflie-lib-python-master"))
        elif name == "crazyflie-lib-python-master":
            result.append(base.with_name("crazyflie-lib-python"))

    candidates = []
    if explicit_path:
        append_repo_variants(Path(explicit_path), candidates)

    env_path = os.environ.get("CRAZYFLIE_LIB_PATH")
    if env_path:
        candidates.append(Path(env_path))

    script_path = Path(__file__).resolve()
    workspace_root = script_path.parents[3] if len(script_path.parents) >= 4 else None
    if workspace_root:
        append_repo_variants(workspace_root / "crazyflie" / "crazyflie-lib-python", candidates)

    cwd = Path.cwd()
    append_repo_variants(cwd.parent / "crazyflie" / "crazyflie-lib-python", candidates)

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
    # Prefer cflib already installed in the active Python environment.
    try:
        import cflib  # noqa: F401
        return "site-packages"
    except Exception:
        pass

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

        if re.match(r"^cf_test_link\s*\(\s*(?:['\"].*?['\"]\s*(?:,\s*['\"].*?['\"]\s*)?)?\)\s*;?$", line):
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
            continue

        m = re.match(r"^cf_print\s*\(\s*(.*?)\s*\)\s*;?$", line)
        if m:
            commands.append(("print", m.group(1)))
            continue

    return commands


def _normalize_print_value(raw):
    text = str(raw).strip()
    if len(text) >= 2 and ((text[0] == "'" and text[-1] == "'") or (text[0] == '"' and text[-1] == '"')):
        try:
            return bytes(text[1:-1], "utf-8").decode("unicode_escape")
        except Exception:
            return text[1:-1]
    return text


def _step_label(cmd, arg):
    if cmd == "takeoff":
        return "takeoff"
    if cmd == "land":
        return "land"
    if cmd == "delay":
        return f"delay:{max(0.0, float(arg))}"
    if cmd == "print":
        return f"print:{_normalize_print_value(arg)}"
    if cmd == "move":
        direction = arg.get("dir") if isinstance(arg, dict) else None
        fallback_dist = MOVE_DISTANCE.get(direction, 0.2)
        dist = arg.get("distance") if isinstance(arg, dict) else None
        if dist is None:
            dist = fallback_dist
        dist = max(0.01, float(dist))
        return f"move:{direction}:{dist}"
    return cmd


def _emit_step(step_index: int, total_steps: int, label: str):
    print(f"__STEP__:{step_index}/{total_steps}:{label}", flush=True)


def _normalize_address_hex(value: str | None):
    text = str(value or "").strip()
    if text.lower().startswith("0x"):
        text = text[2:]
    normalized = "".join(ch for ch in text if ch.lower() in "0123456789abcdef").upper()
    if len(normalized) != 10:
        return DEFAULT_ADDRESS_HEX
    return normalized


def _parse_scan_address(value: str | None):
    normalized = _normalize_address_hex(value)
    return int(normalized, 16), normalized


def test_link(cflib_module, radio_driver_cls, address_hex: str | None):
    radio_status = "unknown"
    links = []
    scan_error = None
    scan_address, normalized_address = _parse_scan_address(address_hex)

    try:
        radio_status = radio_driver_cls().get_status()
    except Exception as exc:
        radio_status = f"error: {exc}"

    try:
        try:
            scanned = cflib_module.crtp.scan_interfaces(address=scan_address)
        except TypeError:
            scanned = cflib_module.crtp.scan_interfaces()
        links = [item[0] if isinstance(item, (list, tuple)) and len(item) > 0 else str(item) for item in scanned]
    except Exception as exc:
        scan_error = str(exc)

    return radio_status, links, scan_error, normalized_address


def run_flow(uri: str, commands, address_hex: str | None):
    import cflib.crtp
    from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
    from cflib.positioning.motion_commander import MotionCommander
    from cflib.crtp.radiodriver import RadioDriver

    cflib.crtp.init_drivers(enable_debug_driver=False)

    radio_status, links, scan_error, normalized_address = test_link(cflib, RadioDriver, address_hex)

    has_motion_cmd = any(cmd in ("takeoff", "move", "land") for cmd, _ in commands)
    flow_commands = [(cmd, arg) for cmd, arg in commands if cmd != "test_link"]
    total_steps = len(flow_commands)
    step_index = 0
    executed = []
    if not has_motion_cmd:
        for cmd, arg in commands:
            if cmd == "test_link":
                executed.append("test_link")
            elif cmd == "delay":
                step_index += 1
                _emit_step(step_index, total_steps, _step_label(cmd, arg))
                wait_sec = max(0.0, float(arg))
                executed.append(f"delay:{wait_sec}")
                time.sleep(wait_sec)
            elif cmd == "print":
                step_index += 1
                _emit_step(step_index, total_steps, _step_label(cmd, arg))
                msg = _normalize_print_value(arg)
                executed.append(f"print:{msg}")
                print(msg, flush=True)

        ok = len(links) > 0
        return {
            "success": ok or any(cmd in ("print", "delay") for cmd, _ in commands),
            "message": "Flow executed" if any(cmd in ("print", "delay") for cmd, _ in commands) else ("Link OK" if ok else "No Crazyflie link discovered"),
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": executed,
        }

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
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    executed.append("takeoff")
                    time.sleep(0.5)
                elif cmd == "move":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
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
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    wait_sec = max(0.0, float(arg))
                    executed.append(f"delay:{wait_sec}")
                    time.sleep(wait_sec)
                elif cmd == "print":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    msg = _normalize_print_value(arg)
                    executed.append(f"print:{msg}")
                    print(msg, flush=True)
                elif cmd == "land":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    executed.append("land")
                    break

    return {
        "success": True,
        "message": "Flow executed",
        "radioStatus": radio_status,
        "uri": uri,
        "addressHex": normalized_address,
        "links": links,
        "scanError": scan_error,
        "executed": executed,
    }


def main():
    parser = argparse.ArgumentParser(description="Run Crazyflie flow from generated Blockly code")
    parser.add_argument("--code-base64", required=True)
    parser.add_argument("--uri", default=DEFAULT_URI)
    parser.add_argument("--address-hex", default=DEFAULT_ADDRESS_HEX)
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

        result = run_flow(args.uri, commands, args.address_hex)
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
