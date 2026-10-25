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

## 10. Crazyflie 三维模型与 deck 外壳

### 基础积木

- Crazyflie 项目自动提供逻辑、循环、数学、文字、时间和变量六个基础分类，排在飞行器与扩展甲板分类前。新旧项目均在打开时加载，无需重新创建项目或额外安装 Arduino 核心库。
- 基础积木复用 Blockly 标准定义与 Python 生成器；时间分类提供可连接数值/计算结果的等待积木，文字分类的打印使用 Crazyflie 日志输出。
- 运行前，基础条件、循环、变量和表达式会展开成逐条飞行指令，模拟与实飞使用同一套展开规则。重复执行的积木会按实际指令顺序高亮。
- 当前基础流程只使用运行前可确定的数值和文字，不支持在条件或计算中读取实时甲板传感器；遇到此类积木会明确报错，不会忽略条件或执行两条分支。无穷循环、超过 10000 步的展开、零步长和无效数值也会在发送飞行指令前报错。
- 不提供未经适配的 Arduino I/O 引脚、硬件串口积木。其他板卡仍按原有依赖加载积木库，且不显示 Crazyflie 三维面板。
- 回归测试：`node --test scripts/test-crazyflie-basic-blocks.cjs`（需要 Python 3，用于校验实飞指令解析，不连接硬件）。

### 常用运动积木

Crazyflie 新旧项目打开后均自动提供“飞行运动 / Flight motion”分类，跟随现有 Crazyflie 中英文切换。所有数值输入都可连接数学、变量和表达式积木。

| 积木 | 参数及含义 |
| --- | --- |
| 起飞至指定高度 | 高度（米）、起飞速度（米/秒）；高度相对本次起飞位置，不是绝对世界坐标 |
| 按速度降落 | 降落速度（米/秒） |
| 按方向和速度移动 | 前、后、左、右、上、下；距离（米）、速度（米/秒） |
| 转向 | 左/右；角度（度）、角速度（度/秒） |
| 圆弧/绕圆 | 左/右；半径（米）、角度（度）、速度（米/秒）；360 度为整圆 |
| 三轴移动 | 当前机体坐标 X 向前、Y 向左、Z 向上，允许负数；速度为三维路径的合速度 |
| 悬停指定时间 | 秒；停止平移和转向，保持悬停 |
| 停止移动并悬停 | 不关闭电机，不等于紧急停机 |

- 对应本地 cflib `MotionCommander.take_off/land/move_distance/turn_left/turn_right/circle_left/circle_right/stop`。不使用 `HighLevelCommander.stop`，后者会关闭电机。
- 运动需可用的定位能力（例如 Flow deck），仿真不替代实际定位质量、净空和电量检查。使用顺序：连接飞行器 → 起飞 → 运动 → 降落。新运动流程会在发送前检查连接/起飞顺序、重复起飞和无效参数；旧飞行积木仍保留。
- 执行器不再因进入 MotionCommander 上下文而提前起飞，而是执行到起飞积木才起飞；结束或异常退出时仍调用降落清理。旧的无参数起飞使用 cflib 默认 0.3 米，仿真也以停机面为高度基准。
- 仿真按照当前航向计算前后左右和三轴位移，并展示转向、圆弧和高度变化。IPC 超时会在原有一分钟余量上计入新运动、悬停、等待与参数化降落的预计时间，避免正常长动作仍按固定一分钟被终止。
- 本批不新增遥测/实时传感器条件、参数写入、定位校准、固件升级或底层姿态/推力积木。新运动不能放进旧式实时测距分支；基础条件与循环仍按前述运行前展开规则执行。
- 回归测试覆盖全部运动 API 的模拟调用、完整 Python 执行器的无硬件连接替身、降落清理、三维轨迹、速度与取消。尚未在真实飞行器上验证新增运动。

### 三维视角控制

- 图标工具栏提供放大、缩小、适配整个场景、聚焦飞行器、左右旋转、俯仰、坐标轴开关和 PNG 截图。
- 右上角坐标导航随相机方向更新，可选择前、后、左、右、俯视、仰视及等轴视图；标准方向以当前飞行器航向为参考，观察中心保持不变。
- 左键拖动旋转，右键拖动平移，滚轮缩放。点击画布后可用 `+`/`-` 缩放、`Home` 全景适配、`F` 聚焦飞机、方向键旋转；不会拦截 Blockly 编辑区的按键。
- 飞行坐标为 X 向前（红）、Y 向左（绿）、Z 向上（蓝）。当前仿真零航向对应 Three.js 的 -X、+Z、+Y，坐标导航不直接使用 Three.js 的轴名。
- 这些操作只调整观察相机，不改变飞行器位置，不触发真机操作。

