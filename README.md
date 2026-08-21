# DSH Serial Console

用户与 AI 模型共享同一个可审计的嵌入式串口会话。~~（D指导，我不想再复制粘贴了，你直接干活吧）~~

[![npm](https://img.shields.io/npm/v/%40infinitepersistence%2Fdsh-serial-console?label=npm)](https://www.npmjs.com/package/@infinitepersistence/dsh-serial-console)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

DSH Serial Console 是一个面向 DeepSeek Harness 的社区串口控制台项目。它把人工终端操作、模型工具调用、板卡输出和会话记录汇集在同一个控制台中，适用于 Linux 开发板、U-Boot、MCU Shell、AT 指令设备和其他串口调试场景。

> 本项目由社区独立维护，不代表 DeepSeek 官方产品或官方背书。

## 可以用它做什么

- 在浏览器中查看板卡启动日志和实时串口输出。
- 使用键盘直接操作设备，包括 Tab 补全、方向键、退格、粘贴、输入法和常用终端控制键。
- 选择串口、波特率和 CR、LF、CRLF 等行尾模式。
- 让 DeepSeek 模型与用户操作同一个串口，而不是分别占用设备。
- 让模型发现端口、建立连接、发送命令、读取输出、等待特定内容和添加审计标记。
- 在串口页右侧直接查看模型思考、工具进度和最终回复，无需来回切换会话标签。
- 在 Text 与 HEX 视图之间切换，兼顾命令行操作和原始字节排查。
- 导出会话事件，并保留独立的串口审计记录。

## 终端体验

Text 模式提供真实的 VT 终端交互。板卡返回的提示符、ANSI 颜色、光标移动和同行刷新会直接呈现在当前终端画面中。

在对话页与串口页之间切换时，控制台会从内存中的 xterm 检查点恢复终端画面、光标和来源标记，只增量处理离开后收到的事件；检查点不连续或事件窗口已截断时会自动回退到完整重建。

终端左侧提供独立来源标记：

| 标记 | 来源 |
|---|---|
| `U` | 用户输入 |
| `M` | 模型输入 |
| `B` | 板卡输出 |
| `S` | 连接状态、错误或审计标记 |

这些标记只属于界面展示，不会写入串口数据或改变板卡收到的命令。

串口页内置可折叠的 AI 浏览窗。桌面端默认显示在右侧，可拖动分隔线调整宽度；窄屏下自动改为覆盖式抽屉。浏览窗只读呈现当前 DSH 会话的实时思考、工具状态、最终回复和错误，并使用 DSH 原生 Markdown 渲染标题、列表、链接、代码块和公式；底部仍使用 DSH 原生输入栏。折叠浏览窗不会卸载 xterm，终端内容、光标和滚动位置保持不变；开关和宽度仅保存在本机浏览器中。

## 用户与模型协作

用户和模型看到的是同一个串口会话：

- 用户可以随时观察模型命令及板卡响应。
- 模型可以读取受限范围内的串口事件。
- 每次发送都会记录来源，便于区分人工操作和模型调用。
- 所有写入按顺序发送，避免单次请求之间相互越过。

项目提供以下模型能力：

| 工具 | 用途 |
|---|---|
| `serial_list_ports` | 枚举可用串口 |
| `serial_connect` | 连接设备 |
| `serial_send` | 发送文本或原始字节 |
| `serial_read` | 读取有界事件窗口 |
| `serial_expect` | 等待提示符或指定内容 |
| `serial_mark` | 标记关键证据位置 |
| `serial_disconnect` | 安全断开设备 |

## 可追溯性

- RX 与 TX 都保留原始字节，文本仅用于友好显示。
- 事件包含会话、顺序、时间和来源信息。
- 浏览器清空视图不会删除 Host 侧记录。
- 内存事件过期时会明确报告缺口。
- 审计记录可用于复查模型操作、人工命令和板卡响应的先后关系。

## 适用场景

- 嵌入式!
- Linux 开发板启动与登录控制台
- U-Boot 环境变量、启动流程和镜像调试
- MCU 命令行与固件诊断接口
- Modem、GNSS 和其他 AT 指令设备
- 自动化烧录后的启动检查
- 长时间串口日志采集与故障复盘
- AI 辅助硬件调试和远程协作

## 快速开始

### 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- DeepSeek Harness `0.1.0-rc.7`
- pnpm `11.22.0`
- Windows 或 Linux 串口环境

### 已有 DSH：一行安装并启用

项目发布在 [`@infinitepersistence/dsh-serial-console`](https://www.npmjs.com/package/@infinitepersistence/dsh-serial-console)。已经安装 DSH `0.1.0-rc.7` 的用户，可以用一条命令将插件安装到 `web` profile，并同时启用 Host、网页串口页和模型工具：

```powershell
dsh.cmd plugin --profile web add '@infinitepersistence/dsh-serial-console@0.1.0-rc.3' --save-exact
```

停止仍在运行的旧 Host 后，启动同一个 profile：

```powershell
dsh.cmd --profile web
```

`dsh.cmd web` 与 `dsh.cmd --profile web` 等价。安装和启动必须使用同一个 profile；升级后请重启 Host，并在浏览器中使用 `Ctrl+F5` 刷新页面。

### 全新 Windows：安装环境、DSH 与插件

在 PowerShell 中依次执行：

```powershell
# 基础环境
winget install --id Git.Git --exact --source winget --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
winget install --id Microsoft.VCRedist.2015+.x64 --exact --source winget --accept-package-agreements --accept-source-agreements

# 让当前 PowerShell 识别新安装的软件
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$machinePath;$userPath"

# 安装经过验证的 pnpm 与 DSH 版本
& npm.cmd install --global pnpm@11.22.0 '@deepseek-ai/dsh@0.1.0-rc.7'

# 定位全局 dsh 命令
$npmGlobal = (& npm.cmd prefix --global).Trim()
$dsh = Join-Path $npmGlobal 'dsh.cmd'
$env:Path = "$npmGlobal;$env:Path"

# 安装并启用串口插件
& $dsh plugin --profile web add '@infinitepersistence/dsh-serial-console@0.1.0-rc.3' --save-exact

# 启动 DSH Web
& $dsh --profile web
```

启动后访问 `http://127.0.0.1:3080`，进入任意对话并选择“串口”标签。`dsh plugin add` 与普通 `npm install`/`pnpm add` 不同：它会读取包内的 bundle 清单，将插件 patch 加入指定 profile，并在下次启动时自动挂载。插件携带 serialport 的官方多平台预编译二进制，无需从源码构建。

### Linux 与 macOS

确认 Node.js 与 DSH 版本满足上面的要求后执行：

```bash
dsh plugin --profile web add '@infinitepersistence/dsh-serial-console@0.1.0-rc.3' --save-exact
dsh --profile web
```

### 作为程序库安装

如果只是把控制台作为 React/Node.js 库嵌入自己的程序，可以使用：

```bash
pnpm add '@infinitepersistence/dsh-serial-console@0.1.0-rc.3' --save-exact
```

包提供以下公开入口：

- `@infinitepersistence/dsh-serial-console/protocol`：共享串口协议类型与编解码。
- `@infinitepersistence/dsh-serial-console/serial`：Node.js Host 串口管理与审计能力。
- `@infinitepersistence/dsh-serial-console`：DSH Host 串口服务。
- `@infinitepersistence/dsh-serial-console/tool`：模型串口工具插件。
- `@infinitepersistence/dsh-serial-console/client`：DSH Web 预构建客户端。
- `@infinitepersistence/dsh-serial-console/react`：可嵌入其他 React 应用的 xterm.js 控制台。

### 从源码构建

```bash
git clone https://github.com/InfinitePersistence/dsh-serial-console.git
cd dsh-serial-console
corepack enable
pnpm install
pnpm build
```

本项目是 DeepSeek Harness 的可安装组合插件，同时也提供可复用的协议、Node.js 串口核心和 React 控制台；它不是一个双击即可运行的独立桌面应用。

## 当前状态

项目目前处于 `0.1.0-rc.3` 候选阶段。该候选版为串口页内的可折叠 AI 浏览窗补齐 DSH 原生 Markdown 渲染；完成真机与 DSH Web 验证后，稳定版发布前只接受缺陷修复、兼容性改进和文档完善。

当前限制：

- 一次只管理一个活动物理串口。
- 暂不自动重连，也不会在重连后自动重放命令。
- 当前 Text 模式依赖板卡回显；关闭 Shell echo 时不会显示用户正在键入的字符。
- 用户与模型共享发送队列，但尚未提供整条命令级别的输入租约。
- 实时画面会在新的串口事件到达后及时刷新；连接旧版 Host 时会自动切换到兼容模式，无新事件且连接元数据未变化时不会重复刷新界面。
- 终端检查点仅保存在当前浏览器内存中；刷新页面、重载插件或事件出现缺口后会重新构建画面。
- 来源 gutter 的历史行归属属于辅助展示，原始审计事件才是权威记录。
- 多板卡管理、稳定 USB 身份绑定和审计完整性增强仍在规划中。

## 项目文档

- [架构与设计边界](./docs/ARCHITECTURE.md)
- [上游 Harness monorepo 拆包参考](./integration/deepseek-harness/README.md)
- [第三方许可证](./THIRD_PARTY_NOTICES.md)

## 参与贡献

欢迎通过 Issue 报告设备兼容性、终端行为和 Harness 接入问题，也欢迎提交 Pull Request。涉及真实设备的反馈，请提供必要的复现条件，但不要上传串口凭据、访问令牌、私有固件、设备序列号或包含敏感信息的完整日志。

## 许可证

本项目采用 [MIT License](./LICENSE)。第三方组件的许可证信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
