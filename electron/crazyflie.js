const { ipcMain } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { startAttitudeMonitor } = require("./crazyflie-attitude");

const DEFAULT_CRAZYFLIE_URI = "radio://0/80/2M";
const DEFAULT_CRAZYFLIE_ADDRESS_HEX = "E7E7E7E7E7";

function resolveChildPath(...parts) {
  const childPath = process.env.AILY_CHILD_PATH || path.join(__dirname, "..", "child");
  return path.join(childPath, ...parts);
}

function getCrazyflieLibPathHint() {
  if (process.env.CRAZYFLIE_LIB_PATH) {
    return process.env.CRAZYFLIE_LIB_PATH;
  }

  // Default behavior: use cflib installed in the selected Python environment.
  // Local repo path is now only used when CRAZYFLIE_LIB_PATH is explicitly set.
  return null;
}

function fileExists(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath);
  } catch (_error) {
    return false;
  }
}

function getPythonCandidates() {
  const localAppData = process.env.LOCALAPPDATA || "";
  const userProfile = process.env.USERPROFILE || "";
  const candidates = [
    process.env.PYTHON,
    path.join(process.env.SystemRoot || "C:\\Windows", "py.exe"),
    path.join(localAppData, "Programs", "Python", "Python310", "python.exe"),
    path.join(localAppData, "Programs", "Python", "Python311", "python.exe"),
    path.join(localAppData, "Microsoft", "WindowsApps", "python.exe"),
    path.join(userProfile, "AppData", "Local", "Programs", "Python", "Python310", "python.exe"),
    path.join(userProfile, "AppData", "Local", "Programs", "Python", "Python311", "python.exe"),
    "py",
    "python",
  ];

  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    if (!item) continue;
    const key = String(item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped.filter((item) => {
    const text = String(item);
    if (text === "py" || text === "python") {
      return true;
    }
    return fileExists(text);
  });
}

function runScript(pythonCmd, scriptPath, timeoutMs, libPathHint, extraArgs = [], includeTimeoutArg = true) {
  const args = [];
  if (pythonCmd === "py" || pythonCmd.toLowerCase().endsWith("\\py.exe")) {
    args.push("-3");
  }
  args.push("-u");
  args.push(scriptPath);
  if (includeTimeoutArg && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    args.push("--timeout-ms", String(timeoutMs));
  }
  if (libPathHint) {
    args.push("--lib-path", libPathHint);
  }
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  return new Promise((resolve, reject) => {
    execFile(
      pythonCmd,
      args,
      {
        encoding: "utf-8",
        timeout: timeoutMs + 4000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({ error, stdout, stderr, pythonCmd, args });
          return;
        }
        resolve({ stdout, stderr, pythonCmd, args });
      }
    );
  });
}

function parseLastJsonLine(output) {
  const text = String(output || "").trim();
  if (!text) {
    return null;
  }

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch (_error) {
      // ignore non-json lines
    }
  }
  return null;
}

function parseJsonOutput(output) {
  const text = String(output || "").trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (_error) {
    return parseLastJsonLine(text);
  }
}

function parseScriptResultFromError(errorInfo) {
  const parsed = parseLastJsonLine(errorInfo?.stdout) || parseLastJsonLine(errorInfo?.stderr);
  return parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "success")
    ? parsed
    : null;
}

function normalizeUri(input) {
  const text = String(input || "").trim();
  return text || DEFAULT_CRAZYFLIE_URI;
}

function normalizeAddressHex(input) {
  const normalized = String(input || "")
    .trim()
    .replace(/^0x/i, "")
    .replace(/[^0-9a-fA-F]/g, "")
    .toUpperCase();
  return normalized.length === 10 ? normalized : DEFAULT_CRAZYFLIE_ADDRESS_HEX;
}

function buildConnectionArgs(options = {}) {
  const uri = normalizeUri(options.uri);
  const addressHex = normalizeAddressHex(options.addressHex);
  return {
    uri,
    addressHex,
    args: ["--uri", uri, "--address-hex", addressHex],
  };
}

