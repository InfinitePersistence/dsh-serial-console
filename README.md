# DSH Serial Console

用户与 AI 模型共享同一个可审计的嵌入式串口会话。~~（D指导，我不想再复制粘贴了，你直接干活吧）~~

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

DSH Serial Console 是一个面向 DeepSeek Harness 的社区串口控制台项目。它把人工终端操作、模型工具调用、板卡输出和会话记录汇集在同一个控制台中，适用于 Linux 开发板、U-Boot、MCU Shell、AT 指令设备和其他串口调试场景。

> 本项目由社区独立维护，不代表 DeepSeek 官方产品或官方背书。

## 可以用它做什么

- 在浏览器中查看板卡启动日志和实时串口输出。
- 使用键盘直接操作设备，包括 Tab 补全、方向键、退格、粘贴、输入法和常用终端控制键。
- 选择串口、波特率和 CR、LF、CRLF 等行尾模式。
- 让 DeepSeek 模型与用户操作同一个串口，而不是分别占用设备。
- 让模型发现端口、建立连接、发送命令、读取输出、等待特定内容和添加审计标记。
- 在 Text 与 HEX 视图之间切换，兼顾命令行操作和原始字节排查。
- 导出会话事件，并保留独立的串口审计记录。

## 终端体验

Text 模式提供真实的 VT 终端交互。板卡返回的提示符、ANSI 颜色、光标移动和同行刷新会直接呈现在当前终端画面中。

文本框选使用终端前景色与背景色反转，选区文字保持清晰可读；切换焦点后选区会变暗，但不会变成遮住内容的实色块。

终端左侧提供独立来源标记：

| 标记 | 来源 |
|---|---|
| `U` | 用户输入 |
| `M` | 模型输入 |
| `B` | 板卡输出 |
| `S` | 连接状态、错误或审计标记 |

这些标记只属于界面展示，不会写入串口数据或改变板卡收到的命令。正在输入的最底部逻辑行不显示标签，避免板卡回显过程中来源来回跳变。RX 完成的历史行默认标记为 `B`；只有已提交的 TX 命令能与尚未归属的完成行精确匹配时，才升级为 `U` 或 `M`，同一行不会被多个快速命令重复认领。空回车不生成用户命令标签，物理 Enter 也只经过 xterm `onData` 这一条发送路径。切换视图时重放历史 RX 不会再次向板卡发送光标位置报告等终端自动响应。

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
- pnpm 11
- Windows 或 Linux 串口环境

### 获取并构建

从 npm 安装可复用包：

```bash
pnpm add @infinitepersistence/dsh-serial-console
```

包提供以下公开入口：

- `@infinitepersistence/dsh-serial-console/protocol`：共享串口协议类型与编解码。
- `@infinitepersistence/dsh-serial-console/serial`：Node.js Host 串口管理与审计能力。
- `@infinitepersistence/dsh-serial-console/client`：React 与 xterm.js 串口控制台。

从源码构建：

```bash
git clone https://github.com/InfinitePersistence/dsh-serial-console.git
cd dsh-serial-console
corepack enable
pnpm install
pnpm build
```

当前仓库主要提供可复用源码、React 控制台和 DeepSeek Harness 接入示例，不是一个双击即可运行的独立桌面应用。Harness 集成说明见 [`integration/deepseek-harness/`](./integration/deepseek-harness/README.md)。

## 当前状态

项目目前处于 `0.1.0-alpha` 阶段，主要能力已经具备，但仍建议在非关键设备上验证后再用于生产调试。

当前限制：

- 一次只管理一个活动物理串口。
- 暂不自动重连，也不会在重连后自动重放命令。
- 当前 Text 模式依赖板卡回显；关闭 Shell echo 时不会显示用户正在键入的字符。
- 用户与模型共享发送队列，但尚未提供整条命令级别的输入租约。
- 实时画面目前使用短轮询更新，极端网络环境下可能感受到轻微延迟；无新事件且连接元数据未变化的轮询不会重复发布浏览器状态。
- 来源 gutter 的历史行归属属于辅助展示，原始审计事件才是权威记录。
- 多板卡管理、稳定 USB 身份绑定和审计完整性增强仍在规划中。

## 项目文档

- [架构与设计边界](./docs/ARCHITECTURE.md)
- [DeepSeek Harness 接入示例](./integration/deepseek-harness/README.md)
- [第三方许可证](./THIRD_PARTY_NOTICES.md)

## 参与贡献

欢迎通过 Issue 报告设备兼容性、终端行为和 Harness 接入问题，也欢迎提交 Pull Request。涉及真实设备的反馈，请提供必要的复现条件，但不要上传串口凭据、访问令牌、私有固件、设备序列号或包含敏感信息的完整日志。

## 许可证

本项目采用 [MIT License](./LICENSE)。第三方组件的许可证信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
