#!/usr/bin/env python
# -*- coding: utf-8 -*-
import argparse
import json
import os
import sys
from pathlib import Path


def _candidate_lib_paths(explicit_path: str | None):
    candidates = []
    if explicit_path:
        candidates.append(Path(explicit_path))

    env_path = os.environ.get("CRAZYFLIE_LIB_PATH")
    if env_path:
        candidates.append(Path(env_path))

    # Workspace layout: <root>/aily-blockly/child/scripts/this.py and <root>/crazyflie/crazyflie-lib-python-master
    script_path = Path(__file__).resolve()
    workspace_root = script_path.parents[3] if len(script_path.parents) >= 4 else None
    if workspace_root:
        candidates.append(workspace_root / "crazyflie" / "crazyflie-lib-python-master")

    cwd = Path.cwd()
    candidates.append(cwd.parent / "crazyflie" / "crazyflie-lib-python-master")

    # De-dup while preserving order
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


def main():
    parser = argparse.ArgumentParser(description="Crazyradio/Crazyflie link test")
    parser.add_argument("--lib-path", default=None, help="Path to crazyflie-lib-python root")
    parser.add_argument("--timeout-ms", default=4000, type=int, help="Reserved for future use")
    args = parser.parse_args()

    loaded_from = _append_cflib_path(args.lib_path)
    if not loaded_from:
        print(json.dumps({
            "success": False,
            "message": "Cannot locate crazyflie-lib-python (cflib)",
            "loadedFrom": None,
            "radioStatus": "unknown",
            "links": [],
        }, ensure_ascii=False))
        return 1

    try:
        import cflib.crtp
        from cflib.crtp.radiodriver import RadioDriver

        cflib.crtp.init_drivers()

        radio_status = "unknown"
        links = []
        scan_error = None

        try:
            radio_status = RadioDriver().get_status()
        except Exception as e:
            radio_status = f"error: {e}"

        try:
            scanned = cflib.crtp.scan_interfaces()
            links = [item[0] if isinstance(item, (list, tuple)) and len(item) > 0 else str(item) for item in scanned]
        except Exception as e:
            scan_error = str(e)
            links = []

        success = len(links) > 0
        if success:
            message = f"Link OK, found {len(links)} Crazyflie URI(s)"
        else:
            if "not found" in str(radio_status).lower():
                message = "Crazyradio not found"
            elif scan_error:
                message = f"Scan failed: {scan_error}"
            else:
                message = "Crazyradio detected, but no Crazyflie link discovered"

        print(json.dumps({
            "success": success,
            "message": message,
            "loadedFrom": loaded_from,
            "radioStatus": radio_status,
            "links": links,
            "scanError": scan_error,
        }, ensure_ascii=False))
        return 0 if success else 2
    except Exception as e:
        print(json.dumps({
            "success": False,
            "message": str(e),
            "loadedFrom": loaded_from,
            "radioStatus": "error",
            "links": [],
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
