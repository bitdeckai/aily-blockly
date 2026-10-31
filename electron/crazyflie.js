const { ipcMain } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { startCrazyflieSession } = require("./crazyflie-session");

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
      const step = /^__STEP__:(\d+)\/(\d+):(.+)$/.exec(payload.line);
      if (step && options.stepTotal) {
        payload = { ...payload, line: `__STEP__:${Number(step[1]) + (options.stepOffset || 0)}/${options.stepTotal}:${step[3]}` };
      }
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

async function listInterfaces() {
  const pythonCmd = getPythonCandidates()[0];
  if (!pythonCmd) throw new Error("Cannot find Python for Crazyflie");
  const { stdout } = await runScript(pythonCmd, resolveChildPath("scripts", "crazyflie_session.py"),
    10000, getCrazyflieLibPathHint(), ["--list-radios"], false);
  const result = parseLastJsonLine(stdout);
  if (!result?.success || !Array.isArray(result.radios)) {
    throw new Error(result?.message || "Cannot enumerate Crazyradio USB serial numbers");
  }
  return result.radios;
}

function canonicalConnection(options, radios) {
  const match = /^radio:\/\/([A-Za-z0-9]+)\/(\d+)\/(250K|1M|2M)(?:\/([A-Fa-f0-9]{10}))?(\?[^ \r\n]*)?$/
    .exec(String(options.uri || DEFAULT_CRAZYFLIE_URI));
  const addressHex = String(options.addressHex || match?.[4] || DEFAULT_CRAZYFLIE_ADDRESS_HEX).toUpperCase();
  if (!match || Number(match[2]) > 125 || !/^[A-F0-9]{10}$/.test(addressHex)) {
    throw new Error("Invalid Crazyflie radio URI or address");
  }
  const radioId = String(options.radioId || match[1]).toUpperCase();
  const radio = radios.find(item => /^\d{1,9}$/.test(radioId)
    ? item.index === Number(radioId) : item.serial === radioId);
  if (!radio) throw new Error("Selected wireless transceiver is not available; select it again");
  if (!radio.serial || !/^[A-Fa-f0-9]{10,}$/.test(radio.serial)
      || radios.filter(item => item.serial === radio.serial).length !== 1) {
    throw new Error("The selected wireless transceiver does not have a usable unique USB serial number");
  }
  return { uri: `radio://${radio.serial}/${Number(match[2])}/${match[3]}/${addressHex}${match[5] || ''}`,
    addressHex, radioIndex: radio.index, radioSerial: radio.serial };
}