async function testLink(options = {}) {
  const timeoutMs = Number(options.timeoutMs || 4000);
  const scriptPath = resolveChildPath("scripts", "crazyflie_link_test.py");
  const libPathHint = getCrazyflieLibPathHint();
  const connection = buildConnectionArgs(options);

  const errors = [];
  for (const pythonCmd of getPythonCandidates()) {
    try {
      const { stdout, stderr } = await runScript(pythonCmd, scriptPath, timeoutMs, libPathHint, connection.args, true);
      const parsed = parseLastJsonLine(stdout) || parseLastJsonLine(stderr);
      if (parsed) {
        return {
          success: !!parsed.success,
          message: parsed.message || (parsed.success ? "Link test success" : "Link test failed"),
          radioStatus: parsed.radioStatus || "unknown",
          links: parsed.links || [],
          loadedFrom: parsed.loadedFrom || null,
          detail: parsed,
        };
      }

      return {
        success: false,
        message: "Invalid script output",
        radioStatus: "unknown",
        links: [],
        loadedFrom: null,
        detail: { stdout, stderr },
      };
    } catch (errorInfo) {
      const parsed = parseScriptResultFromError(errorInfo);
      if (parsed) {
        return {
          success: !!parsed.success,
          message: parsed.message || (parsed.success ? "Link test success" : "Link test failed"),
          radioStatus: parsed.radioStatus || "unknown",
          links: parsed.links || [],
          loadedFrom: parsed.loadedFrom || null,
          detail: parsed,
        };
      }
      errors.push({
        pythonCmd,
        message: errorInfo?.error?.message || "unknown error",
        stdout: errorInfo?.stdout || "",
        stderr: errorInfo?.stderr || "",
      });
    }
  }

  return {
    success: false,
    message: "Cannot run Python",
    radioStatus: "unknown",
    links: [],
    loadedFrom: null,
    detail: { errors },
  };
}

async function runFlow(options = {}) {
  const timeoutMs = Number(options.timeoutMs || 45000);
  const scriptPath = resolveChildPath("scripts", "crazyflie_run_flow.py");
  const libPathHint = getCrazyflieLibPathHint();
  const connection = buildConnectionArgs(options);
  const uri = connection.uri;
  const code = typeof options.code === "string" ? options.code : "";
  const codeBase64 = Buffer.from(code, "utf-8").toString("base64");

  const errors = [];
  for (const pythonCmd of getPythonCandidates()) {
    try {
      const { stdout, stderr } = await runScript(
        pythonCmd,
        scriptPath,
        timeoutMs,
        libPathHint,
        [...connection.args, "--code-base64", codeBase64],
        false
      );
      const parsed = parseLastJsonLine(stdout) || parseLastJsonLine(stderr);
      if (parsed) {
        return {
          success: !!parsed.success,
          message: parsed.message || (parsed.success ? "Flow executed" : "Flow failed"),
          radioStatus: parsed.radioStatus || "unknown",
          links: parsed.links || [],
          executed: parsed.executed || [],
          loadedFrom: parsed.loadedFrom || null,
          detail: parsed,
        };
      }

      return {
        success: false,
        message: "Invalid flow script output",
        radioStatus: "unknown",
        links: [],
        executed: [],
        loadedFrom: null,
        detail: { stdout, stderr },
      };
    } catch (errorInfo) {
      const parsed = parseScriptResultFromError(errorInfo);
      if (parsed) {
        return {
          success: !!parsed.success,
          message: parsed.message || (parsed.success ? "Flow executed" : "Flow failed"),
          radioStatus: parsed.radioStatus || "unknown",
          links: parsed.links || [],
          executed: parsed.executed || [],
          loadedFrom: parsed.loadedFrom || null,
          detail: parsed,
        };
      }
      errors.push({
        pythonCmd,
        message: errorInfo?.error?.message || "unknown error",
        stdout: errorInfo?.stdout || "",
        stderr: errorInfo?.stderr || "",
      });
    }
  }

  return {
    success: false,
    message: "Cannot run Python",
    radioStatus: "unknown",
    links: [],
    executed: [],
    loadedFrom: null,
    detail: { errors },
  };
}

