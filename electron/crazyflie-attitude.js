const { spawn } = require("child_process");
const { createInterface } = require("readline");

// Owns one read-only Python connection. There is no command/arming interface.
function startAttitudeMonitor({ sender, pythonCmd, scriptPath, libPathHint, connectionArgs, onClose, onEvent }) {
  const args = [];
  if (pythonCmd === "py" || pythonCmd.toLowerCase().endsWith("\\py.exe")) args.push("-3");
  args.push("-B", "-u", scriptPath, ...connectionArgs);
  if (libPathHint) args.push("--lib-path", libPathHint);
  const child = spawn(pythonCmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stopping = false;
  let failed = false;
  let closed = false;
  let firstSample = true;
  let killTimer;
  let stderr = "";
  let resolveClosed;
  const done = new Promise(resolve => { resolveClosed = resolve; });
  const send = payload => {
    if (!sender.isDestroyed()) {
      if (onEvent) onEvent(payload);
      else sender.send("crazyflie-attitude", payload);
    }
  };
  const reportError = message => {
    if (!failed && !stopping) {
      failed = true;
      send({ type: "error", message });
    }
  };
  const stop = () => {
    if (!closed && !stopping) {
      stopping = true;
      child.stdin.end("stop\n");
      killTimer = setTimeout(() => child.kill(), 2000);
    }
    return done;
  };
  const startupTimer = setTimeout(() => {
    reportError("Attitude connection timed out (15 seconds)");
    void stop();
  }, 15000);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    if (stopping || closed) return;
    if (!line.trim().startsWith("{")) return; // cflib may print diagnostics before JSON samples.
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      reportError(`Invalid attitude stream: ${error.message}`);
      void stop();
      return;
    }
    if (payload.type === "sample") {
      if (![payload.timestampMs, payload.roll, payload.pitch, payload.yaw].every(Number.isFinite)) {
        reportError("Invalid attitude sample");
        void stop();
        return;
      }
      if (firstSample) {
        firstSample = false;
        clearTimeout(startupTimer);
      }
      send(payload);
    } else if (payload.type === "error") {
      reportError(String(payload.message));
      void stop();
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on("error", error => {
    if (!stopping) {
      reportError(`Attitude input error: ${error.message}`);
      void stop();
    }
  });
  child.on("error", error => {
    reportError(`Cannot start attitude monitor: ${error.message}`);
  });
  const onDestroyed = () => { void stop(); };
  const onNavigation = (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) void stop();
  };
  sender.once("destroyed", onDestroyed);
  sender.on("did-start-navigation", onNavigation);
  sender.once("render-process-gone", onDestroyed);
  child.on("close", code => {
    closed = true;
    clearTimeout(startupTimer);
    clearTimeout(killTimer);
    lines.close();
    sender.removeListener("destroyed", onDestroyed);
    sender.removeListener("did-start-navigation", onNavigation);
    sender.removeListener("render-process-gone", onDestroyed);
    if (!stopping) reportError(`Attitude monitor exited (${code}): ${stderr || "connection closed"}`);
    send({ type: "stopped" });
    onClose();
    resolveClosed();
  });
  return { senderId: sender.id, stop };
}

module.exports = { startAttitudeMonitor };
