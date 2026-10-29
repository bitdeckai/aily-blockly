# RobotSTEM

<img src="public/robotstem.svg" width="96" height="96" alt="RobotSTEM" />

[English](README.md) | 中文

RobotSTEM 面向开源机器人编程。目前已适配 **Crazyflie**，提供积木编程、三维模拟和真机控制；开源小车、机械臂为后续适配方向，尚未作为可选设备开放。

本分支保留账户登录、云端工程、AI 助手、大模型选择和自定义模型配置。新建工程、设备切换及 AI 设备目录统一使用本地 Crazyflie 资源，不再展示通用开发板目录。共享工具链和底层兼容代码将在后续阶段解耦裁剪。

产品标题和安装包使用 RobotSTEM；用户数据目录、OAuth 回调、服务接口、`.abi` 关联和 `@aily-project` 包标识保留兼容。独立更新源配置完成前，原产品自动更新通道停用。

详见 [Crazyflie 使用与第一阶段范围](README_crazyflie.MD)。原作者版权、许可证、赞助归属及服务声明均予保留；以下保留的上游说明描述的是原通用开发平台，不代表当前设备支持范围。

## 上游项目原始说明

## 关于本软件
aily Project是一个硬件开发集成环境，计划集成诸多AI能力，帮助硬件开发者更畅快的进行开发。  
aily Blockly是aily Project下的blockly IDE，前期面向非专业用户提供AI辅助编程能力，长远目标是打破专业开发和非专业开发的界限，最终实现自然语言编程。  

<img src="./img/home.webp" />

> 我们以提供工业级别软件为目标，进行本项目的设计和开发，但本项目目前还处于alpha阶段，不建议用于量产设备固件开发，但当前版本用于原型验证、教育教学是完全没有问题的。  

## 当前版本亮点  
1. 工程化项目管理
使用npm进行项目管理，做到以项目为单位进行开发板和库的管理。解决了诸多传统嵌入式开发环境的工程化不足的问题。如，使用Arduino IDE可能出现board package、库和当前项目不匹配，造成编译失败，运行错误的问题。在本软件上，各项目中的开发板版本和库版本是独立的，项目间互不影响。
2. 库管理器
已有200多个常用扩展库，能满足大部分开发需求，且还在不断增加中。
3. 全能且小巧的串口调试工具
试图打造一个全能的串口工具，欢迎大家测试、反馈、提出新的想法。
4. AI项目生成
根据用户需求，自动分析项目，推荐开发板、模组、库，生成项目架构图、引脚连接图，并为用户创建出项目。
5. AI代码生成
根据用户需求，自动编写程序
6. AI转库
原生C/C++库都可以轻松转换成本软件使用的库。基于大模型的配置生成，开发过程中，如果想使用arduino库，但没有对应的blockly库，只用将arduino库提供给AI，AI自动分析，生成对应的blockly库。借助该功能，本软件可以成为blockly最多的开发平台。
7. AI开发板配置生成（完善中）  
基于大模型的配置生成，添加开发板时不用再纯手写新配置，只用提供开发板文档（md格式），AI自动分析，帮你生成开发板配置文件。（仅支持esp32、avr、renesas、rp2040、stm32为核心的开发板，因为编译器和核心sdk，还是需要我们提前准备的到仓库的，对于二进制程序，我们只能这样确保来源的安全性）
8. 闪电编译工具（一期已上线，二期还将提速！）
端云协同，闪电连编 将原本1小时的编译工作缩短到1分钟！  
9. 引脚图  
提供了一套漂亮的开发板引脚图查看方案。
10. 连线图（仿真器一期）  
AI可以根据用户程序和需求生成模组连线图，方便用户参考。


## 非正式版注意事项  
本次测试的alpha版本，仅保证最低限度的能用，很多计划的亮点功能还未完成设计和开发。
当前版本不建议实际用于工作，因为后期我们做出的诸多调整，可能会导致版本间的不兼容。