function runScriptStream(pythonCmd, scriptPath, timeoutMs, libPathHint, extraArgs = [], includeTimeoutArg = true, onLine, onChild) {
  const args = [];
  if (pythonCmd === "py" || pythonCmd.toLowerCase().endsWith("\\py.exe")) {
    args.push("-3");
  }
  args.push("-B", "-u");
  args.push(scriptPath);
  if (includeTimeoutArg && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    args.push("--timeout-ms", String(timeoutMs));
  }
  if (libPathHint) {
    args.push("--lib-path", libPathHint);
  }
  if (Array.isArray(extraArgs) && extraArgs.length > 0) {
    args.push(...extraArgs);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(pythonCmd, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    onChild?.(child);

    let stdout = "";
    let stderr = "";
    let stdoutPending = "";
    let stderrPending = "";
    let timedOut = false;
    child.stdin.on("error", error => { stderr += `Control input error: ${error.message}\n`; });

    const emitLine = (source, line) => {
      if (!line) {
        return;
      }
      const text = String(line).trim();
      if (!text) {
        return;
      }
      if (!text.startsWith("__ATTITUDE__:")) {
        if (source === "stdout") stdout += text + "\n";
        else stderr += text + "\n";
      }
      if (typeof onLine === "function") {
        onLine({ source, line: text });
      }
    };

    const flushLines = (source, chunkText, isFinal = false) => {
      const pending = source === "stdout" ? stdoutPending : stderrPending;
      const merged = pending + chunkText;
      const parts = merged.split(/\r?\n/);
      const nextPending = parts.pop() || "";
      parts.forEach((line) => emitLine(source, line));
      if (source === "stdout") {
        stdoutPending = isFinal ? "" : nextPending;
      } else {
        stderrPending = isFinal ? "" : nextPending;
      }
      if (isFinal) {
        emitLine(source, nextPending);
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = String(chunk || "");
      flushLines("stdout", text, false);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      flushLines("stderr", text, false);
    });

    child.on("error", (error) => {
      clearTimeout(killTimer);
      reject({ error, stdout, stderr, pythonCmd, args });
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      if (child.stdin.writable) child.stdin.write("stop\n");
      onLine?.({ source: "stderr", line: "Flow timeout: requested cancellation; waiting for the current action and landing." });
    }, Math.max(1000, timeoutMs + 4000));

    child.on("close", (code) => {
      clearTimeout(killTimer);
      flushLines("stdout", "", true);
      flushLines("stderr", "", true);

      if (timedOut) {
        reject({ error: new Error("Process timeout"), stdout, stderr, pythonCmd, args });
        return;
      }
      if (code !== 0) {
        reject({ error: new Error(`Exit code ${code}`), stdout, stderr, pythonCmd, args });
        return;
      }
      resolve({ stdout, stderr, pythonCmd, args });
    });
  });
}

async function runFlowStream(event, options = {}, onAttitude = () => {}, onChild) {
  const timeoutMs = Number(options.timeoutMs || 45000);
  const scriptPath = resolveChildPath("scripts", "crazyflie_run_flow.py");
  const libPathHint = getCrazyflieLibPathHint();
  const connection = buildConnectionArgs(options);
  const uri = connection.uri;
  const code = typeof options.code === "string" ? options.code : "";
  const codeBase64 = Buffer.from(code, "utf-8").toString("base64");

  const sendLog = (payload) => {
    try {
      event?.sender?.send("crazyflie-flow-log", payload);
    } catch (_error) {
      // ignore renderer dispatch failures
    }
  };

  const errors = [];
  for (const pythonCmd of getPythonCandidates()) {
    try {
      const { stdout, stderr } = await runScriptStream(
        pythonCmd,
        scriptPath,
        timeoutMs,
        libPathHint,
        [...connection.args, "--code-base64", codeBase64, "--attitude", "--control-stdin",
          ...(options.followPosition ? ["--follow-position"] : [])],
        false,
        ({ source, line }) => {
          if (line.startsWith("__ATTITUDE__:")) {
            const payload = parseJsonOutput(line.slice("__ATTITUDE__:".length));
            if (payload?.type === "reference") {
              onAttitude(payload);
            } else if (payload?.type === "sample"
                && [payload.timestampMs, payload.roll, payload.pitch, payload.yaw].every(Number.isFinite)
                && (!options.followPosition || [payload.x, payload.y, payload.z].every(Number.isFinite))) {
              onAttitude(payload);
            } else {
              onAttitude({ type: "error", message: payload?.message || "Invalid flow attitude sample" });
            }
            return;
          }
          const parsed = parseJsonOutput(line);
          if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "success")) {
            return;
          }
          sendLog({ source, line });
        },
        onChild
      );

      const parsed = parseLastJsonLine(stdout) || parseLastJsonLine(stderr);
      if (parsed) {
        return {
          success: !!parsed.success,
          message: parsed.message || (parsed.success ? "Flow executed" : "Flow failed"),
          radioStatus: parsed.radioStatus || "unknown",
          links: parsed.links || [],
          executed: parsed.executed || [],
          loadedFrom: parsed.loadedFrom || null,
          detail: parsed,
        };
      }

      return {
        success: false,
        message: "Invalid flow script output",
        radioStatus: "unknown",
        links: [],
        executed: [],
        loadedFrom: null,
        detail: { stdout, stderr },
      };
    } catch (errorInfo) {
      const parsed = parseScriptResultFromError(errorInfo);
      if (parsed) {
        return {
          success: errorInfo?.error?.message === "Process timeout" ? false : !!parsed.success,
          message: errorInfo?.error?.message === "Process timeout"
            ? "Flow timed out; executor exited after the cancellation request"
            : parsed.message || (parsed.success ? "Flow executed" : "Flow failed"),
          radioStatus: parsed.radioStatus || "unknown",
          links: parsed.links || [],
          executed: parsed.executed || [],
          loadedFrom: parsed.loadedFrom || null,
          detail: parsed,
        };
      }
      const failure = {
        pythonCmd,
        message: errorInfo?.error?.message || "unknown error",
        stdout: errorInfo?.stdout || "",
        stderr: errorInfo?.stderr || "",
      };
      errors.push(failure);
      // Once a process can have sent commands, never replay the plan in another interpreter.
      if (!["ENOENT", "EACCES"].includes(errorInfo?.error?.code)) {
        return { success: false, message: failure.message, radioStatus: "error", executed: [],
          detail: failure };
      }
    }
  }

  return {
    success: false,
    message: "Cannot run Python",
    radioStatus: "unknown",
    links: [],
    executed: [],
    loadedFrom: null,
    detail: { errors },
  };
}

