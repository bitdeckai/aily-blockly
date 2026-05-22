const { ipcMain } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

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

async function testLink(options = {}) {
  const timeoutMs = Number(options.timeoutMs || 4000);
  const scriptPath = resolveChildPath("scripts", "crazyflie_link_test.py");
  const libPathHint = getCrazyflieLibPathHint();

  const errors = [];
  for (const pythonCmd of getPythonCandidates()) {
    try {
      const { stdout, stderr } = await runScript(pythonCmd, scriptPath, timeoutMs, libPathHint);
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
  const uri = typeof options.uri === "string" && options.uri.trim() ? options.uri.trim() : "radio://0/80/2M";
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
        ["--uri", uri, "--code-base64", codeBase64],
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

function runScriptStream(pythonCmd, scriptPath, timeoutMs, libPathHint, extraArgs = [], includeTimeoutArg = true, onLine) {
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
    const child = spawn(pythonCmd, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutPending = "";
    let stderrPending = "";
    let timedOut = false;

    const emitLine = (source, line) => {
      if (!line) {
        return;
      }
      const text = String(line).trim();
      if (!text) {
        return;
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
      stdout += text;
      flushLines("stdout", text, false);
    });

    child.stderr.on("data", (chunk) => {
      const text = String(chunk || "");
      stderr += text;
      flushLines("stderr", text, false);
    });

    child.on("error", (error) => {
      reject({ error, stdout, stderr, pythonCmd, args });
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (_error) {
        // ignore kill errors
      }
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

async function runFlowStream(event, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 45000);
  const scriptPath = resolveChildPath("scripts", "crazyflie_run_flow.py");
  const libPathHint = getCrazyflieLibPathHint();
  const uri = typeof options.uri === "string" && options.uri.trim() ? options.uri.trim() : "radio://0/80/2M";
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
        ["--uri", uri, "--code-base64", codeBase64],
        false,
        ({ source, line }) => {
          const parsed = parseJsonOutput(line);
          if (parsed && typeof parsed === "object" && Object.prototype.hasOwnProperty.call(parsed, "success")) {
            return;
          }
          sendLog({ source, line });
        }
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

async function listRadios() {
  if (process.platform !== "win32") {
    return { success: true, radios: [] };
  }

  const psScript = [
    "$devices = Get-PnpDevice | Where-Object { $_.FriendlyName -like '*Crazyradio*' } | Select-Object FriendlyName, Status, Class, InstanceId",
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
        const radios = list
          .filter((item) => item && item.FriendlyName)
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
  ipcMain.handle("crazyflie-test-link", async (_event, options) => {
    try {
      return await testLink(options || {});
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
      return await runFlowStream(event, options || {});
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