function registerCrazyflieHandlers() {
  let owner = null;
  let operation = null;
  const failure = error => ({ success: false, radioStatus: "error",
    message: error?.message || String(error), links: [], executed: [] });
  const send = (sender, channel, payload) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };
  const busy = sender => (operation || (owner && owner.sender.id !== sender.id))
    ? { success: false, radioStatus: "busy", message: "Crazyradio is busy; wait for this operation or close the other window", executed: [] } : null;
  const closeOwner = async current => {
    if (current?.worker) await current.worker.stop();
  };
  const ensureConnection = async (event, options) => {
    const radios = await listInterfaces();
    if (operation?.cancelled || event.sender.isDestroyed()) throw new Error("Connection cancelled before opening the radio");
    if (!owner && radios.length > 1 && !options.radioId && !options.explicitRadio) {
      throw new Error("Multiple wireless transceivers detected; select one before connecting");
    }
    const connection = canonicalConnection(options, radios);
    if (options.explicitRadio && options.radioId
        && canonicalConnection({ ...options, radioId: undefined }, radios).radioSerial !== connection.radioSerial) {
      throw new Error("Selected wireless transceiver does not match the block configuration");
    }
    if (owner) {
      if (owner.sender.id !== event.sender.id || owner.connection.uri !== connection.uri) {
        throw new Error("A different aircraft or wireless transceiver is connected; disconnect it before changing");
      }
      await owner.worker.ready;
      return owner;
    }
    const current = { sender: event.sender, connection, worker: null, observing: true, status: "checking" };
    const onDestroyed = () => {
      void closeOwner(current).catch(error => console.error("Crazyflie session cleanup failed:", error));
    };
    const onNavigation = (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) onDestroyed();
    };
    owner = current;
    current.sender.once("destroyed", onDestroyed);
    current.sender.once("render-process-gone", onDestroyed);
    current.sender.on("did-start-navigation", onNavigation);
    send(current.sender, "crazyflie-connection", { status: "checking", ...connection });
    const cleanup = () => {
      current.sender.removeListener("destroyed", onDestroyed);
      current.sender.removeListener("render-process-gone", onDestroyed);
      current.sender.removeListener("did-start-navigation", onNavigation);
      if (owner === current) owner = null;
    };
    try {
      current.worker = startCrazyflieSession({
      pythonCmd: getPythonCandidates()[0], scriptPath: resolveChildPath("scripts", "crazyflie_session.py"),
      libPathHint: getCrazyflieLibPathHint(), connectionArgs: buildConnectionArgs(connection).args,
      onEvent: payload => {
        if (owner !== current) return;
        if (payload.type === "state") {
          current.status = payload.state === "flow" ? "ready" : payload.state;
          send(current.sender, "crazyflie-connection", {
            ...connection, status: payload.state === "flow" ? "ready" : payload.state,
            busy: payload.state === "flow", message: payload.message,
          });
        } else if (payload.type === "telemetry") {
          send(current.sender, "crazyflie-telemetry", payload.payload);
        } else if (payload.type === "attitude") {
          send(current.sender, "crazyflie-attitude", { ...payload.payload, source: "idle" });
        } else if (payload.type === "mapping") {
          send(current.sender, "crazyflie-mapping", payload.payload);
        } else if (payload.type === "log") {
          if (payload.line.startsWith("__ATTITUDE__:")) {
            const attitude = parseJsonOutput(payload.line.slice(13));
            if (attitude) send(current.sender, "crazyflie-attitude", { ...attitude, source: "flow" });
          } else if (!payload.line.startsWith("__TELEM__:")) {
            const step = /^__STEP__:(\d+)\/(\d+):(.+)$/.exec(payload.line);
            const line = step && operation?.stepTotal
              ? `__STEP__:${Number(step[1]) + (operation.stepOffset || 0)}/${operation.stepTotal}:${step[3]}`
              : payload.line;
            send(current.sender, "crazyflie-flow-log", { source: "stdout", line });
          }
        }
      },
        onClose: cleanup,
      });
      await current.worker.ready;
      return current;
    } catch (error) {
      if (!current.worker) cleanup();
      throw error;
    }
  };
  const exclusive = async (event, action, run) => {
    const blocked = busy(event.sender);
    if (blocked) return blocked;
    const current = { senderId: event.sender.id, action, cancelled: false };
    operation = current;
    const onDestroyed = () => {
      current.cancelled = true;
      try { current.cancel?.(); }
      catch (error) { console.error("Crazyflie operation cancellation failed:", error); }
      if (owner?.sender.id === event.sender.id) {
        void closeOwner(owner).catch(error => console.error("Crazyflie session cleanup failed:", error));
      }
    };
    const onNavigation = (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) onDestroyed();
    };
    event.sender.once("destroyed", onDestroyed);
    event.sender.once("render-process-gone", onDestroyed);
    event.sender.on("did-start-navigation", onNavigation);
    try { return await run(); }
    catch (error) { return failure(error); }
    finally {
      event.sender.removeListener("destroyed", onDestroyed);
      event.sender.removeListener("render-process-gone", onDestroyed);
      event.sender.removeListener("did-start-navigation", onNavigation);
      operation = null;
    }
  };

  ipcMain.handle("crazyflie-list-interfaces", async () => {
    try { return { success: true, radios: await listInterfaces() }; }
    catch (error) { return failure(error); }
  });
  ipcMain.handle("crazyflie-connect", (event, options = {}) => exclusive(event, "connect", async () => {
    const current = await ensureConnection(event, options);
    if (operation.cancelled) return failure(new Error("Connection cancelled"));
    return { success: true, ...current.connection };
  }));
  ipcMain.handle("crazyflie-disconnect", async event => {
    const blocked = busy(event.sender);
    if (blocked) return blocked;
    await closeOwner(owner);
    return { success: true };
  });
  ipcMain.handle("crazyflie-connection-state", event => owner?.sender.id === event.sender.id
    ? { ...owner.connection, status: owner.status, busy: owner.worker.running }
    : { status: "disconnected" });
  ipcMain.handle("crazyflie-start-attitude", async (event, options = {}) => {
    if (owner?.sender.id === event.sender.id && operation?.action === "flow") {
      return { success: false, message: "Enable idle attitude display after the flight finishes" };
    }
    return exclusive(event, "observe", async () => {
      const current = await ensureConnection(event, options);
      if (current.observing) return { success: true };
      const result = await current.worker.request("observe", { enabled: true });
      if (result.success) current.observing = true;
      return result;
    });
  });
  ipcMain.handle("crazyflie-stop-attitude", async event => {
    if (owner && owner.sender.id !== event.sender.id) return failure(new Error("The connection belongs to another window"));
    if (!owner) return { success: true };
    const result = await owner.worker.request("observe", { enabled: false });
    if (result.success && owner) owner.observing = false;
    return result;
  });
  ipcMain.handle("crazyflie-mapping-control", async (event, options = {}) => {
    if (typeof options.enabled !== "boolean") return failure(new Error("Invalid mapping control"));
    if (!owner || owner.sender.id !== event.sender.id || owner.status !== "ready") {
      return failure(new Error("Connect this window to the aircraft before starting read-only mapping"));
    }
    try { return await owner.worker.request("mapping", { enabled: options.enabled }); }
    catch (error) { return failure(error); }
  });
  ipcMain.handle("crazyflie-test-link", (event, options = {}) => exclusive(event, "test", async () => {
    if (owner) return { success: true, message: "Crazyflie is connected", links: [owner.connection.uri] };
    return testLink(options);
  }));
  ipcMain.handle("crazyflie-run-flow", (event, options = {}) => exclusive(event, "flow", async () => {
    const code = String(options.code || "");
    const needsAircraft = /cf_(?:crazyflie_link|test_crazyflie_link|motion|takeoff|land|move|motor_ramp_test|detect_|mr_|led_ring_|buzzer_)/.test(code);
    if (!needsAircraft && !owner) {
      return runFlowStream(event, options, payload => send(event.sender, "crazyflie-attitude", payload),
        child => { operation.cancel = () => child.stdin.writable && child.stdin.write("stop\n"); });
    }
    const lines = code.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
    operation.stepTotal = lines.length;
    let remaining = code;
    let prefixResult = null;
    if (/cf_scan_links\s*\(/.test(code)) {
      if (owner) throw new Error("Disconnect the aircraft before scanning the wireless transceiver");
      let prefixLength = 0;
      while (prefixLength < lines.length && /^cf_(?:set_link|test_link|scan_links)\s*\(/.test(lines[prefixLength])) prefixLength++;
      if (lines.slice(prefixLength).some(line => /^cf_scan_links\s*\(/.test(line))) throw new Error("Place scans before connecting");
      prefixResult = await runFlowStream(event, { ...options, code: lines.slice(0, prefixLength).join("\n"),
        stepTotal: lines.length }, () => {}, child => {
        operation.cancel = () => child.stdin.writable && child.stdin.write("stop\n");
      });
      if (!prefixResult.success) return prefixResult;
      if (operation.cancelled) return failure(new Error("Flow cancelled after radio scanning"));
      operation.stepOffset = prefixLength;
      remaining = lines.slice(prefixLength).join("\n");
    }
    const current = await ensureConnection(event, options);
    if (operation.cancelled) return failure(new Error("Flow cancelled before execution"));
    const radios = await listInterfaces();
    remaining = remaining.replace(/cf_set_link\s*\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3\s*\)/g,
      (_call, _quote, uri, _quote2, addressHex) => {
        const configured = canonicalConnection({ uri, addressHex }, radios);
        if (configured.uri !== current.connection.uri) throw new Error("Block connection settings do not match the connected aircraft");
        return `cf_set_link(${JSON.stringify(configured.uri)}, ${JSON.stringify(configured.addressHex)})`;
      });
    operation.cancel = () => current.worker.cancel();
    const result = await current.worker.request("run", { code: remaining, followPosition: options.followPosition,
      timeoutMs: options.timeoutMs });
    return { ...result, connected: owner === current && current.status === "ready", ...current.connection,
      executed: [...(prefixResult?.executed || []), ...(result.executed || [])] };
  }));
  ipcMain.handle("crazyflie-cancel-flow", event => {
    if (!operation || operation.action !== "flow" || operation.senderId !== event.sender.id) {
      return failure(new Error("No flight owned by this window is running"));
    }
    operation.cancelled = true;
    try {
      if (operation.cancel) operation.cancel();
      else if (owner) void owner.worker.stop();
      return { success: true };
    } catch (error) { return failure(error); }
  });
  ipcMain.handle("crazyflie-list-radios", async () => {
    try { return await listRadios(); }
    catch (error) { return { ...failure(error), radios: [] }; }
  });
}

module.exports = {
  registerCrazyflieHandlers,
};
