#!/usr/bin/env python
import argparse
import json
import math
import queue
import sys
import time
from contextlib import contextmanager, nullcontext, redirect_stdout
from threading import Event, Lock, Thread, get_ident

from crazyflie_run_flow import _append_cflib_path, parse_commands, run_flow


@contextmanager
def connection_telemetry(scf, log_config_class, emit, failed):
    config = log_config_class("AilyConnection", 500)
    config.add_variable("pm.vbat", "float")
    readiness_name, readiness_source = None, "unavailable"
    toc = getattr(scf.cf.log, "toc", None)
    if toc is not None:
        for name, source, variable_type in [
            ("supervisor.info", "supervisor", "uint16_t"),
            ("sys.canfly", "legacy", "uint8_t"),
        ]:
            if toc.get_element_by_complete_name(name) is not None:
                readiness_name, readiness_source = name, source
                config.add_variable(name, variable_type)
                break
    ready = Event()
    latest = {"batteryPercent": None, "batteryVolts": None, "linkQuality": None}
    received = {"battery": time.monotonic(), "quality": 0.0}
    lock = Lock()

    def on_battery(_timestamp, data, _config):
        volts = data.get("pm.vbat")
        if type(volts) not in (int, float) or not math.isfinite(volts) or not 0 < volts <= 6:
            failed("Invalid battery telemetry")
            ready.set()
            return
        with lock:
            received["battery"] = time.monotonic()
            latest["batteryVolts"] = round(volts, 3)
            latest["batteryPercent"] = max(0, min(100, round((volts - 3.4) / 0.8 * 100)))
            if time.monotonic() - received["quality"] > 3:
                latest["linkQuality"] = None
            readiness = {"source": readiness_source, "value": data.get(readiness_name)}
            if readiness_name is not None:
                value = readiness["value"]
                maximum = 0xffff if readiness_source == "supervisor" else 1
                if type(value) is not int or not 0 <= value <= maximum:
                    readiness = {"source": "invalid", "value": None}
            emit({"type": "telemetry", "payload": {**latest, "flightReadiness": readiness}})
        ready.set()

    def on_quality(value):
        if type(value) not in (int, float) or not math.isfinite(value):
            failed("Invalid link quality telemetry")
            return
        with lock:
            received["quality"] = time.monotonic()
            latest["linkQuality"] = max(0, min(100, round(value)))
            if time.monotonic() - received["battery"] <= 3:
                emit({"type": "telemetry", "payload": dict(latest)})

    def on_error(_config, message):
        failed(f"Battery logging failed: {message}")
        ready.set()

    def on_disconnect(*args):
        failed(f"Crazyflie disconnected: {args}")
        ready.set()

    callbacks = [
        (config.data_received_cb, on_battery),
        (config.error_cb, on_error),
        (scf.cf.link_statistics.link_quality_updated, on_quality),
        (scf.cf.disconnected, on_disconnect),
        (scf.cf.connection_lost, on_disconnect),
    ]
    scf.cf.log.add_config(config)
    for callback, handler in callbacks:
        callback.add_callback(handler)
    watching = Event()
    def watch():
        while not watching.wait(0.2):
            if time.monotonic() - received["battery"] > 3:
                failed("Battery telemetry is stale; connection cannot be verified")
                return
    watchdog = Thread(target=watch, daemon=True)
    try:
        config.start()
        watchdog.start()
        if not ready.wait(3):
            raise TimeoutError("No battery telemetry received after connecting")

        def healthy():
            if time.monotonic() - received["battery"] > 3:
                raise TimeoutError("Battery telemetry is stale; connection cannot be verified")
        yield healthy
    finally:
        watching.set()
        if watchdog.is_alive():
            watchdog.join()
        try:
            try:
                config.stop()
            finally:
                config.delete()
        finally:
            for callback, handler in callbacks:
                callback.remove_callback(handler)