async function listRadios() {
  if (process.platform !== "win32") {
    return { success: true, radios: [] };
  }

  const psScript = [
    "$devices = Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -like '*Crazyradio*' } | Select-Object FriendlyName, Status, Class, InstanceId",
    "if ($devices) { $devices | ConvertTo-Json -Compress } else { '[]' }",
  ].join("; ");

  return new Promise((resolve) => {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      {
        encoding: "utf-8",
        timeout: 8000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            radios: [],
            message: error?.message || "list radios failed",
            detail: { stdout, stderr },
          });
          return;
        }

        const parsed = parseJsonOutput(stdout) || parseJsonOutput(stderr) || [];
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const normalizeInstanceId = (value) => {
          const raw = String(value || "").trim().toUpperCase();
          if (!raw) return "";
          // Collapse composite interfaces and transient suffixes to one physical key.
          return raw.replace(/&MI_[0-9A-F]{2}/g, "");
        };

        const seen = new Set();
        const radios = list
          .filter((item) => item && item.FriendlyName)
          .filter((item) => {
            const key = normalizeInstanceId(item.InstanceId) || String(item.FriendlyName || "").toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map((item) => ({
            name: String(item.FriendlyName || "Crazyradio USB"),
            status: String(item.Status || "Unknown"),
            className: String(item.Class || ""),
            instanceId: String(item.InstanceId || ""),
          }));

        resolve({ success: true, radios });
      }
    );
  });
}

