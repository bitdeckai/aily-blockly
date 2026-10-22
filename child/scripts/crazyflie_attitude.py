#!/usr/bin/env python
import argparse
import json
import math
import sys
import time
from contextlib import contextmanager
from threading import Event, Thread

from crazyflie_run_flow import _append_cflib_path, DEFAULT_URI, DEFAULT_ADDRESS_HEX


@contextmanager
def attitude_logging(scf, emit):
    """Observe an existing connection without owning it or interrupting its commands."""
    stopped = Event()

    def observe():
        try:
            from cflib.crazyflie.log import LogConfig
            stream_attitude(scf, LogConfig, stopped, emit)
        except Exception as exc:
            emit({"type": "error", "message": str(exc)})

    worker = Thread(target=observe, name="AilyAttitude", daemon=True)
    worker.start()
    try:
        yield
    finally:
        stopped.set()
        worker.join(timeout=2.0)
        if worker.is_alive():
            emit({"type": "error", "message": "Attitude logger did not stop before disconnect"})


def stream_attitude(scf, log_config_class, stopped, emit, period_ms=50, stale_sec=1.0):
    config = log_config_class(name="AilyAttitude", period_in_ms=period_ms)
    names = ("stabilizer.roll", "stabilizer.pitch", "stabilizer.yaw")
    for name in names:
        config.add_variable(name, "float")
    scf.cf.log.add_config(config)
    last_sample = [time.monotonic()]
    error = []

    def on_data(timestamp, data, _config):
        if stopped.is_set():
            return
        values = [data.get(name) for name in names]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
               for value in values):
            error.append("Invalid attitude sample")
            stopped.set()
            return
        last_sample[0] = time.monotonic()
        emit({"type": "sample", "timestampMs": timestamp,
              "roll": values[0], "pitch": values[1], "yaw": values[2]})

    def on_error(_config, message):
        error.append(f"Attitude logging failed: {message}")
        stopped.set()

    def on_disconnect(*args):
        if not stopped.is_set():
            error.append(f"Attitude connection lost: {args}")
            stopped.set()

    config.data_received_cb.add_callback(on_data)
    config.error_cb.add_callback(on_error)
    scf.cf.disconnected.add_callback(on_disconnect)
    try:
        config.start()
        while not stopped.wait(0.05):
            if time.monotonic() - last_sample[0] > stale_sec:
                raise TimeoutError("No fresh attitude data for 1 second")
        if error:
            raise RuntimeError(error[0])
    finally:
        try:
            try:
                config.stop()
            finally:
                config.delete()
        finally:
            config.data_received_cb.remove_callback(on_data)
            config.error_cb.remove_callback(on_error)
            scf.cf.disconnected.remove_callback(on_disconnect)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--uri", default=DEFAULT_URI)
    parser.add_argument("--address-hex", default=DEFAULT_ADDRESS_HEX)
    parser.add_argument("--lib-path")
    args = parser.parse_args()
    stopped = Event()

    def stop_on_input():
        sys.stdin.readline()
        stopped.set()

    Thread(target=stop_on_input, daemon=True).start()
    try:
        _append_cflib_path(args.lib_path)
        import cflib.crtp
        from cflib.crazyflie.syncCrazyflie import SyncCrazyflie
        from cflib.crazyflie.log import LogConfig

        cflib.crtp.init_drivers()
        uri = args.uri.rstrip("/")
        if len(uri.split("/")) == 5:
            uri += "/" + args.address_hex
        with SyncCrazyflie(uri) as scf:
            stream_attitude(scf, LogConfig, stopped,
                            lambda sample: print(json.dumps(sample), flush=True))
        print(json.dumps({"type": "stopped"}), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"type": "error", "message": str(exc)}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
