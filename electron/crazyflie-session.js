const { spawn } = require("child_process");
const { createInterface } = require("readline");

function startCrazyflieSession({ pythonCmd, scriptPath, libPathHint, connectionArgs, onEvent, onClose }) {
  const args = /(?:^|\\)py(?:\.exe)?$/i.test(pythonCmd) ? ["-3"] : [];
  args.push("-B", "-u", scriptPath, ...connectionArgs);
  if (libPathHint) args.push("--lib-path", libPathHint);
  const child = spawn(pythonCmd, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  let stopping = false;
  let activeRun = false;
  let nextId = 0;
  let stderr = "";
  let failure = null;
  let closeTimer;
  const pending = new Map();
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const done = new Promise(resolve => { resolveClosed = resolve; });
  const fail = (message, finished = false) => {
    failure = message;
    rejectReady(new Error(message));
    if (finished) {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.resolve({ success: false, message, executed: [] });
      }
      pending.clear();
    }
    onEvent({ type: "state", state: "error", message });
  };
  const send = payload => {
    if (closed || !child.stdin.writable) throw new Error("Crazyflie connection process is unavailable");
    child.stdin.write(JSON.stringify(payload) + "\n");
  };
  const cancel = () => send({ action: "cancel" });
  const stop = () => {
    if (!closed && !stopping) {
      stopping = true;
      try { send({ action: "shutdown" }); }
      catch (error) { fail(error.message); }
      // Never force-kill a worker that may still be landing.
      if (!activeRun) closeTimer = setTimeout(() => child.kill(), 5000);
    }
    return done;
  };
  const startupTimer = setTimeout(() => {
    fail("Crazyflie connection timed out (15 seconds)");
    void stop();
  }, 15000);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    if (closed || !line.trim()) return;
    let payload;
    try { payload = JSON.parse(line); }
    catch (error) {
      fail(`Invalid connection stream: ${error.message}`);
      void stop();
      return;
    }
    if (payload.type === "state" && payload.state === "ready") {
      if (stopping || failure) return;
      clearTimeout(startupTimer);
      resolveReady({ success: true, uri: payload.uri, addressHex: payload.addressHex });
    } else if (payload.type === "state" && payload.state === "error") {
      fail(String(payload.message));
      void stop();
      return;
    } else if (payload.type === "result") {
      const request = pending.get(payload.id);
      if (request) {
        clearTimeout(request.timer);
        pending.delete(payload.id);
        request.resolve(failure ? { ...payload.result, success: false, message: failure }
          : request.timedOut
          ? { ...payload.result, success: false, message: "Flow timed out; cancellation and landing completed" }
          : payload.result);
      }
      return;
    }
    onEvent(payload);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  child.stdin.on("error", error => {
    fail(`Connection control failed: ${error.message}`);
    void stop();
  });
  child.on("error", error => { fail(error.message); });
  child.on("close", code => {
    closed = true;
    clearTimeout(startupTimer);
    clearTimeout(closeTimer);
    lines.close();
    rejectReady(new Error(failure || "Crazyflie connection closed"));
    if (!stopping || pending.size) fail(failure || `Crazyflie connection closed (${code}): ${stderr}`, true);
    onEvent({ type: "state", state: "disconnected", message: "Crazyflie connection closed" });
    onClose();
    resolveClosed();
  });
  const request = async (action, options = {}) => {
    await ready;
    if (stopping || closed) return { success: false, message: "Crazyflie connection is closing", executed: [] };
    if (action === "run" && activeRun) return { success: false, message: "A flight is already running", executed: [] };
    if (action === "run") activeRun = true;
    try {
      return await new Promise(resolve => {
        const id = ++nextId;
        const entry = { resolve, timedOut: false, timer: null };
        if (action === "run") {
          entry.timer = setTimeout(() => {
            entry.timedOut = true;
            try { cancel(); }
            catch (error) { fail(error.message); void stop(); }
            onEvent({ type: "log", line: "Flow timeout: waiting for current action and landing." });
          }, Math.max(1000, Number(options.timeoutMs || 60000)));
        }
        pending.set(id, entry);
        try { send({ ...options, id, action }); }
        catch (error) { fail(error.message); }
      });
    } finally {
      if (action === "run") activeRun = false;
    }
  };
  return { ready, request, cancel, stop, get running() { return activeRun; } };
}

module.exports = { startCrazyflieSession };