function registerCrazyflieHandlers() {
  let session = null;
  let radioOperation = false;
  let operationSenderId = null;
  let monitorShutdown = null;
  let flowControl = null;

  const sendAttitude = payload => {
    if (session && !session.sender.isDestroyed()) {
      session.sender.send("crazyflie-attitude", payload);
    }
  };
  const stopIdleMonitor = async () => {
    const monitor = session?.monitor;
    if (monitor && !monitorShutdown) {
      monitorShutdown = monitor.stop().finally(() => { monitorShutdown = null; });
    }
    if (monitorShutdown) await monitorShutdown;
  };
  const startIdleMonitor = () => {
    if (!session || radioOperation || session.monitor || session.sender.isDestroyed()) return;
    const owner = session;
    const pythonCmd = getPythonCandidates()[0];
    if (!pythonCmd) {
      sendAttitude({ type: "error", message: "Cannot find Python for attitude monitoring" });
      return;
    }
    sendAttitude({ type: "state", state: "connecting" });
    owner.monitor = startAttitudeMonitor({
      sender: owner.sender,
      pythonCmd,
      scriptPath: resolveChildPath("scripts", "crazyflie_attitude.py"),
      libPathHint: getCrazyflieLibPathHint(),
      connectionArgs: buildConnectionArgs(owner.options).args,
      onEvent: payload => {
        if (session === owner && payload.type !== "stopped") sendAttitude(payload);
      },
      onClose: () => { owner.monitor = null; },
    });
  };
  const removeSession = async () => {
    const owner = session;
    session = null;
    if (!owner) return;
    owner.sender.removeListener("destroyed", owner.onDestroyed);
    owner.sender.removeListener("render-process-gone", owner.onDestroyed);
    owner.sender.removeListener("did-start-navigation", owner.onNavigation);
    if (owner.monitor && !monitorShutdown) {
      monitorShutdown = owner.monitor.stop().finally(() => { monitorShutdown = null; });
    }
    if (monitorShutdown) await monitorShutdown;
  };
  const withRadio = async (event, options, run, flight = false) => {
    if (radioOperation || (session && session.sender.id !== event.sender.id)) {
      return { success: false, radioStatus: "busy", message: "Crazyradio is busy in another operation or window", links: [], executed: [] };
    }
    radioOperation = true;
    operationSenderId = event.sender.id;
    const requestStop = () => {
      if (!flowControl) return;
      flowControl.stopping = true;
      if (flowControl.child?.stdin.writable) flowControl.child.stdin.write("stop\n");
    };
    const onNavigation = (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) requestStop();
    };
    if (flight) {
      flowControl = { child: null, stopping: false, requestStop };
      event.sender.once("destroyed", requestStop);
      event.sender.once("render-process-gone", requestStop);
      event.sender.on("did-start-navigation", onNavigation);
    }
    try {
      sendAttitude({ type: "state", state: "flow" });
      await stopIdleMonitor();
      if (session) session.options = buildConnectionArgs(options);
      return await run();
    } finally {
      if (flight) {
        event.sender.removeListener("destroyed", requestStop);
        event.sender.removeListener("render-process-gone", requestStop);
        event.sender.removeListener("did-start-navigation", onNavigation);
        flowControl = null;
      }
      radioOperation = false;
      operationSenderId = null;
      startIdleMonitor();
    }
  };

  ipcMain.handle("crazyflie-start-attitude", (event, options = {}) => {
    if (session || monitorShutdown || (radioOperation && operationSenderId !== event.sender.id)) {
      return { success: false, message: "Attitude monitoring is already active or Crazyradio belongs to another window" };
    }
    if (!/^radio:\/\/\d+\/\d+\/(?:250K|1M|2M)(?:\/[0-9a-fA-F]{10})?$/.test(String(options.uri || ""))
        || !/^[0-9a-fA-F]{10}$/.test(String(options.addressHex || ""))) {
      return { success: false, message: "Invalid Crazyflie radio URI or address" };
    }
    const onDestroyed = () => { void removeSession(); };
    const onNavigation = (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) void removeSession();
    };
    session = { sender: event.sender, options, monitor: null, onDestroyed, onNavigation };
    event.sender.once("destroyed", onDestroyed);
    event.sender.once("render-process-gone", onDestroyed);
    event.sender.on("did-start-navigation", onNavigation);
    if (radioOperation) sendAttitude({ type: "state", state: "flow" });
    else startIdleMonitor();
    return { success: true };
  });
  ipcMain.handle("crazyflie-stop-attitude", async event => {
    if (session && session.sender.id !== event.sender.id) {
      return { success: false, message: "Only the monitoring window can stop attitude display" };
    }
    await removeSession();
    return { success: true };
  });

  ipcMain.handle("crazyflie-test-link", async (_event, options) => {
    try {
      return await withRadio(_event, options || {}, () => testLink(options || {}));
    } catch (error) {
      return {
        success: false,
        message: error?.message || "crazyflie test link failed",
        radioStatus: "error",
        links: [],
        loadedFrom: null,
      };
    }
  });

  ipcMain.handle("crazyflie-run-flow", async (event, options) => {
    try {
      return await withRadio(event, options || {}, () => runFlowStream(event, options || {}, payload => {
        sendAttitude(payload);
        if (options?.followPosition && session?.sender.id !== event.sender.id && !event.sender.isDestroyed()) {
          event.sender.send("crazyflie-attitude", payload);
        }
      }, child => {
        flowControl.child = child;
        if (flowControl.stopping && child.stdin.writable) child.stdin.write("stop\n");
      }), true);
    } catch (error) {
      return {
        success: false,
        message: error?.message || "crazyflie run flow failed",
        radioStatus: "error",
        links: [],
        executed: [],
        loadedFrom: null,
      };
    }
  });

  ipcMain.handle("crazyflie-cancel-flow", event => {
    if (!flowControl || operationSenderId !== event.sender.id) {
      return { success: false, message: "No flight owned by this window is running" };
    }
    flowControl.requestStop();
    return { success: true };
  });

  ipcMain.handle("crazyflie-list-radios", async () => {
    try {
      return await listRadios();
    } catch (error) {
      return {
        success: false,
        radios: [],
        message: error?.message || "crazyflie list radios failed",
      };
    }
  });
}

module.exports = {
  registerCrazyflieHandlers,
};
