# RobotSTEM

<img src="./public/robotstem.svg" width="96" height="96" alt="RobotSTEM" />

[中文](./README_ZH.md) | English

**AI-assisted programming for open-source machines. Bring code into the physical world.**

RobotSTEM is a desktop programming platform for open-source machines and robots, bringing together Blockly, 3D simulation, real-device control and AI assistance. It is built for STEM learning, classroom exploration and physical-world prototyping, with a long-term direction that spans different kinds of machines.

**Crazyflie is the first machine integrated with RobotSTEM, not the boundary of the platform.** More machines will be added over time, including open-source rovers and robot arms. These are examples of future directions, not an exhaustive device list or a claim of existing support. The product centers on machines and their interactions with the physical world, rather than a general-purpose Arduino or ESP32 board catalog.

## Platform Capabilities

| Capability | Available now |
| --- | --- |
| Visual programming | Express program logic with Blockly, including loops, conditions, math, text, time and variables. |
| AI assistance | Discuss programs, get programming help, select models and configure custom models. Review generated content before running it. |
| Projects and accounts | Manage local projects and dependencies, with account login, cloud projects and cloud templates. |
| Physical-world workflow | Work with programming, simulated feedback and device interaction in one application. Available controls depend on the implemented machine integration. |

Account, AI and cloud features depend on their services and your account/model configuration. As the platform expands, additional machine integrations will bring their own controls, simulated environments and interaction methods.

## First Machine Example: Crazyflie

Crazyflie is the first available machine integration and an example of how RobotSTEM connects programming with the physical world. The following screenshot and features describe this integration, not the limits of the platform.

