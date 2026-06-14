#!/usr/bin/env python
# -*- coding: utf-8 -*-
import argparse
import base64
import json
import os
import re
import sys
import time
from threading import Event
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


def handle_range_measurement(range_value):
    if range_value is None:
        return 999.0
    try:
        return float(range_value)
    except Exception:
        return 999.0


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
    def parse_statement(line: str):
        m = re.match(r"^cf_set_link\s*\(\s*['\"](.*?)['\"]\s*,\s*['\"](.*?)['\"]\s*\)\s*;?$", line)
        if m:
            return ("set_link", {"uri": m.group(1), "address": m.group(2)})

        if re.match(r"^cf_crazyflie_link\s*\(\s*\)\s*;?$", line):
            return ("crazyflie_link", None)

        if re.match(r"^cf_test_crazyflie_link\s*\(\s*\)\s*;?$", line):
            return ("test_crazyflie_link", None)

        if re.match(r"^cf_test_link\s*\(\s*(?:['\"].*?['\"]\s*(?:,\s*['\"].*?['\"]\s*)?)?\)\s*;?$", line):
            return ("test_link", None)
        if re.match(r"^cf_detect_flow_v2\s*\(\s*\)\s*;?$", line):
            return ("detect_flow_v2", None)
        if re.match(r"^cf_detect_multiranger\s*\(\s*\)\s*;?$", line):
            return ("detect_multiranger", None)

        m = re.match(r"^cf_mr_log_distance\s*\(\s*['\"](front|back|left|right|up)['\"]\s*\)\s*;?$", line)
        if m:
            return ("mr_log_distance", {"dir": m.group(1)})

        if re.match(r"^cf_mr_log_all_distances\s*\(\s*\)\s*;?$", line):
            return ("mr_log_all_distances", None)

        if re.match(r"^cf_detect_led_ring\s*\(\s*\)\s*;?$", line):
            return ("detect_led_ring", None)

        m = re.match(r"^cf_led_ring_set_color\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)\s*;?$", line)
        if m:
            return ("led_ring_set_color", {"r": int(m.group(1)), "g": int(m.group(2)), "b": int(m.group(3))})

        m = re.match(r"^cf_led_ring_set_effect\s*\(\s*([0-9]+)\s*\)\s*;?$", line)
        if m:
            return ("led_ring_set_effect", int(m.group(1)))

        if re.match(r"^cf_led_ring_off\s*\(\s*\)\s*;?$", line):
            return ("led_ring_off", None)

        if re.match(r"^cf_detect_buzzer\s*\(\s*\)\s*;?$", line):
            return ("detect_buzzer", None)

        m = re.match(r"^cf_buzzer_beep\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*\)\s*;?$", line)
        if m:
            return ("buzzer_beep", {"duration": int(m.group(1)), "times": int(m.group(2))})

        if re.match(r"^cf_takeoff\s*\(\s*\)\s*;?$", line):
            return ("takeoff", None)
        if re.match(r"^cf_land\s*\(\s*\)\s*;?$", line):
            return ("land", None)

        m = re.match(r"^cf_motor_ramp_test\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\)\s*;?$", line)
        if m:
            return ("spin_motors", {
                "m1": int(m.group(1)),
                "m2": int(m.group(2)),
                "m3": int(m.group(3)),
                "m4": int(m.group(4)),
                "secs": float(m.group(5)),
            })

        m = re.match(r"^cf_spin_motors\s*\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]*\.?[0-9]+)\s*\)\s*;?$", line)
        if m:
            return ("spin_motors", {
                "m1": int(m.group(1)),
                "m2": int(m.group(2)),
                "m3": int(m.group(3)),
                "m4": int(m.group(4)),
                "secs": float(m.group(5)),
            })

        m = re.match(r"^cf_move\s*\(\s*['\"](forward|back|left|right|up|down)['\"]\s*(?:,\s*([0-9]*\.?[0-9]+)\s*)?\)\s*;?$", line)
        if m:
            distance = float(m.group(2)) if m.group(2) is not None else None
            return ("move", {"dir": m.group(1), "distance": distance})

        m = re.match(r"^cf_move_(forward|back|left|right|up|down)\s*\(\s*([0-9]*\.?[0-9]+)?\s*\)\s*;?$", line)
        if m:
            distance = float(m.group(2)) if m.group(2) is not None and m.group(2) != "" else None
            return ("move", {"dir": m.group(1), "distance": distance})

        m = re.match(r"^cf_delay\s*\(\s*([0-9]*\.?[0-9]+)\s*\)\s*;?$", line)
        if m:
            return ("delay", float(m.group(1)))

        m = re.match(r"^cf_print\s*\(\s*(.*?)\s*\)\s*;?$", line)
        if m:
            return ("print", m.group(1))

        return None

    def parse_comment_statement(stripped_line: str):
        comment = re.match(r"^(?://|#)\s*(.+)$", stripped_line)
        if not comment:
            return None
        candidate = comment.group(1).strip()
        if not candidate:
            return None
        return parse_statement(candidate)

    raw_lines = code.splitlines()

    def line_indent(text: str) -> int:
        expanded = text.replace("\t", "    ")
        return len(expanded) - len(expanded.lstrip(" "))

    def parse_block(start_index: int, base_indent: int):
        result = []
        i = start_index
        while i < len(raw_lines):
            raw = raw_lines[i]
            stripped = raw.strip()
            if not stripped:
                i += 1
                continue

            comment_cmd = parse_comment_statement(stripped)
            if comment_cmd is not None:
                result.append(comment_cmd)
                i += 1
                continue

            indent = line_indent(raw)
            if indent < base_indent:
                break
            if indent > base_indent:
                i += 1
                continue

            if_match = re.match(r"^if\s+cf_mr_has_obstacle\s*\(\s*['\"](front|back|left|right|up)['\"]\s*,\s*([0-9]*\.?[0-9]+)\s*\)\s*:\s*$", stripped)
            if if_match:
                direction = if_match.group(1)
                threshold = float(if_match.group(2))
                i += 1

                then_indent = None
                probe = i
                while probe < len(raw_lines):
                    probe_line = raw_lines[probe].strip()
                    if not probe_line or probe_line.startswith("//") or probe_line.startswith("#"):
                        probe += 1
                        continue
                    probe_indent = line_indent(raw_lines[probe])
                    if probe_indent > base_indent:
                        then_indent = probe_indent
                    break

                then_commands = []
                if then_indent is not None:
                    then_commands, i = parse_block(i, then_indent)

                else_commands = []
                while i < len(raw_lines):
                    look = raw_lines[i].strip()
                    if not look or look.startswith("//") or look.startswith("#"):
                        i += 1
                        continue
                    if line_indent(raw_lines[i]) == base_indent and re.match(r"^else\s*:\s*$", look):
                        i += 1
                        else_indent = None
                        probe = i
                        while probe < len(raw_lines):
                            probe_line = raw_lines[probe].strip()
                            if not probe_line or probe_line.startswith("//") or probe_line.startswith("#"):
                                probe += 1
                                continue
                            probe_indent = line_indent(raw_lines[probe])
                            if probe_indent > base_indent:
                                else_indent = probe_indent
                            break
                        if else_indent is not None:
                            else_commands, i = parse_block(i, else_indent)
                    break

                result.append(("if_mr_obstacle", {
                    "dir": direction,
                    "threshold": threshold,
                    "then": then_commands,
                    "else": else_commands,
                }))
                continue

            cmd = parse_statement(stripped)
            if cmd is not None:
                result.append(cmd)
            i += 1

        return result, i

    commands, _ = parse_block(0, 0)
    if commands:
        return commands

    # Fallback parser: extract cf_* calls from any text layout (including mixed comments).
    fallback_patterns = [
        r"cf_set_link\s*\(\s*['\"].*?['\"]\s*,\s*['\"].*?['\"]\s*\)",
        r"cf_crazyflie_link\s*\(\s*\)",
        r"cf_test_crazyflie_link\s*\(\s*\)",
        r"cf_test_link\s*\(\s*(?:['\"].*?['\"]\s*(?:,\s*['\"].*?['\"]\s*)?)?\)",
        r"cf_detect_flow_v2\s*\(\s*\)",
        r"cf_detect_multiranger\s*\(\s*\)",
        r"cf_detect_led_ring\s*\(\s*\)",
        r"cf_detect_buzzer\s*\(\s*\)",
        r"cf_led_ring_off\s*\(\s*\)",
        r"cf_mr_log_all_distances\s*\(\s*\)",
        r"cf_takeoff\s*\(\s*\)",
        r"cf_land\s*\(\s*\)",
        r"cf_mr_log_distance\s*\(\s*['\"](?:front|back|left|right|up)['\"]\s*\)",
        r"cf_led_ring_set_effect\s*\(\s*[0-9]+\s*\)",
        r"cf_led_ring_set_color\s*\(\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]+\s*\)",
        r"cf_buzzer_beep\s*\(\s*[0-9]+\s*,\s*[0-9]+\s*\)",
        r"cf_motor_ramp_test\s*\(\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]*\.?[0-9]+\s*\)",
        r"cf_spin_motors\s*\(\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]+\s*,\s*[0-9]*\.?[0-9]+\s*\)",
        r"cf_move\s*\(\s*['\"](?:forward|back|left|right|up|down)['\"]\s*(?:,\s*[0-9]*\.?[0-9]+\s*)?\)",
        r"cf_move_(?:forward|back|left|right|up|down)\s*\(\s*(?:[0-9]*\.?[0-9]+)?\s*\)",
        r"cf_delay\s*\(\s*[0-9]*\.?[0-9]+\s*\)",
        r"cf_print\s*\(\s*.*?\s*\)",
    ]

    all_matches = []
    for pattern in fallback_patterns:
        for m in re.finditer(pattern, code, flags=re.IGNORECASE | re.DOTALL):
            all_matches.append((m.start(), m.group(0)))

    all_matches.sort(key=lambda item: item[0])

    fallback_commands = []
    for _pos, raw_call in all_matches:
        stmt = re.sub(r"\s+", " ", raw_call).strip()
        cmd = parse_statement(stmt)
        if cmd is not None:
            fallback_commands.append(cmd)

    return fallback_commands