def serve(uri, address, emit, requests, stop, shutdown, mapping_requests=None):
    import cflib.crtp
    from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
    from cflib.crazyflie.log import LogConfig
    from crazyflie_attitude import attitude_logging
    from crazyflie_mapping import mapping_control

    errors = []

    def failed(message):
        if not errors:
            errors.append(message)
            emit({"type": "state", "state": "error", "message": message})
        stop.set()
        shutdown.set()

    def healthy():
        if errors:
            raise RuntimeError(errors[0])

    if shutdown.is_set():
        return
    cflib.crtp.init_drivers()
    with SyncCrazyflie(uri) as scf:
        if shutdown.is_set():
            return
        with connection_telemetry(scf, LogConfig, emit, failed) as telemetry_healthy, (
            mapping_control(scf, LogConfig, emit, mapping_requests, shutdown)
            if mapping_requests is not None else nullcontext()
        ):
            healthy()
            if shutdown.is_set():
                return
            observer = None
            observe = True

            def start_observer():
                context = attitude_logging(scf, lambda payload: emit({"type": "attitude", "payload": payload}))
                context.__enter__()
                return context

            def stop_observer():
                nonlocal observer
                context, observer = observer, None
                if context:
                    context.__exit__(None, None, None)

            def resume_observer():
                nonlocal observer
                try:
                    observer = start_observer()
                except Exception as error:
                    emit({"type": "attitude", "payload": {"type": "error", "message": str(error)}})

            try:
                resume_observer()
                emit({"type": "state", "state": "ready", "uri": uri, "addressHex": address})
                while not shutdown.is_set():
                    healthy()
                    telemetry_healthy()
                    try:
                        request = requests.get(timeout=0.1)
                    except queue.Empty:
                        continue
                    request_id = request["id"]
                    action = request["action"]
                    try:
                        if action == "observe":
                            observe = request.get("enabled") is True
                            stop_observer()
                            if observe:
                                observer = start_observer()
                            result = {"success": True}
                        elif action == "run":
                            stop_observer()
                            commands = parse_commands(request.get("code", ""))
                            if not commands:
                                raise ValueError("No Crazyflie commands found")
                            for command, args in commands:
                                if command == "scan_links":
                                    raise ValueError("Disconnect the aircraft before scanning the wireless transceiver")
                                if command == "set_link" and (args["uri"] != uri or args["address"].upper() != address):
                                    raise ValueError("Connection settings changed; disconnect before selecting another aircraft")
                            emit({"type": "state", "state": "flow", "uri": uri, "addressHex": address})
                            result = run_flow(uri, commands, address, attitude=True,
                                              follow_position=request.get("followPosition") is True,
                                              stop_requested=stop, connection=scf)
                            healthy()
                            telemetry_healthy()
                        else:
                            raise ValueError(f"Unknown session action: {action}")
                    except Exception as error:
                        result = {"success": False, "message": str(error), "executed": []}
                    finally:
                        if action == "run" and observe and not shutdown.is_set():
                            resume_observer()
                    emit({"type": "result", "id": request_id, "result": result})
                    if not shutdown.is_set():
                        stop.clear()
                        emit({"type": "state", "state": "ready", "uri": uri, "addressHex": address})
            finally:
                stop_observer()


def main():
    parser = argparse.ArgumentParser(description="Persistent Crazyflie connection")
    parser.add_argument("--uri")
    parser.add_argument("--address-hex")
    parser.add_argument("--lib-path")
    parser.add_argument("--list-radios", action="store_true")
    args = parser.parse_args()
    output = sys.stdout
    output_lock = Lock()

    def emit(payload):
        with output_lock:
            output.write(json.dumps(payload, ensure_ascii=True) + "\n")
            output.flush()

    class Logs:
        def __init__(self):
            self.buffers = {}

        def write(self, text):
            thread_id = get_ident()
            self.buffers[thread_id] = self.buffers.get(thread_id, "") + text
            while "\n" in self.buffers[thread_id]:
                line, self.buffers[thread_id] = self.buffers[thread_id].split("\n", 1)
                if line.strip():
                    emit({"type": "log", "line": line.rstrip("\r")})
            return len(text)

        def flush(self):
            output.flush()

    requests, mapping_requests = queue.Queue(), queue.Queue()
    stop, shutdown = Event(), Event()

    def read_control():
        try:
            for line in sys.stdin:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("Invalid session request")
                if request.get("action") == "cancel":
                    stop.set()
                elif request.get("action") == "shutdown":
                    shutdown.set()
                    stop.set()
                    return
                elif type(request.get("id")) is int and request.get("action") == "mapping":
                    if type(request.get("enabled")) is not bool:
                        raise ValueError("Invalid mapping request")
                    mapping_requests.put(request)
                elif type(request.get("id")) is int and request.get("action") in ("run", "observe"):
                    requests.put(request)
                else:
                    raise ValueError("Invalid session request")
        except (ValueError, OSError) as error:
            emit({"type": "state", "state": "error", "message": f"Session control failed: {error}"})
        finally:
            shutdown.set()
            stop.set()

    try:
        if not _append_cflib_path(args.lib_path):
            raise RuntimeError("Cannot locate crazyflie-lib-python (cflib)")
        if args.list_radios:
            from cflib.drivers.crazyradio import get_serials
            emit({"success": True, "radios": [
                {"index": index, "serial": str(serial).upper()}
                for index, serial in enumerate(get_serials())
            ]})
            return 0
        if not args.uri or not args.address_hex:
            raise ValueError("A radio URI and address are required")
        # Initialize NumPy before a blocking stdin reader can hold Windows CRT locks.
        import cflib.crtp
        Thread(target=read_control, daemon=True).start()
        with redirect_stdout(Logs()):
            serve(args.uri, args.address_hex, emit, requests, stop, shutdown, mapping_requests)
        emit({"type": "state", "state": "disconnected", "message": "Connection closed"})
        return 0
    except Exception as error:
        emit({"type": "state", "state": "error", "message": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