### 显示真实姿态

- 三维面板顶部提供默认关闭的“显示真实姿态”开关。开启后连接真机，并持续读取 `stabilizer.roll/pitch/yaw`，驱动模型和方向坐标旋转。无需运行积木；连接 URI 与地址可在面板底部“姿态连接设置”中修改。
- 空闲时使用只读监测连接，不发送解锁、电机或飞行指令。运行实飞流程或链路测试前先释放空闲连接；实飞流程使用自身的同一个连接订阅姿态，流程结束后恢复只读监测。交接需要重新连接，期间会显示等待数据，不能保证无间断。其他窗口不能同时占用该连接；外部 cfclient 等客户端须自行关闭。
- 运行中的实飞流程也可以开关姿态显示。流程连接会提供姿态流，但显示开关不启动、停止或改变飞行动作；姿态日志故障会明确显示，不因显示故障中断飞行流程。关闭面板、切换项目或重新加载窗口会释放空闲监测资源。
- **只同步姿态，不同步真实位置或轨迹。** 面板保留模拟位置，开启时明确标注；停止显示后恢复模拟姿态。沿用现有教室场景，不调整家具、相机或起降位置。停机坪使用浅蓝底、深蓝标记，以便辨认黑色机身。
- 目标采样周期为 50 ms（20 Hz），显示使用四元数和平滑插值，避免航向跨越 ±180° 时整圈翻转。面板显示接收频率、数据年龄和 RPY；超过 500 ms 无新样本标记过期并保持末次姿态。独立监测首次连接超过 15 秒、日志超过 1 秒无新数据会明确报错，可关闭开关后重试。
- 接收数据年龄不是无线端到端延迟。无硬件测试覆盖日志资源清理、同连接采样、等待期间持续更新、日志失败隔离、连接交接、运行中开关、模型旋转和数据过期。本地合成源只验证 Python 到 Electron 的消息传输，未验证真机无线延迟或实际飞行表现。
- 回归命令：`node --test scripts/test-crazyflie-attitude.cjs scripts/test-crazyflie-basic-blocks.cjs`。

### 模型资源

- 教室侧面室外空地设有篮球场：28 × 15 米彩色比赛区、外围缓冲区、中线、中圈、罚球区、三分线和两端篮架。篮球场不改变室内布局或飞行范围。
- 教室另一侧设有 18 × 24 米停车场：沥青地面、两排共 16 个停车位、挡车器、侧边路缘及 6 米宽双向车道，两端留出入口。停车场避开教室、树木和篮球场，仅为静态场景，不改变飞行范围。
- 教室室外陆地至少为 60 × 60 米，包含浅绿色草地和土壤基底；室外草地避开教室内部地板。陆地仅作为场景背景，不扩大模拟飞行范围，也不改变起降位置；随教室场景切换一同释放。
- 教室两侧窗外各放置三棵轻量几何树，树干和树冠均位于室外，与墙面保持距离；不改变室内摆设、飞行范围和起降位置。切换场景时随教室资源一同释放，无需额外下载树木模型。
- Three.js 使用 `public/models/crazyflie/cf2_assembly.dae` 和 `ccw_prop.dae`，来自本地 Webots R2025a 的 Crazyflie 模型目录；网格文件头标注 `Copyright (c) 2022 Bitcraze` 和 MIT License，许可正文保存在同目录 `LICENSE.txt`。
- 机体按原始米制比例加载，保留 DAE 中的独立装配部件；模拟器的“爆炸图”滑块只移动部件展示，不改变飞行坐标。四个独立桨叶仍随电机状态旋转。
- deck 检测状态由 `CrazyflieConnectionService.detectedDecks$` 提供，支持 Flow v2、Multiranger、LED-ring 和 Buzzer。外壳尚未随模型包提供；补充 GLB/GLTF 后，通过 `CrazyflieSimPanelComponent.registerDeckShellAsset(deck, url)` 注册即可按检测状态装卸。
- deck 外壳模型以米为单位、Y 轴朝上，根节点原点放在 Crazyflie 的 deck 安装点；每个 deck 外壳应独立提供文件，许可文件也应随资产保留。
- 教室场景复用了 Webots 的 Desk、WoodenChair、Blackboard 网格，以及 VarnishedPine、Parquetry、Roughcast 材质与纹理；静态资源位于 `public/models/classroom/`。
- Webots 家具网格由 Three.js 解析 PROTO 中的 IndexedFaceSet/UV，课桌以共享实例绘制；讲台、门窗、柜架和墙面装饰由独立分件几何构成。桌面高度为 0.74 m，Crazyflie 默认停放高度为 0.765 m。