def _normalize_print_value(raw):
    text = str(raw).strip()
    if len(text) >= 2 and ((text[0] == "'" and text[-1] == "'") or (text[0] == '"' and text[-1] == '"')):
        try:
            return bytes(text[1:-1], "utf-8").decode("unicode_escape")
        except Exception:
            return text[1:-1]
    return text


def _step_label(cmd, arg):
    if cmd == "set_link":
        uri = str((arg or {}).get("uri", ""))
        address = str((arg or {}).get("address", ""))
        return f"set_link:{uri}:{address}"
    if cmd == "crazyflie_link":
        return "crazyflie_link"
    if cmd == "test_crazyflie_link":
        return "crazyflie_basic_test"
    if cmd == "test_link":
        return "test_link"
    if cmd == "takeoff":
        return "takeoff"
    if cmd == "land":
        return "land"
    if cmd == "spin_motors":
        m1 = int((arg or {}).get("m1", 0))
        m2 = int((arg or {}).get("m2", 0))
        m3 = int((arg or {}).get("m3", 0))
        m4 = int((arg or {}).get("m4", 0))
        secs = max(0.1, float((arg or {}).get("secs", 1.0)))
        return f"motor_ramp_test:{m1}:{m2}:{m3}:{m4}:{secs:.2f}"
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
    from cflib.utils.multiranger import Multiranger

    TEST_LINK_STEP_DWELL_SEC = 0.12

    def attach_link_watchdog(scf):
        state = {"error": None}

        def _on_link_issue(*args):
            parts = [str(part) for part in args if part is not None and str(part).strip()]
            text = " | ".join(parts) if parts else "unknown link error"
            state["error"] = text
            print(f"link_issue={text}", flush=True)

        for attr_name in ("disconnected_link_error", "connection_lost", "connection_failed", "disconnected"):
            target = getattr(scf.cf, attr_name, None)
            add_cb = getattr(target, "add_callback", None)
            if callable(add_cb):
                try:
                    add_cb(_on_link_issue)
                except Exception:
                    pass

        def ensure_link_ok():
            if state["error"]:
                raise RuntimeError(f"Crazyflie link unstable: {state['error']}")

        return ensure_link_ok

    def interruptible_sleep(seconds: float, ensure_link_ok):
        remain = max(0.0, float(seconds))
        if remain <= 0:
            ensure_link_ok()
            return
        end_ts = time.time() + remain
        while True:
            ensure_link_ok()
            now = time.time()
            if now >= end_ts:
                break
            time.sleep(min(0.05, end_ts - now))
        ensure_link_ok()

    def detect_flow_v2_deck(scf, timeout_sec: float = 5.0):
        detected = Event()
        raw_value = {"value": None}

        def _on_update(_name, value):
            raw_value["value"] = value
            try:
                normalized = str(value).strip().lower()
                if normalized in ("1", "true", "yes", "on"):
                    detected.set()
            except Exception:
                pass

        scf.cf.param.add_update_callback(group="deck", name="bcFlow2", cb=_on_update)
        # Give the callback subscription a short time window to receive updates.
        time.sleep(1.0)
        ok = detected.wait(timeout=max(0.1, float(timeout_sec)))
        return ok, raw_value["value"]

    def detect_multiranger_deck(scf, timeout_sec: float = 5.0):
        detected = Event()
        raw_value = {"value": None}

        def _on_update(_name, value):
            raw_value["value"] = value
            try:
                normalized = str(value).strip().lower()
                if normalized in ("1", "true", "yes", "on"):
                    detected.set()
            except Exception:
                pass

        scf.cf.param.add_update_callback(group="deck", name="bcMultiranger", cb=_on_update)
        time.sleep(1.0)
        ok = detected.wait(timeout=max(0.1, float(timeout_sec)))
        return ok, raw_value["value"]

    def read_multiranger_distances_once(scf):
        distances = {"front": None, "back": None, "left": None, "right": None, "up": None}
        with Multiranger(scf) as mr:
            time.sleep(0.12)
            distances["front"] = handle_range_measurement(getattr(mr, "front", None))
            distances["back"] = handle_range_measurement(getattr(mr, "back", None))
            distances["left"] = handle_range_measurement(getattr(mr, "left", None))
            distances["right"] = handle_range_measurement(getattr(mr, "right", None))
            distances["up"] = handle_range_measurement(getattr(mr, "up", None))
        return distances

    def contains_command(command_list, kinds):
        for cmd, arg in command_list:
            if cmd in kinds:
                return True
            if cmd == "if_mr_obstacle":
                then_commands = (arg or {}).get("then", [])
                else_commands = (arg or {}).get("else", [])
                if contains_command(then_commands, kinds) or contains_command(else_commands, kinds):
                    return True
        return False

    def estimate_total_steps(command_list):
        total = 0
        for cmd, arg in command_list:
            if cmd == "if_mr_obstacle":
                then_count = estimate_total_steps((arg or {}).get("then", []))
                else_count = estimate_total_steps((arg or {}).get("else", []))
                total += 1 + max(then_count, else_count)
            else:
                total += 1
        return total

    def detect_led_ring_deck(scf, timeout_sec: float = 5.0):
        detected = Event()
        values = {"top": None, "bot": None}

        def _on_top(_name, value):
            values["top"] = value
            if str(value).strip().lower() in ("1", "true", "yes", "on"):
                detected.set()

        def _on_bot(_name, value):
            values["bot"] = value
            if str(value).strip().lower() in ("1", "true", "yes", "on"):
                detected.set()

        scf.cf.param.add_update_callback(group="deck", name="bcColorLedTop", cb=_on_top)
        scf.cf.param.add_update_callback(group="deck", name="bcColorLedBot", cb=_on_bot)
        time.sleep(1.0)
        ok = detected.wait(timeout=max(0.1, float(timeout_sec)))
        return ok, values

    def set_led_ring_effect(scf, effect: int):
        scf.cf.param.set_value("ring.effect", str(int(effect)))

    def set_led_ring_color(scf, r: int, g: int, b: int):
        # Match common official examples: effect 7 with solid RGB params.
        scf.cf.param.set_value("ring.effect", "7")
        scf.cf.param.set_value("ring.solidRed", str(int(max(0, min(255, r)))))
        scf.cf.param.set_value("ring.solidGreen", str(int(max(0, min(255, g)))))
        scf.cf.param.set_value("ring.solidBlue", str(int(max(0, min(255, b)))))

    def detect_buzzer_deck(scf, timeout_sec: float = 3.0):
        detected = Event()
        raw_value = {"value": None}

        def _on_update(_name, value):
            raw_value["value"] = value
            if str(value).strip().lower() in ("1", "true", "yes", "on"):
                detected.set()

        try:
            scf.cf.param.add_update_callback(group="deck", name="bcBuzzer", cb=_on_update)
            time.sleep(0.8)
            ok = detected.wait(timeout=max(0.1, float(timeout_sec)))
            return ok, raw_value["value"]
        except Exception:
            return False, None

    def buzzer_beep(scf, duration_ms: int, times: int):
        # Firmware support differs; try common sound params, fallback to no-op log.
        success = False
        for _ in range(max(1, int(times))):
            try:
                scf.cf.param.set_value("sound.effect", "1")
                time.sleep(max(0.02, float(duration_ms) / 1000.0))
                scf.cf.param.set_value("sound.effect", "0")
                success = True
            except Exception:
                pass
            time.sleep(0.05)
        return success

    def spin_motors(scf, m1: int, m2: int, m3: int, m4: int, secs: float):
        # Use official ramp-test style setpoint control instead of direct per-motor params.
        start_thrust = max(1000, min(60000, int(m1)))
        end_thrust = max(1000, min(60000, int(m2)))
        step_thrust = max(50, min(5000, int(m3)))
        interval_sec = max(0.02, min(0.5, float(m4) / 1000.0))
        settle_sec = max(0.2, min(5.0, float(secs)))

        values = [start_thrust, end_thrust, step_thrust, int(interval_sec * 1000)]

        try:
            try:
                scf.cf.platform.send_arming_request(True)
                time.sleep(0.2)
            except Exception:
                pass

            thrust = start_thrust
            direction = 1 if end_thrust >= start_thrust else -1
            while (direction > 0 and thrust <= end_thrust) or (direction < 0 and thrust >= end_thrust):
                scf.cf.commander.send_setpoint(0.0, 0.0, 0.0, int(thrust))
                time.sleep(interval_sec)
                thrust += direction * step_thrust

            thrust -= direction * step_thrust
            while (direction > 0 and thrust >= start_thrust) or (direction < 0 and thrust <= start_thrust):
                scf.cf.commander.send_setpoint(0.0, 0.0, 0.0, int(thrust))
                time.sleep(interval_sec)
                thrust -= direction * step_thrust

            end_time = time.time() + settle_sec
            while time.time() < end_time:
                scf.cf.commander.send_setpoint(0.0, 0.0, 0.0, 0)
                time.sleep(0.05)

            return True, values, settle_sec, None
        except Exception as exc:
            return False, values, settle_sec, str(exc)

    cflib.crtp.init_drivers(enable_debug_driver=False)

    normalized_address = _normalize_address_hex(address_hex)
    radio_status = "unknown"
    links = []
    scan_error = None

    has_motion_cmd = contains_command(commands, {"takeoff", "move", "land"})
    has_flow_detect_cmd = contains_command(commands, {"detect_flow_v2"})
    has_mr_cmd = contains_command(commands, {"detect_multiranger", "mr_log_distance", "mr_log_all_distances", "if_mr_obstacle"})
    has_led_cmd = contains_command(commands, {"detect_led_ring", "led_ring_set_color", "led_ring_set_effect", "led_ring_off"})
    has_buzzer_cmd = contains_command(commands, {"detect_buzzer", "buzzer_beep"})
    has_motor_cmd = contains_command(commands, {"spin_motors"})
    has_test_link_cmd = contains_command(commands, {"test_link"})
    has_test_cf_link_cmd = contains_command(commands, {"test_crazyflie_link"})
    has_crazyflie_link_cmd = contains_command(commands, {"crazyflie_link"})

    requires_crazyflie_link_cmd = contains_command(commands, {
        "test_crazyflie_link",
        "takeoff", "move", "land",
        "detect_flow_v2",
        "detect_multiranger", "mr_log_distance", "mr_log_all_distances", "if_mr_obstacle",
        "detect_led_ring", "led_ring_set_color", "led_ring_set_effect", "led_ring_off",
        "detect_buzzer", "buzzer_beep",
        "spin_motors",
    })

    if requires_crazyflie_link_cmd and not has_crazyflie_link_cmd:
        return {
            "success": False,
            "message": "CRAZYFLIE_LINK_REQUIRED: Run 'Crazyflie link' block before Crazyflie operations",
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": [],
        }
    total_steps = estimate_total_steps(commands)
    step_index = 0
    executed = []
    active_uri = uri
    active_address = normalized_address
    link_gate_open = False

    def set_active_link(link_args):
        nonlocal active_uri, active_address
        # Keep URI normalization simple: empty means keep current.
        raw_uri = str((link_args or {}).get("uri", "")).strip()
        if raw_uri:
            active_uri = raw_uri
        raw_addr = str((link_args or {}).get("address", "")).strip()
        if raw_addr:
            active_address = _normalize_address_hex(raw_addr)

    # Pre-apply configured link so subsequent connection actions use latest URI/address.
    for cmd0, arg0 in commands:
        if cmd0 == "set_link":
            set_active_link(arg0)

    def radio_present(status_text):
        text = str(status_text or "").strip().lower()
        if not text:
            return False
        if text.startswith("error"):
            return False
        if "not found" in text:
            return False
        return True

    def run_propeller_test_like_cfclient(scf):
        # Match crazyflie-clients-python ConsoleTab propeller test trigger.
        try:
            scf.cf.param.set_value("health.startPropTest", "1")
            time.sleep(0.05)
            return True, None
        except Exception as exc:
            return False, str(exc)

    def refresh_radio_status_fast():
        nonlocal radio_status
        try:
            radio_status = RadioDriver().get_status()
        except Exception as exc:
            radio_status = f"error: {exc}"

    def strict_radio_test_or_raise():
        nonlocal scan_error
        refresh_radio_status_fast()
        scan_error = None
        if not radio_present(radio_status):
            raise RuntimeError(f"TEST_RADIO_FAILED: uri={active_uri}, address={active_address}, radioStatus={radio_status}, scanError={scan_error}")

    def strict_crazyflie_link_test_or_raise(existing_scf=None):
        nonlocal links, scan_error
        refresh_radio_status_fast()
        scan_error = None
        if not radio_present(radio_status):
            raise RuntimeError(f"TEST_RADIO_FAILED: uri={active_uri}, address={active_address}, radioStatus={radio_status}, scanError={scan_error}")

        if existing_scf is not None:
            ok, err = run_propeller_test_like_cfclient(existing_scf)
            links = [active_uri]
        else:
            try:
                with SyncCrazyflie(active_uri) as scf_tmp:
                    ok, err = run_propeller_test_like_cfclient(scf_tmp)
                links = [active_uri]
            except Exception as exc:
                ok, err = False, str(exc)
                links = []

        if not ok:
            raise RuntimeError(f"TEST_CRAZYFLIE_FAILED: uri={active_uri}, address={active_address}, error={err}")

    def strict_crazyflie_connect_or_raise(existing_scf=None):
        refresh_radio_status_fast()
        if not radio_present(radio_status):
            raise RuntimeError(f"CRAZYFLIE_LINK_FAILED: uri={active_uri}, address={active_address}, radioStatus={radio_status}")
        if existing_scf is not None:
            return
        with SyncCrazyflie(active_uri):
            pass

    def require_link_gate(cmd_name: str):
        if cmd_name in {
            "test_crazyflie_link",
            "takeoff", "move", "land",
            "detect_flow_v2",
            "detect_multiranger", "mr_log_distance", "mr_log_all_distances", "if_mr_obstacle",
            "detect_led_ring", "led_ring_set_color", "led_ring_set_effect", "led_ring_off",
            "detect_buzzer", "buzzer_beep",
            "spin_motors",
        } and not link_gate_open:
            raise RuntimeError(f"CRAZYFLIE_LINK_REQUIRED: Run 'Crazyflie link' block before {cmd_name}")

    if not has_motion_cmd and not has_flow_detect_cmd and not has_mr_cmd and not has_led_cmd and not has_buzzer_cmd and not has_motor_cmd:
        for cmd, arg in commands:
            if cmd == "set_link":
                step_index += 1
                _emit_step(step_index, total_steps, _step_label(cmd, arg))
                set_active_link(arg)
                executed.append(f"set_link:{active_uri}:{active_address}")
            elif cmd == "crazyflie_link":
                step_index += 1
                _emit_step(step_index, total_steps, _step_label(cmd, arg))
                strict_crazyflie_connect_or_raise()
                link_gate_open = True
                executed.append("crazyflie_link")
            elif cmd == "test_link":
                step_index += 1
                _emit_step(step_index, total_steps, _step_label(cmd, arg))
                strict_radio_test_or_raise()
                executed.append("test_link")
                time.sleep(TEST_LINK_STEP_DWELL_SEC)
            elif cmd == "test_crazyflie_link":
                require_link_gate("test_crazyflie_link")
                step_index += 1
                _emit_step(step_index, total_steps, _step_label(cmd, arg))
                strict_crazyflie_link_test_or_raise()
                executed.append("test_crazyflie_link")
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
            "success": ((ok and radio_present(radio_status)) if has_test_cf_link_cmd else ((radio_present(radio_status)) if has_test_link_cmd else (ok or any(cmd in ("print", "delay") for cmd, _ in commands)))),
            "message": "Flow executed" if (not has_test_link_cmd and any(cmd in ("print", "delay") for cmd, _ in commands)) else ("Link OK" if ok else "No Crazyflie link discovered"),
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": executed,
        }

    if not has_motion_cmd and has_motor_cmd and not has_flow_detect_cmd and not has_mr_cmd and not has_led_cmd and not has_buzzer_cmd:
        overall_success = True
        with SyncCrazyflie(active_uri) as scf:
            for cmd, arg in commands:
                if cmd == "set_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    set_active_link(arg)
                    executed.append(f"set_link:{active_uri}:{active_address}")
                elif cmd == "crazyflie_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_connect_or_raise(scf)
                    link_gate_open = True
                    executed.append("crazyflie_link")
                elif cmd == "test_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_radio_test_or_raise()
                    executed.append("test_link")
                    time.sleep(TEST_LINK_STEP_DWELL_SEC)
                elif cmd == "test_crazyflie_link":
                    require_link_gate("test_crazyflie_link")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_link_test_or_raise(scf)
                    executed.append("test_crazyflie_link")
                elif cmd == "spin_motors":
                    require_link_gate("spin_motors")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    m1 = int((arg or {}).get("m1", 0))
                    m2 = int((arg or {}).get("m2", 0))
                    m3 = int((arg or {}).get("m3", 0))
                    m4 = int((arg or {}).get("m4", 0))
                    secs = float((arg or {}).get("secs", 1.0))
                    ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                    overall_success = overall_success and ok
                    executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                    if err:
                        print(f"spin_motors_error={err}", flush=True)
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

        return {
            "success": overall_success,
            "message": "Motor command executed" if overall_success else "Motor command failed",
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": executed,
        }

    if not has_motion_cmd and (has_led_cmd or has_buzzer_cmd):
        overall_success = True
        with SyncCrazyflie(active_uri) as scf:
            for cmd, arg in commands:
                if cmd == "set_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    set_active_link(arg)
                    executed.append(f"set_link:{active_uri}:{active_address}")
                elif cmd == "crazyflie_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_connect_or_raise(scf)
                    link_gate_open = True
                    executed.append("crazyflie_link")
                elif cmd == "test_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_radio_test_or_raise()
                    executed.append("test_link")
                    time.sleep(TEST_LINK_STEP_DWELL_SEC)
                elif cmd == "test_crazyflie_link":
                    require_link_gate("test_crazyflie_link")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_link_test_or_raise(scf)
                    executed.append("test_crazyflie_link")
                elif cmd == "detect_led_ring":
                    require_link_gate("detect_led_ring")
                    step_index += 1
                    _emit_step(step_index, total_steps, "detect_led_ring")
                    ok, raw = detect_led_ring_deck(scf)
                    overall_success = overall_success and ok
                    executed.append(f"detect_led_ring:{'1' if ok else '0'}")
                    print(f"led_ring_detected={ok}, raw={raw}", flush=True)
                elif cmd == "led_ring_set_color":
                    require_link_gate("led_ring_set_color")
                    step_index += 1
                    _emit_step(step_index, total_steps, "led_ring_set_color")
                    r = int((arg or {}).get("r", 255))
                    g = int((arg or {}).get("g", 0))
                    b = int((arg or {}).get("b", 0))
                    set_led_ring_color(scf, r, g, b)
                    executed.append(f"led_ring_set_color:{r}:{g}:{b}")
                elif cmd == "led_ring_set_effect":
                    require_link_gate("led_ring_set_effect")
                    step_index += 1
                    _emit_step(step_index, total_steps, "led_ring_set_effect")
                    effect = int(arg or 0)
                    set_led_ring_effect(scf, effect)
                    executed.append(f"led_ring_set_effect:{effect}")
                elif cmd == "led_ring_off":
                    require_link_gate("led_ring_off")
                    step_index += 1
                    _emit_step(step_index, total_steps, "led_ring_off")
                    set_led_ring_effect(scf, 0)
                    executed.append("led_ring_off")
                elif cmd == "detect_buzzer":
                    require_link_gate("detect_buzzer")
                    step_index += 1
                    _emit_step(step_index, total_steps, "detect_buzzer")
                    ok, raw = detect_buzzer_deck(scf)
                    overall_success = overall_success and ok
                    executed.append(f"detect_buzzer:{'1' if ok else '0'}")
                    print(f"buzzer_detected={ok}, raw={raw}", flush=True)
                elif cmd == "buzzer_beep":
                    require_link_gate("buzzer_beep")
                    step_index += 1
                    _emit_step(step_index, total_steps, "buzzer_beep")
                    duration = int((arg or {}).get("duration", 120))
                    times = int((arg or {}).get("times", 1))
                    ok = buzzer_beep(scf, duration, times)
                    executed.append(f"buzzer_beep:{duration}:{times}:{'1' if ok else '0'}")
                    print(f"buzzer_beep_ok={ok}", flush=True)
                elif cmd == "spin_motors":
                    require_link_gate("spin_motors")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    m1 = int((arg or {}).get("m1", 0))
                    m2 = int((arg or {}).get("m2", 0))
                    m3 = int((arg or {}).get("m3", 0))
                    m4 = int((arg or {}).get("m4", 0))
                    secs = float((arg or {}).get("secs", 1.0))
                    ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                    overall_success = overall_success and ok
                    executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                    if err:
                        print(f"spin_motors_error={err}", flush=True)
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
                elif cmd == "if_mr_obstacle":
                    require_link_gate("if_mr_obstacle")
                    direction = (arg or {}).get("dir", "front")
                    threshold = float((arg or {}).get("threshold", 0.3))
                    step_index += 1
                    _emit_step(step_index, total_steps, f"if_mr_obstacle:{direction}:{threshold}")
                    distances = read_multiranger_distances_once(scf)
                    distance = handle_range_measurement(distances.get(direction))
                    hit = float(distance) < float(threshold)
                    executed.append(f"if_mr_obstacle:{direction}:{distance:.3f}:{threshold:.3f}:{'1' if hit else '0'}")
                    print(f"if_mr_obstacle dir={direction} dist={distance:.3f} threshold={threshold:.3f} result={hit}", flush=True)
                    branch = (arg or {}).get("then", []) if hit else (arg or {}).get("else", [])
                    for child_cmd, child_arg in branch:
                        if child_cmd == "delay":
                            step_index += 1
                            _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                            wait_sec = max(0.0, float(child_arg))
                            executed.append(f"delay:{wait_sec}")
                            time.sleep(wait_sec)
                        elif child_cmd == "print":
                            step_index += 1
                            _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                            msg = _normalize_print_value(child_arg)
                            executed.append(f"print:{msg}")
                            print(msg, flush=True)
                        elif child_cmd == "led_ring_set_color":
                            step_index += 1
                            _emit_step(step_index, total_steps, "led_ring_set_color")
                            r = int((child_arg or {}).get("r", 255))
                            g = int((child_arg or {}).get("g", 0))
                            b = int((child_arg or {}).get("b", 0))
                            set_led_ring_color(scf, r, g, b)
                            executed.append(f"led_ring_set_color:{r}:{g}:{b}")
                        elif child_cmd == "led_ring_set_effect":
                            step_index += 1
                            _emit_step(step_index, total_steps, "led_ring_set_effect")
                            effect = int(child_arg or 0)
                            set_led_ring_effect(scf, effect)
                            executed.append(f"led_ring_set_effect:{effect}")
                        elif child_cmd == "led_ring_off":
                            step_index += 1
                            _emit_step(step_index, total_steps, "led_ring_off")
                            set_led_ring_effect(scf, 0)
                            executed.append("led_ring_off")
                        elif child_cmd == "buzzer_beep":
                            step_index += 1
                            _emit_step(step_index, total_steps, "buzzer_beep")
                            duration = int((child_arg or {}).get("duration", 120))
                            times = int((child_arg or {}).get("times", 1))
                            ok = buzzer_beep(scf, duration, times)
                            executed.append(f"buzzer_beep:{duration}:{times}:{'1' if ok else '0'}")
                            print(f"buzzer_beep_ok={ok}", flush=True)
                        elif child_cmd == "spin_motors":
                            step_index += 1
                            _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                            m1 = int((child_arg or {}).get("m1", 0))
                            m2 = int((child_arg or {}).get("m2", 0))
                            m3 = int((child_arg or {}).get("m3", 0))
                            m4 = int((child_arg or {}).get("m4", 0))
                            secs = float((child_arg or {}).get("secs", 1.0))
                            ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                            overall_success = overall_success and ok
                            executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                            if err:
                                print(f"spin_motors_error={err}", flush=True)

        return {
            "success": overall_success,
            "message": "LED/Buzzer commands executed" if overall_success else "Some LED/Buzzer commands failed",
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": executed,
        }

    if not has_motion_cmd and has_mr_cmd:
        detected_all = True
        with SyncCrazyflie(active_uri) as scf:
            for cmd, arg in commands:
                if cmd == "set_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    set_active_link(arg)
                    executed.append(f"set_link:{active_uri}:{active_address}")
                elif cmd == "crazyflie_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_connect_or_raise(scf)
                    link_gate_open = True
                    executed.append("crazyflie_link")
                elif cmd == "test_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_radio_test_or_raise()
                    executed.append("test_link")
                    time.sleep(TEST_LINK_STEP_DWELL_SEC)
                elif cmd == "test_crazyflie_link":
                    require_link_gate("test_crazyflie_link")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_link_test_or_raise(scf)
                    executed.append("test_crazyflie_link")
                elif cmd == "detect_multiranger":
                    require_link_gate("detect_multiranger")
                    step_index += 1
                    _emit_step(step_index, total_steps, "detect_multiranger")
                    ok, raw = detect_multiranger_deck(scf)
                    detected_all = detected_all and ok
                    executed.append(f"detect_multiranger:{'1' if ok else '0'}")
                    print(f"multiranger_detected={ok}, raw={raw}", flush=True)
                elif cmd == "mr_log_distance":
                    require_link_gate("mr_log_distance")
                    direction = (arg or {}).get("dir", "front")
                    step_index += 1
                    _emit_step(step_index, total_steps, f"mr_log_distance:{direction}")
                    distances = read_multiranger_distances_once(scf)
                    value = distances.get(direction)
                    text = f"{float(handle_range_measurement(value)):.3f}"
                    executed.append(f"mr_log_distance:{direction}:{text}")
                    print(f"mr_{direction}={text}", flush=True)
                elif cmd == "mr_log_all_distances":
                    require_link_gate("mr_log_all_distances")
                    step_index += 1
                    _emit_step(step_index, total_steps, "mr_log_all_distances")
                    distances = read_multiranger_distances_once(scf)
                    pieces = []
                    for key in ("front", "back", "left", "right", "up"):
                        value = handle_range_measurement(distances.get(key))
                        pieces.append(f"{key}={float(value):.3f}")
                    line = ",".join(pieces)
                    executed.append(f"mr_log_all_distances:{line}")
                    print(line, flush=True)
                elif cmd == "spin_motors":
                    require_link_gate("spin_motors")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    m1 = int((arg or {}).get("m1", 0))
                    m2 = int((arg or {}).get("m2", 0))
                    m3 = int((arg or {}).get("m3", 0))
                    m4 = int((arg or {}).get("m4", 0))
                    secs = float((arg or {}).get("secs", 1.0))
                    ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                    detected_all = detected_all and ok
                    executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                    if err:
                        print(f"spin_motors_error={err}", flush=True)
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
                elif cmd == "if_mr_obstacle":
                    require_link_gate("if_mr_obstacle")
                    direction = (arg or {}).get("dir", "front")
                    threshold = float((arg or {}).get("threshold", 0.3))
                    step_index += 1
                    _emit_step(step_index, total_steps, f"if_mr_obstacle:{direction}:{threshold}")
                    distances = read_multiranger_distances_once(scf)
                    distance = handle_range_measurement(distances.get(direction))
                    hit = float(distance) < float(threshold)
                    executed.append(f"if_mr_obstacle:{direction}:{distance:.3f}:{threshold:.3f}:{'1' if hit else '0'}")
                    print(f"if_mr_obstacle dir={direction} dist={distance:.3f} threshold={threshold:.3f} result={hit}", flush=True)
                    branch = (arg or {}).get("then", []) if hit else (arg or {}).get("else", [])
                    for child_cmd, child_arg in branch:
                        if child_cmd == "mr_log_distance":
                            child_direction = (child_arg or {}).get("dir", "front")
                            step_index += 1
                            _emit_step(step_index, total_steps, f"mr_log_distance:{child_direction}")
                            child_distances = read_multiranger_distances_once(scf)
                            value = child_distances.get(child_direction)
                            text = f"{float(handle_range_measurement(value)):.3f}"
                            executed.append(f"mr_log_distance:{child_direction}:{text}")
                            print(f"mr_{child_direction}={text}", flush=True)
                        elif child_cmd == "mr_log_all_distances":
                            step_index += 1
                            _emit_step(step_index, total_steps, "mr_log_all_distances")
                            child_distances = read_multiranger_distances_once(scf)
                            child_pieces = []
                            for key in ("front", "back", "left", "right", "up"):
                                value = handle_range_measurement(child_distances.get(key))
                                child_pieces.append(f"{key}={float(value):.3f}")
                            child_line = ",".join(child_pieces)
                            executed.append(f"mr_log_all_distances:{child_line}")
                            print(child_line, flush=True)
                        elif child_cmd == "delay":
                            step_index += 1
                            _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                            wait_sec = max(0.0, float(child_arg))
                            executed.append(f"delay:{wait_sec}")
                            time.sleep(wait_sec)
                        elif child_cmd == "print":
                            step_index += 1
                            _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                            msg = _normalize_print_value(child_arg)
                            executed.append(f"print:{msg}")
                            print(msg, flush=True)
                        elif child_cmd == "spin_motors":
                            step_index += 1
                            _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                            m1 = int((child_arg or {}).get("m1", 0))
                            m2 = int((child_arg or {}).get("m2", 0))
                            m3 = int((child_arg or {}).get("m3", 0))
                            m4 = int((child_arg or {}).get("m4", 0))
                            secs = float((child_arg or {}).get("secs", 1.0))
                            ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                            detected_all = detected_all and ok
                            executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                            if err:
                                print(f"spin_motors_error={err}", flush=True)

        return {
            "success": detected_all,
            "message": "Multiranger detected" if detected_all else "Multiranger not detected",
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": executed,
        }

    if not has_motion_cmd and has_flow_detect_cmd:
        detected_all = True
        with SyncCrazyflie(active_uri) as scf:
            for cmd, arg in commands:
                if cmd == "set_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    set_active_link(arg)
                    executed.append(f"set_link:{active_uri}:{active_address}")
                elif cmd == "crazyflie_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_connect_or_raise(scf)
                    link_gate_open = True
                    executed.append("crazyflie_link")
                elif cmd == "test_link":
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_radio_test_or_raise()
                    executed.append("test_link")
                    time.sleep(TEST_LINK_STEP_DWELL_SEC)
                elif cmd == "test_crazyflie_link":
                    require_link_gate("test_crazyflie_link")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    strict_crazyflie_link_test_or_raise(scf)
                    executed.append("test_crazyflie_link")
                elif cmd == "detect_flow_v2":
                    require_link_gate("detect_flow_v2")
                    step_index += 1
                    _emit_step(step_index, total_steps, "detect_flow_v2")
                    ok, raw = detect_flow_v2_deck(scf)
                    detected_all = detected_all and ok
                    executed.append(f"detect_flow_v2:{'1' if ok else '0'}")
                    print(f"flow_v2_detected={ok}, raw={raw}", flush=True)
                elif cmd == "spin_motors":
                    require_link_gate("spin_motors")
                    step_index += 1
                    _emit_step(step_index, total_steps, _step_label(cmd, arg))
                    m1 = int((arg or {}).get("m1", 0))
                    m2 = int((arg or {}).get("m2", 0))
                    m3 = int((arg or {}).get("m3", 0))
                    m4 = int((arg or {}).get("m4", 0))
                    secs = float((arg or {}).get("secs", 1.0))
                    ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                    detected_all = detected_all and ok
                    executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                    if err:
                        print(f"spin_motors_error={err}", flush=True)
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

        return {
            "success": detected_all,
            "message": "Flow deck v2 detected" if detected_all else "Flow deck v2 not detected",
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": executed,
        }

    try:
        with SyncCrazyflie(active_uri) as scf:
            ensure_link_ok = attach_link_watchdog(scf)
            ensure_link_ok()

            scf.cf.platform.send_arming_request(True)
            interruptible_sleep(1.0, ensure_link_ok)

            with MotionCommander(scf) as mc:
                # MotionCommander enters hover/takeoff context automatically.
                interruptible_sleep(1.0, ensure_link_ok)
                for cmd, arg in commands:
                    ensure_link_ok()
                    if cmd == "set_link":
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        set_active_link(arg)
                        executed.append(f"set_link:{active_uri}:{active_address}")
                    elif cmd == "crazyflie_link":
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        strict_crazyflie_connect_or_raise(scf)
                        link_gate_open = True
                        executed.append("crazyflie_link")
                    elif cmd == "test_link":
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        strict_radio_test_or_raise()
                        executed.append("test_link")
                        interruptible_sleep(TEST_LINK_STEP_DWELL_SEC, ensure_link_ok)
                    elif cmd == "test_crazyflie_link":
                        require_link_gate("test_crazyflie_link")
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        strict_crazyflie_link_test_or_raise(scf)
                        executed.append("test_crazyflie_link")
                    elif cmd == "takeoff":
                        require_link_gate("takeoff")
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        executed.append("takeoff")
                        interruptible_sleep(0.5, ensure_link_ok)
                    elif cmd == "move":
                        require_link_gate("move")
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
                        interruptible_sleep(0.6, ensure_link_ok)
                    elif cmd == "delay":
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        wait_sec = max(0.0, float(arg))
                        executed.append(f"delay:{wait_sec}")
                        interruptible_sleep(wait_sec, ensure_link_ok)
                    elif cmd == "print":
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        msg = _normalize_print_value(arg)
                        executed.append(f"print:{msg}")
                        print(msg, flush=True)
                    elif cmd == "land":
                        require_link_gate("land")
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        executed.append("land")
                        break
                    elif cmd == "spin_motors":
                        require_link_gate("spin_motors")
                        step_index += 1
                        _emit_step(step_index, total_steps, _step_label(cmd, arg))
                        m1 = int((arg or {}).get("m1", 0))
                        m2 = int((arg or {}).get("m2", 0))
                        m3 = int((arg or {}).get("m3", 0))
                        m4 = int((arg or {}).get("m4", 0))
                        secs = float((arg or {}).get("secs", 1.0))
                        ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                        executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                        if err:
                            print(f"spin_motors_error={err}", flush=True)
                    elif cmd == "if_mr_obstacle":
                        require_link_gate("if_mr_obstacle")
                        step_index += 1
                        direction = (arg or {}).get("dir", "front")
                        threshold = float((arg or {}).get("threshold", 0.3))
                        _emit_step(step_index, total_steps, f"if_mr_obstacle:{direction}:{threshold}")
                        distances = read_multiranger_distances_once(scf)
                        distance = handle_range_measurement(distances.get(direction))
                        hit = float(distance) < float(threshold)
                        executed.append(f"if_mr_obstacle:{direction}:{distance:.3f}:{threshold:.3f}:{'1' if hit else '0'}")
                        print(f"if_mr_obstacle dir={direction} dist={distance:.3f} threshold={threshold:.3f} result={hit}", flush=True)
                        branch = (arg or {}).get("then", []) if hit else (arg or {}).get("else", [])
                        for child_cmd, child_arg in branch:
                            if child_cmd == "move":
                                require_link_gate("move")
                                step_index += 1
                                _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                                child_direction = child_arg.get("dir") if isinstance(child_arg, dict) else None
                                fallback_dist = MOVE_DISTANCE.get(child_direction, 0.2)
                                child_dist = child_arg.get("distance") if isinstance(child_arg, dict) else None
                                if child_dist is None:
                                    child_dist = fallback_dist
                                child_dist = max(0.01, float(child_dist))
                                if child_direction == "forward":
                                    mc.forward(child_dist)
                                elif child_direction == "back":
                                    mc.back(child_dist)
                                elif child_direction == "left":
                                    mc.left(child_dist)
                                elif child_direction == "right":
                                    mc.right(child_dist)
                                elif child_direction == "up":
                                    mc.up(child_dist)
                                elif child_direction == "down":
                                    mc.down(child_dist)
                                executed.append(f"move:{child_direction}:{child_dist}")
                                interruptible_sleep(0.6, ensure_link_ok)
                            elif child_cmd == "delay":
                                step_index += 1
                                _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                                wait_sec = max(0.0, float(child_arg))
                                executed.append(f"delay:{wait_sec}")
                                interruptible_sleep(wait_sec, ensure_link_ok)
                            elif child_cmd == "print":
                                step_index += 1
                                _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                                msg = _normalize_print_value(child_arg)
                                executed.append(f"print:{msg}")
                                print(msg, flush=True)
                            elif child_cmd == "spin_motors":
                                require_link_gate("spin_motors")
                                step_index += 1
                                _emit_step(step_index, total_steps, _step_label(child_cmd, child_arg))
                                m1 = int((child_arg or {}).get("m1", 0))
                                m2 = int((child_arg or {}).get("m2", 0))
                                m3 = int((child_arg or {}).get("m3", 0))
                                m4 = int((child_arg or {}).get("m4", 0))
                                secs = float((child_arg or {}).get("secs", 1.0))
                                ok, values, duration, err = spin_motors(scf, m1, m2, m3, m4, secs)
                                executed.append(f"spin_motors:{values[0]}:{values[1]}:{values[2]}:{values[3]}:{duration:.2f}:{'1' if ok else '0'}")
                                if err:
                                    print(f"spin_motors_error={err}", flush=True)
                    elif cmd == "led_ring_set_color":
                        require_link_gate("led_ring_set_color")
                        r = int((arg or {}).get("r", 255))
                        g = int((arg or {}).get("g", 0))
                        b = int((arg or {}).get("b", 0))
                        set_led_ring_color(scf, r, g, b)
                        executed.append(f"led_ring_set_color:{r}:{g}:{b}")
                    elif cmd == "led_ring_set_effect":
                        require_link_gate("led_ring_set_effect")
                        effect = int(arg or 0)
                        set_led_ring_effect(scf, effect)
                        executed.append(f"led_ring_set_effect:{effect}")
                    elif cmd == "led_ring_off":
                        require_link_gate("led_ring_off")
                        set_led_ring_effect(scf, 0)
                        executed.append("led_ring_off")
                    elif cmd == "buzzer_beep":
                        require_link_gate("buzzer_beep")
                        duration = int((arg or {}).get("duration", 120))
                        times = int((arg or {}).get("times", 1))
                        ok = buzzer_beep(scf, duration, times)
                        executed.append(f"buzzer_beep:{duration}:{times}:{'1' if ok else '0'}")
                        ensure_link_ok()
    except Exception as exc:
        message = str(exc)
        if "Crazyflie link unstable:" in message and not message.startswith("LINK_ABORTED:"):
            message = f"LINK_ABORTED: {message}"
        return {
            "success": False,
            "message": message,
            "radioStatus": radio_status,
            "uri": uri,
            "addressHex": normalized_address,
            "links": links,
            "scanError": scan_error,
            "executed": executed,
        }

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