![RobotSTEM's first machine example: Crazyflie in the Blockly editor and classroom simulator](./img/robotstem-crazyflie.png)

*Current platform example: Crazyflie block categories, a 3D classroom and an aircraft attitude preview. The screenshot shows simulation mode with no real aircraft connected.*

| Crazyflie feature | Current implementation |
| --- | --- |
| Movement programming | Build programs with Crazyflie movement blocks alongside the shared basic blocks. |
| 3D exploration | Use classroom, home and themed scenes, offline China/world maps, exploration tasks, camera controls and flight-path visualization. |
| Simulation and real devices | Choose simulation, real flight, or a real flight accompanied by a telemetry-driven 3D view. |
| Hardware and decks | Configure Crazyradio connections, inspect link/battery status and use adapted Flow, Multiranger, LED-ring and buzzer blocks. Hardware features require the corresponding decks. |

This example's simulator does not require Python, Crazyradio or an aircraft.

## Machine Integration

| Machine / device | Status |
| --- | --- |
| Crazyflie / Crazyradio | First integration, available now; real-device operation uses Python and cflib. Motion requires suitable positioning, such as a Flow deck. |
| Open-source rovers | Future integration example; no selectable device adapter yet. |
| Open-source robot arms | Future integration example; no selectable device adapter yet. |
| Other open-source machines | Further expansion direction; no support is implied before an adapter is implemented. |

New projects, device switching and the AI device catalog use the bundled Crazyflie catalog. Retained compatibility code does not mean other development boards are supported by this branch.

## Current Crazyflie Run Modes

| Mode | Behavior |
| --- | --- |
| Simulation (default) | Runs in the simulator without sending real-device control commands. |
| Real flight | Executes commands through Python/cflib after you explicitly select the mode and start the program. |
| Simulation + real | Executes real-device commands and updates the 3D view from real telemetry; this is not a simulation-first approval gate. |

**Safety:** Start with simulation. Before real operation, check the link, battery, positioning and clear space. Self-test and motor-test blocks can spin motors: remove propellers before testing. Simulation and AI output do not establish that a flight is safe; this is not a safety-certified flight-control system.

Crazyflie programs run from the desktop application through Python/cflib. They are not compiled into standalone aircraft firmware, and running a project does not automatically flash firmware.

## Quick Start

The following commands use **Windows PowerShell**. Install Node.js, npm and Git first.

```powershell
git clone --branch RobotSTEM https://github.com/bitdeckai/aily-blockly.git
Set-Location aily-blockly
npm install
npm install --prefix electron
npm run electron
```

Keep the terminal open while using the development application. This command starts the Angular development server, waits for port 4200, and opens Electron. A browser-only preview does not provide desktop hardware IPC.

**Try the first machine integration (Crazyflie):**

1. Create a project and select **Crazyflie**.
2. Add blocks or choose a built-in example such as self-test, hover, back-and-forth or a square route.
3. Keep **Simulation** selected and click **Run**.
4. Observe the 3D scene, path and execution log before considering real-device operation.

### Optional: Real Hardware

Install Python 3.10 or later and cflib in the interpreter used by the app:

```powershell
py -3 -m pip install --upgrade cflib
py -3 -c "import cflib; print(cflib.__file__)"
```

Connect Crazyradio, configure a compatible USB driver, and check the aircraft URI/address. See the [Crazyflie setup, safety notes and troubleshooting guide](./README_crazyflie.MD) before real operation.

## Development and Builds

| Command | Purpose |
| --- | --- |
| `npm run electron` | Compile and run the complete desktop development app. |
| `npm run start` | Start the Angular frontend only. |
| `npm run ng -- build --configuration development` | Build the frontend without starting Electron or making an installer. |
| `npm run build` | Build the production frontend and package the desktop application. |

For the full regression suite, Python 3 must also be available. In PowerShell:

```powershell
$tests = Get-ChildItem .\scripts -Filter 'test-*.cjs' -File
node --test $tests.FullName
```

These regressions do not perform real flights. Build-channel and platform details are in the [Crazyflie development guide](./README_crazyflie.MD) and [general development notes](./develop.md).

## Compatibility and Roadmap

- **Preserved:** account login, AI/model configuration, cloud features, existing user data and legacy project loading.
- **Intentional identifiers:** `.abi`, OAuth callbacks, `@aily-project` package names and some internal paths remain unchanged to avoid breaking existing data and services.
- **Updates:** the upstream automatic updater is disabled until RobotSTEM has an independent update source.
- **Platform direction:** expand from the first Crazyflie integration to more open-source machines. Rovers and robot arms are examples, not the limits of the roadmap.
- **Next:** progressively adapt programming, simulation and real-device interaction for additional machine types, while decoupling shared legacy toolchains without discarding working compatibility.

## Documentation and Feedback

- [Chinese introduction](./README_ZH.md)
- [Crazyflie development, simulation and troubleshooting](./README_crazyflie.MD) (Chinese)
- [General development notes](./develop.md) (upstream reference; some sections describe the original platform)
- [Issues](https://github.com/bitdeckai/aily-blockly/issues)
- [Official Crazyflie documentation](https://www.bitcraze.io/documentation/)

When reporting a problem, include your operating system, reproduction steps and sanitized logs. Suggestions for other machine integrations, interaction methods and teaching scenarios are welcome. Do not upload account credentials or model API keys.

## Open Source and Acknowledgements

RobotSTEM is based on [ailyProject/aily-blockly](https://github.com/ailyProject/aily-blockly). Original copyright, license, sponsor attribution and service notices are retained. See [LICENSE](./LICENSE) for GPL-3.0 and the upstream additional rights statement below.

Core technologies include [Electron](https://github.com/electron/electron), [Angular](https://github.com/angular/angular), [Blockly](https://github.com/google/blockly), [Three.js](https://github.com/mrdoob/three.js), [Node.js](https://github.com/nodejs/node) and [cflib](https://github.com/bitcraze/crazyflie-lib-python). Retained tooling also includes [7z](https://github.com/sparanoid/7z) and [probe-rs](https://github.com/probe-rs/probe-rs). AI functionality references [Kode](https://github.com/shareAI-lab/Kode-cli) and [Copilot](https://github.com/microsoft/vscode-copilot-chat). See [package.json](./package.json) and [Electron dependencies](./electron/package.json) for further dependencies.

## Additional Rights Statement  
1. This software is free software under the GPL license. Without authorization, the sale of this software or derivative software based on this software is prohibited.
2. Hardware works developed using this software are not restricted by the GPL, and users may decide on their own release and usage methods.
3. For derivatives based on this software, information about relevant rights holders and sponsors of this project must not be removed, and such information must appear on the software startup page.
4. Without authorization, the online service content and user agreement attached to this project must not be removed.

## Upstream Sponsor Attribution

The following sponsor credits are retained from the upstream project; they do not imply sponsorship or endorsement of this independent RobotSTEM branch.

### Corporate Sponsors

<table>
  <tr>
    <td><a target="_blank" href="https://www.seeedstudio.com/"><img src="./public/sponsor/seeedstudio/logo-light.webp" alt="seeedstudio" width="200" /></a></td>
    <td><a target="_blank" href="https://www.seekfree.cn/"><img src="./public/sponsor/seekfree/logo-light.webp" alt="seekfree" width="200" /></a></td>
    <td><a target="_blank" href="https://www.diandeng.tech/"><img src="./public/sponsor/diandeng/logo-light.webp" alt="diandeng" width="200" /></a></td>
    <td><a target="_blank" href="https://www.openjumper.com/"><img src="./public/sponsor/openjumper/logo.webp" alt="openjumper" width="200" /></a></td>
  </tr>
  <tr>
    <td><a target="_blank" href="https://www.pdmicro.cn/"><img src="./public/sponsor/pengde/logo.webp" alt="pengde" width="200" /></a></td>
    <td><a target="_blank" href="https://www.titlab.cn/"><img src="./public/sponsor/titlab/logo-light.webp" alt="titlab" width="200" /></a></td>
    <td><a target="_blank" href="https://www.emakefun.com"><img src="./public/sponsor/emakefun/logo-light.webp" alt="emakefun" width="200" /></a></td>
    <td><a target="_blank" href="http://www.keyes-robot.com/"><img src="./public/sponsor/keyes/logo-light.webp" alt="keyes" width="200" /></a></td>
  </tr>
</table>

### Individual Sponsors

Tao Dong (Tianwei Electronics) | Xia Qing (Mushroom Cloud Maker Space) | Du Zhongzhong Dzz (Community Partner) | Li Duan (Yixuehui) | Sun Junjie (Community Partner)

### Technical Sponsors

<table>
  <tr>
    <td><a href="https://signpath.io/"><img src="https://signpath.org/assets/favicon-50x50.png" alt="SignPath" width="32" /></a></td>
    <td>Free code signing on Windows provided by <a href="https://signpath.io/">SignPath.io</a>, certificate by <a href="https://signpath.org/">SignPath Foundation</a></td>
  </tr>
</table>