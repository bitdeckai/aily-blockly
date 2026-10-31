import math
import queue
import time
from collections import deque
from contextlib import contextmanager, ExitStack
from threading import Event, Lock, Thread


def timestamp_difference(a, b):
    return (a - b + 0x800000) % 0x1000000 - 0x800000


def stream_mapping(scf, log_config_class, stopped, emit, period_ms=200, stale_sec=1.5, initial_epoch=0):
    if str(scf.cf.param.get_value("deck.bcMultiranger")) != "1":
        raise RuntimeError("Mapping requires an installed Multiranger deck")
    pose_names = ("stateEstimate.x", "stateEstimate.y", "stateEstimate.z",
                  "stabilizer.roll", "stabilizer.pitch", "stabilizer.yaw")
    directions = ("front", "back", "left", "right", "up")
    range_names = tuple(f"range.{direction}" for direction in directions)
    for name in pose_names + range_names:
        if scf.cf.log.toc.get_element_by_complete_name(name) is None:
            raise RuntimeError(f"Mapping firmware variable unavailable: {name}")
    pose_config = log_config_class(name="AilyMappingPose", period_in_ms=period_ms)
    range_config = log_config_class(name="AilyMappingRange", period_in_ms=period_ms)
    for name in pose_names:
        pose_config.add_variable(name, "float")
    for name in range_names:
        range_config.add_variable(name, "uint16_t")
    # XYZ/RPY (24 bytes) and five ranges (10 bytes) cannot fit one 26-byte log packet.
    poses, ranges = deque(maxlen=8), deque(maxlen=8)
    state = {"epoch": initial_epoch, "last": None, "received": time.monotonic()}
    errors = []
    lock = Lock()

    def fail(message):
        errors.append(message)
        stopped.set()

    def pair():
        for timestamp, values in list(ranges):
            if not poses:
                continue
            pose_timestamp, pose = min(poses, key=lambda item: abs(timestamp_difference(timestamp, item[0])))
            if abs(timestamp_difference(timestamp, pose_timestamp)) > 50:
                continue
            ranges.remove((timestamp, values))
            if state["last"] is not None and timestamp_difference(timestamp, state["last"]) <= 0:
                continue
            state["last"], state["received"] = timestamp, time.monotonic()
            emit({"type": "sample", "timestampMs": timestamp, "poseTimestampMs": pose_timestamp,
                  "epoch": state["epoch"], **dict(zip(("x", "y", "z", "roll", "pitch", "yaw"), pose)),
                  "ranges": {direction: value / 1000 if 0 < value < 4000 else None
                             for direction, value in zip(directions, values)}})

    def receive(timestamp, data, names, buffer, is_range):
        if stopped.is_set():
            return
        values = tuple(data.get(name) for name in names)
        valid_time = type(timestamp) is int and 0 <= timestamp <= 0xffffff
        valid_values = all(type(value) is int and 0 <= value <= 0xffff for value in values) if is_range else all(
            type(value) in (int, float) and math.isfinite(value) for value in values)
        if not valid_time or not valid_values:
            fail("Invalid mapping range/pose telemetry")
            return
        with lock:
            buffer.append((timestamp, values))
            pair()

    def on_pose(timestamp, data, _config):
        receive(timestamp, data, pose_names, poses, False)

    def on_range(timestamp, data, _config):
        receive(timestamp, data, range_names, ranges, True)

    def on_reference(_name, value):
        if str(value) == "0":
            with lock:
                state.update(epoch=state["epoch"] + 1, last=None, received=time.monotonic())
                poses.clear()
                ranges.clear()
                emit({"type": "reference"})

    def on_error(_config, message):
        fail(f"Mapping logging failed: {message}")

    def on_disconnect(*_args):
        fail("Mapping connection lost")

    def dispose_config(config):
        try:
            config.stop()
        finally:
            config.delete()

    with ExitStack() as cleanup:
        for config in (pose_config, range_config):
            scf.cf.log.add_config(config)
            cleanup.callback(dispose_config, config)
        callbacks = [(pose_config.data_received_cb, on_pose), (range_config.data_received_cb, on_range),
                     (pose_config.error_cb, on_error), (range_config.error_cb, on_error),
                     (scf.cf.disconnected, on_disconnect)]
        for callback, handler in callbacks:
            callback.add_callback(handler)
            cleanup.callback(callback.remove_callback, handler)
        scf.cf.param.add_update_callback(group="kalman", name="resetEstimation", cb=on_reference)
        cleanup.callback(scf.cf.param.remove_update_callback, group="kalman", name="resetEstimation", cb=on_reference)
        pose_config.start()
        range_config.start()
        while not stopped.wait(0.05):
            if time.monotonic() - state["received"] > stale_sec:
                raise TimeoutError("Mapping pose/ranges are stale or more than 50 ms apart")
        if errors:
            raise RuntimeError(errors[0])


