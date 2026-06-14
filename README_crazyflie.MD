# Crazyflie 开发与启动说明

本文档用于说明在 aily-blockly 项目中，如何编译、启动并验证 Crazyflie 相关功能。

## 1. 适用范围

- 项目仓库：aily-blockly
- Crazyflie 运行链路：Electron 调用 Python 脚本
- 关键脚本：child/scripts/crazyflie_link_test.py、child/scripts/crazyflie_run_flow.py

## 2. 环境准备

### 2.1 Node.js 与 npm

建议使用项目当前依赖兼容的 Node 版本（项目内包含 child/node 方案，也可使用系统 Node）。

### 2.2 Python

建议 Python 3.10 或以上。

必须保证命令可被 Electron 找到，常见可用命令包括：
- py
- python

### 2.3 Crazyflie Python 依赖

推荐在你使用的 Python 环境中安装 cflib：

pip install cflib

如果你使用本地 crazyflie-lib-python 源码，也可以通过环境变量指定：

CRAZYFLIE_LIB_PATH=你的 crazyflie-lib-python 路径

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

npm run start

默认会在 4200 端口启动页面。

### 4.2 启动完整桌面应用（推荐 Crazyflie 调试）

npm run electron

此命令会并行启动：
- Angular dev server
- Electron 主进程（并等待 4200 就绪）

Crazyflie 的链路测试与流程执行由 Electron 侧接口触发。

## 5. 编译与打包

### 5.1 标准打包

npm run build

流程是先执行 Angular 构建，再由 electron-builder 打包。

### 5.2 区域/渠道打包

- npm run build:cn
- npm run build:global

### 5.3 macOS 打包

- npm run build:mac
- npm run build:mac:universal

## 6. Crazyflie 功能验证步骤

建议按以下顺序验证：

1. 启动 Electron：npm run electron
2. 打开 Crazyflie 相关工程
3. 先执行链路测试积木（Test link）
4. 再执行基础流程（takeoff、move、land）
5. 观察 3D Simulator 与日志输出

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

## 8. 关键命令速查

- 安装依赖（根目录）：npm i
- 安装 Electron 依赖：cd electron && npm i
- 启动前端：npm run start
- 启动桌面应用：npm run electron
- 打包：npm run build

## 9. 相关文件

- package.json（脚本入口）
- develop.md（开发与打包通用说明）
- electron/crazyflie.js（Python 调用与 IPC）
- child/scripts/crazyflie_link_test.py（链路测试）
- child/scripts/crazyflie_run_flow.py（流程执行）
