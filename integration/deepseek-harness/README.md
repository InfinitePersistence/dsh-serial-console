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
snapshot(request: SerialSnapshotRequest, signal?: AbortSignal): SerialSnapshot
waitSnapshot(request: SerialWaitSnapshotRequest, signal: AbortSignal): Promise<SerialSnapshot>
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

## 事件同步

Typert Remote 仍使用 unary 方法。新 Host 的普通快照包含可选的 `capabilities.waitSnapshot = 'v1'`；Client 每个 generation 先读取一次普通快照，只有看到该标记才使用可取消的 `waitSnapshot({ afterSeq, limit, waitMs }, signal)`。标记缺失时直接使用 150 ms 兼容轮询。默认等待 750 ms，Host 上限 1000 ms；`waitMs = 0` 立即返回，但自动同步仍按兼容轮询间隔节流。积压数据使用普通 `snapshot()` 串行排空，追平后恢复等待。

`snapshot()` 和 `waitSnapshot()` 的 Client 描述都应配置 `cancellation: { parameter: 'signal' }`，以便浏览器取消网络请求；长轮询的 signal 还会交给 Host 清理 listener 和 timer。当前 Gateway 会把多类 Host 和 carrier 错误统一转换为 `internal`，Client 不能依赖错误文字恢复原始错误码。opaque `internal` 只有在连续两次由健康且能力一致的普通快照确认后才熔断；普通快照失败时继续退避。Client API 直接拒绝 Promise 则作为本地装配错误立即熔断。

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