@contextmanager
def mapping_logging(scf, log_config_class, emit, initial_epoch):
    stopped, ready = Event(), Event()
    errors = []

    def report(payload):
        emit({"type": "mapping", "payload": payload})
        if payload["type"] == "sample":
            ready.set()

    def observe():
        try:
            stream_mapping(scf, log_config_class, stopped, report, initial_epoch=initial_epoch)
        except Exception as error:
            errors.append(str(error))
            ready.set()

    def healthy():
        if errors:
            raise RuntimeError(errors[0])

    worker = Thread(target=observe, name="AilyMapping", daemon=True)
    worker.start()
    try:
        if not ready.wait(2.5):
            raise TimeoutError("No synchronized mapping sample received")
        healthy()
        yield healthy
    finally:
        stopped.set()
        worker.join(timeout=2)
        if worker.is_alive():
            raise RuntimeError("Mapping logger did not stop before disconnect")


@contextmanager
def mapping_control(scf, log_config_class, emit, requests, shutdown):
    closed = Event()
    epoch = [0]

    def on_reference(_name, value):
        if str(value) == "0":
            epoch[0] += 1
            emit({"type": "mapping", "payload": {"type": "reference"}})

    def control():
        context, healthy = None, None

        def stop():
            nonlocal context, healthy
            current, context, healthy = context, None, None
            if current is not None:
                current.__exit__(None, None, None)

        def report_error(error):
            emit({"type": "mapping", "payload": {"type": "error", "message": str(error)}})

        try:
            while not closed.is_set() and not shutdown.is_set():
                if healthy is not None:
                    try:
                        healthy()
                    except Exception as error:
                        report_error(error)
                        stop()
                try:
                    request = requests.get(timeout=0.1)
                except queue.Empty:
                    continue
                try:
                    stop()
                    if request["enabled"]:
                        next_context = mapping_logging(scf, log_config_class, emit, epoch[0])
                        healthy = next_context.__enter__()
                        context = next_context
                    else:
                        emit({"type": "mapping", "payload": {"type": "stopped"}})
                    result = {"success": True}
                except Exception as error:
                    report_error(error)
                    result = {"success": False, "message": str(error)}
                emit({"type": "result", "id": request["id"], "result": result})
        except Exception as error:
            report_error(error)
        finally:
            try:
                stop()
            except Exception as error:
                report_error(error)

    worker = Thread(target=control, name="AilyMappingControl", daemon=True)
    scf.cf.param.add_update_callback(group="kalman", name="resetEstimation", cb=on_reference)
    worker.start()
    try:
        yield
    finally:
        closed.set()
        worker.join(timeout=5)
        scf.cf.param.remove_update_callback(group="kalman", name="resetEstimation", cb=on_reference)
        if worker.is_alive():
            emit({"type": "mapping", "payload": {"type": "error", "message": "Mapping control did not stop"}})
