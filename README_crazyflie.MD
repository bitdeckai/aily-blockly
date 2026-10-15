# Crazyflie 开发与启动说明

本文档用于说明在 aily-blockly 项目中，如何编译、启动并验证 Crazyflie 相关功能。

> 这里的“编译”指编译 aily-blockly 应用。Crazyflie 积木程序由电脑上的 Electron 应用通过 Python/cflib 实时发送控制命令，不会在这里编译成可脱离电脑运行的 Crazyflie 固件，也不会自动刷写固件。

## 快速开始（Windows）

在仓库根目录打开 PowerShell。依赖已经安装好时，只需运行这一条命令：

```powershell
npm run electron
```

第一次运行时，先安装项目和 Electron 依赖，再启动：

```powershell
npm install
npm install --prefix electron
npm run electron
```

模拟器不需要 Python/cflib。若要连接真机，在首次启动前额外安装 cflib 到应用将调用的 Python 环境：

```powershell
py -3 -m pip install --upgrade cflib
py -3 -c "import cflib; print(cflib.__file__)"
```

保持启动命令对应的终端运行。需要制作 Windows 安装包时，改用 `npm run build`；这不是日常开发启动命令。

## 1. 适用范围

- 项目仓库：aily-blockly
- Crazyflie 运行链路：Electron 调用 Python 脚本
- 关键脚本：child/scripts/crazyflie_link_test.py、child/scripts/crazyflie_run_flow.py

## 2. 环境准备

### 2.1 Node.js 与 npm

建议使用项目当前依赖兼容的 Node 版本（项目内包含 child/node 方案，也可使用系统 Node）。

### 2.2 Python

建议安装 Python 3.10 或以上。Windows 下可先用 `py -3 --version` 确认 Python Launcher 能找到 Python 3。

Electron 会优先使用 `PYTHON` 环境变量，其次尝试 Windows Python Launcher（`py -3`）和 `python`。如果机器上有多个 Python，请确保 cflib 安装在实际被 Electron 选中的那个解释器中。也可以在启动应用前指定解释器：

```powershell
$env:PYTHON = "C:\Path\To\Python\python.exe"
py -3 -m pip install --upgrade cflib
```

### 2.3 Crazyflie Python 依赖

在应用会使用的 Python 环境中安装 cflib：

```powershell
py -3 -m pip install --upgrade cflib
```

如果你使用本地 `crazyflie-lib-python` 源码，在启动应用前设置环境变量（路径指向包含 `cflib` 目录的仓库根目录）：

```powershell
$env:CRAZYFLIE_LIB_PATH = "E:\path\to\crazyflie-lib-python"
npm run electron
```

说明：当前实现优先使用 Python 环境中已安装的 cflib；只有显式设置 CRAZYFLIE_LIB_PATH 时才使用本地源码路径。

### 2.4 Crazyradio 与系统驱动

- 确认 Crazyradio 已连接
- Windows 下确保驱动正常（例如通过 Zadig 安装为 libusb-win32/WinUSB，按你现有环境实践）

## 3. 安装项目依赖

在仓库根目录执行：

npm i

进入 electron 子目录执行：

cd electron
npm i

返回根目录：

cd ..

## 4. 开发模式启动

### 4.1 仅启动前端（Angular）

```powershell
npm run start
```

默认在 `http://localhost:4200/` 启动页面。此方式只启动前端，不会启动 Electron 主进程；Crazyflie 真机 IPC 功能请使用完整桌面应用。

### 4.2 启动完整桌面应用（推荐 Crazyflie 调试）

```powershell
npm run electron
```

此命令会并行启动：
- Angular dev server
- Electron 主进程（并等待 4200 就绪）

此命令会编译 Angular 开发版、启动本地服务，并在服务就绪后打开 Electron。Crazyflie 的链路测试与流程执行由 Electron 调用 Python/cflib 完成。开发服务保持运行时，修改前端代码会自动重新编译。

## 5. 编译与打包

### 5.1 标准打包

```powershell
npm run build
```

流程是先执行 Angular 生产构建，再由 electron-builder 制作桌面安装包。Windows 构建产物写入 `dist/aily-blockly/`。这一步用于分发安装包；本地调试请用 `npm run electron`。

### 5.2 区域/渠道打包

- npm run build:cn
- npm run build:global

### 5.3 macOS 打包

- npm run build:mac
- npm run build:mac:universal

## 6. Crazyflie 功能验证步骤

建议按以下顺序验证：

1. 启动 Electron：`npm run electron`。
2. 打开或创建使用 Crazyflie 开发板的工程，搭建并保存飞行积木程序。
3. 点击顶部立方体按钮显示/隐藏 3D 模拟区，再点击模拟按钮运行仿真；此模式不会连接或操作真机。
4. 真机运行前，连接 Crazyradio 和 Crazyflie，并先运行链路测试积木确认无线链路正常。
5. 点击顶部“实飞”按钮仅控制真机；“模拟+实飞”按钮会同时运行两条路径。
6. 查看应用日志和模拟器状态，确认程序执行结果。

首次测试请先做链路测试，不要直接起飞。真机飞行时请使用安全、空旷的区域并确保电池充足；电机测试积木会驱动电机，使用前应移除螺旋桨。

如果链路测试失败，优先检查：
- Python 是否可执行
- cflib 是否安装
- Crazyradio 驱动与连接状态

## 7. 常见问题

### 7.1 提示 Cannot run Python

原因：Electron 未找到可用 Python 命令。

处理：
- 在终端确认 py 或 python 可执行
- 确认 PATH 中有对应解释器
- 重启应用后重试

### 7.2 提示 Cannot locate crazyflie-lib-python (cflib)

原因：当前 Python 环境没有可用 cflib。

处理：
- 执行 pip install cflib
- 或设置 CRAZYFLIE_LIB_PATH 指向本地 crazyflie-lib-python

### 7.3 链路测试失败但 Python 正常

优先排查：
- Crazyradio 驱动
- USB 连接稳定性
- URI 与地址参数（默认 radio://0/80/2M，E7E7E7E7E7）

请注意，`radio://0/80/2M` 和地址 `E7E7E7E7E7` 是默认连接参数；若你的 Crazyradio/Crazyflie 使用不同配置，请在工程或连接参数中使用对应值。

## 8. 关键命令速查

- 安装根目录依赖：`npm install`
- 安装 Electron 运行依赖：`Push-Location electron; npm install; Pop-Location`
- 安装 cflib：`py -3 -m pip install --upgrade cflib`
- 启动前端：`npm run start`
- 编译并启动桌面开发版：`npm run electron`
- 编译并制作安装包：`npm run build`

## 9. 相关文件

- package.json（脚本入口）
- develop.md（开发与打包通用说明）
- electron/crazyflie.js（Python 调用与 IPC）
- child/scripts/crazyflie_link_test.py（链路测试）
- child/scripts/crazyflie_run_flow.py（流程执行）