## 文档
[使用文档](https://aily.pro/doc)  
[库适配文档](https://github.com/ailyProject/aily-blockly-libraries/blob/main/%E5%BA%93%E8%A7%84%E8%8C%83.md)  
[软件开发文档](./develop.md)  

## 相关仓库
[开发板](https://github.com/ailyProject/aily-blockly-boards)  
[block库](https://github.com/ailyProject/aily-blockly-libraries)  
[编译器](https://github.com/ailyProject/aily-blockly-compilers)  
[相关工具](https://github.com/ailyProject/aily-project-tools)  

## 项目使用到的主要开源项目
[electron](https://github.com/electron/electron)本项目使用electron构建桌面程序  
[angular](https://github.com/angular/angular)本项目使用angular作为渲染端构建主要UI逻辑  
[node](https://github.com/nodejs/node)本项目使用npm和node进行包管理和执行必要脚本  
[7z](https://github.com/sparanoid/7z)本项目使用7z减小部分包的大小（如巨大的ESP32编译器）  
[probe-rs](https://github.com/probe-rs/probe-rs)本项目使用probe-rs调用daplink等调试器  
其他内容可见[package.json](./package.json)  

## 本项目AI功能参考了以下项目
[Kode](https://github.com/shareAI-lab/Kode-cli)  
[copilot](https://github.com/microsoft/vscode-copilot-chat)  

## 附加权利说明  
1. 本软件为GPL协议下的免费软件，在无授权的情况下，不得销售本软件及基于本软件的衍生软件；
2. 使用本软件开发的硬件作品不受GPL限制，用户可自行决定发布和使用方式；
3. 基于本软件的衍生品，不得移除本项目相关权利人、赞助者信息，且必须保证相关信息出现在软件启动页；
4. 在无授权的情况下，不得移除本项目附带的线上服务内容、及用户协议。

## 赞助

本项目由以下企业和个人赞助

### 企业赞助

<table>
  <tr>
    <td><a target="_blank" href="https://www.seeedstudio.com/"><img src=".\public\sponsor\seeedstudio\logo-light.webp" alt="seeedstudio" width="200" /></a></td>
    <td><a target="_blank" href="https://www.seekfree.cn/"><img src=".\public\sponsor\seekfree\logo-light.webp" alt="seekfree" width="200" /></a></td>
    <td><a target="_blank" href="https://www.diandeng.tech/"><img src=".\public\sponsor\diandeng\logo-light.webp" alt="diandeng" width="200" /></a></td>
    <td><a target="_blank" href="https://www.openjumper.com/"><img src=".\public\sponsor\openjumper\logo.webp" alt="openjumper" width="200" /></a></td>
  </tr>
  <tr>
    <td><a target="_blank" href="https://www.pdmicro.cn/"><img src=".\public\sponsor\pengde\logo.webp" alt="pengde" width="200" /></a></td>
    <td><a target="_blank" href="https://www.titlab.cn/"><img src=".\public\sponsor\titlab\logo-light.webp" alt="titlab" width="200" /></a></td>
    <td><a target="_blank" href="https://www.emakefun.com"><img src=".\public\sponsor\emakefun\logo-light.webp" alt="emakefun" width="200" /></a></td>
    <td><a target="_blank" href="http://www.keyes-robot.com/"><img src=".\public\sponsor\keyes\logo-light.webp" alt="keyes" width="200" /></a></td>
  </tr>
</table>

### 个人赞助

陶冬(天微电子) | 夏青(蘑菇云创客空间) | 杜忠忠Dzz(社区伙伴) | 李端(益学汇) | 孙俊杰(社区伙伴)

### 技术赞助

<table>
  <tr>
    <td><a href="https://signpath.io/"><img src="https://signpath.org/assets/favicon-50x50.png" alt="SignPath" width="32" /></a></td>
    <td>由 <a href="https://signpath.io/">SignPath.io</a> 提供 Windows 免费代码签名，证书由 <a href="https://signpath.org/">SignPath Foundation</a> 颁发</td>
  </tr>
</table>
