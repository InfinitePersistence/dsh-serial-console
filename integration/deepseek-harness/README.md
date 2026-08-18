# DeepSeek Harness integration blueprint

基准源码：DeepSeek Harness `0.1.0-rc.5`，提交 `47f943859bef60e4160492346772ded9b24f765a`。

本目录不是可独立编译的第二份插件实现。它记录把本工作区迁入 Harness monorepo 时应创建的包和装配关系；可复用实现仍以 `src/` 为事实来源。

## 推荐的 Harness 包

```text
packages/serial/serial/                 Host service + Typert Remote
packages/serial/tool-serial/            Model-facing tools
packages/api/serial-remotes/            Mount generated Remote contribution
packages/client/ui-serial/              Browser Serial Console
packages/bundle/serial-console/         Optional patch bundle
```

职责必须拆开：

- `serial`：Host plane 的进程单例，唯一可以构造 `SerialPort` 的包。
- `tool-serial`：agent preset Consumer，只读 `ctx.serialConsole`，绝不创建 transport。
- `serial-remotes`：Client 启动时显式 `ctx.remote.$mount(serialRemote)`；Host decorator 不会被浏览器自动发现。
- `ui-serial`：`dsh.client` 模块，适配生成的 Remote，注册 UI。
- `serial-console` bundle：插入 Host service 和 Client roster；模型工具插入具体 agent preset。

## Host service

Service 应继承 `TypertRemoteService`，namespace 使用 `serialConsole`。所有 `@Remote` 方法使用一个必需 request object，即使 request 为空；这有利于稳定生成 codec。

建议 Remote：

```ts
listPorts(request: {}): Promise<readonly SerialPortDescriptor[]>
connect(request: SerialOpenOptions): Promise<SerialSnapshot>
disconnect(request: {}): Promise<SerialSnapshot>
snapshot(request: SerialSnapshotRequest): SerialSnapshot
send(request: SerialSendRequest): Promise<SerialSendResult>
mark(request: { label: string; actor: SerialActor; toolCallId?: string }): SerialMarkerEvent
```

Host package `package.json` 必须公开生成入口：

```json
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client.d.ts", "default": "./lib/types/client.js" },
    "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
  }
}
```

生成的 Typert runtime codec 当前会引用 `zod`，Host package 必须像 `packages/goal/goal` 一样声明运行时依赖。

## Client Remote mount package

Host 加载带 `@Remote` 的 Service 并不意味着浏览器会自动发现它。先创建独立的 Remote mount Client package：

```ts
import type { Context } from '@deepseek-ai/cordis'
import serialRemote from '@community/dsh-serial-console/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'

export const inject = ['remote']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const dispose = await ctx.remote.$mount(serialRemote)
  return async () => { await dispose() }
}
```

它自身也要声明 `dsh.client`，依赖 `@deepseek-ai/dsh-api-gateway`，并设置 `immediately: true`。仅把 Host package 加入 Loader 或成为 bundle dependency，都不会自动把生成的 Remote contribution 挂到浏览器。

```json
{
  "dsh": {
    "client": {
      "inject": ["@deepseek-ai/dsh-api-gateway"],
      "platform": "web",
      "immediately": true
    }
  }
}
```

## Client UI package

`package.json` 至少包含：

```json
{
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@community/dsh-client-serial-remotes",
        "@deepseek-ai/dsh-client-ui-conversation"
      ],
      "platform": "web"
    }
  }
}
```

Client apply 的稳定初版入口：

```ts
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'serial-console',
  order: 20,
  label: 'Serial',
}, SerialConsoleView))
```

不要注册顶层 `details`。旁路抽屉使用 `shell.overlay`，这是 additive list slot；按钮可注册在 `sidebar.footer.action`。

生成的 `ctx.remote.serialConsole.*` 返回 `RemoteResult<T>`，Client adapter 必须显式解包 carrier failure，再传给 `SerialConsoleStore` 所需的直接 `Promise<T>` 接口。

## 为什么先轮询

Typert Remote 当前只支持 unary 方法。`api-remotes` 的 Host event 转发又由固定 allowlist 控制，外部包不能只靠类型声明自动增加 runtime forwarding。因此当前工作区使用 `snapshot(afterSeq)` 短轮询，不修改上游事件白名单。

接入后优先升级为可取消的有界 long-poll：`readBatch({ afterSeq, limit, waitMs }, signal)` 在有事件、超时、断线或 abort 时返回，Client 随即发起下一次调用。建议 `limit <= 200`、`waitMs <= 20_000`，并明确返回 `oldestSeq`/`dropped`。它仍是一请求一结果，符合 unary Remote 约定。

后续需要真正推送时，应先为 Harness 设计独立的增量数据协议/注册点，或向上游提交可扩展的 Host event selection；不能用一个永不返回的 Remote 方法伪造 stream。

## 装配示例

Host 和 Client roster patch 见 [cordis.patch.yml](./cordis.patch.yml)。模型工具应加入 `apps/cli/config/agent-presets/<preset>/agent.cordis.yml` 或用户自己的 preset：

```yaml
- id: tool-serial
  name: '@community/dsh-tool-serial'
```

## 构建顺序

在 `deepseek-harness` 根目录：

```powershell
pnpm install
pnpm run build:lib
pnpm run typecheck
pnpm run test -- packages/serial packages/client/ui-serial
```

`build:lib:host` 必须先运行：Typert 在 Host tsdown 中生成 `typert.host.*` 和 `typert.remote-client.*`；只运行 Client watcher 无法从 decorator 推导 Remote contract。

Web 联调：

```powershell
pnpm run build
pnpm dsh web
pnpm run dev:web
```

## 上游仓库约束

一旦把文件迁入 `deepseek-harness/packages`，先完整阅读根 `AGENTS.md`、`packages/AGENTS.md`、`packages/client/AGENTS.md` 和 `docs/AGENTS.md`。非平凡改动需要 Agent Note、测试、文档与相应快照；不要把此蓝图直接视为已经满足上游门禁。
