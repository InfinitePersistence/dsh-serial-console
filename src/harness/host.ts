/** DeepSeek Harness Host plugin that owns the physical serial connection. */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  JsonlSerialEventSink,
  NodeSerialPortFactory,
  SerialSessionManager,
} from '../serial/index.js'
import { decodeSendRequest } from '../protocol.js'
import type {
  SerialExpectRequest,
  SerialExpectResult,
  SerialMarkRequest,
  SerialMarkerEvent,
  SerialOpenOptions,
  SerialPortDescriptor,
  SerialSendRequest,
  SerialSendResult,
  SerialSnapshot,
  SerialSnapshotRequest,
  SerialWaitSnapshotRequest,
} from '../protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    serialConsole: SerialConsoleService
  }
}

/** Host configuration supplied by cordis.patch.yml. */
export interface Config {
  readonly logDirectory: string
  readonly ringCapacity?: number
  readonly snapshotLimit?: number
}

export const Config: schema<Config> = schema.object({
  logDirectory: schema.string().required(),
  ringCapacity: schema.number().step(1).min(100).default(20_000),
  snapshotLimit: schema.number().step(1).min(1).default(2_000),
})

const DEFAULT_RING_CAPACITY = 20_000
const DEFAULT_SNAPSHOT_LIMIT = 2_000

/** One process-wide service owns every serial RX/TX event and audit record. */
export class SerialConsoleService extends TypertRemoteService {
  static Config: schema<Config> = Config

  readonly manager: SerialSessionManager

  constructor(ctx: Context, config: Config) {
    super(ctx, 'serialConsole')
    this.manager = new SerialSessionManager(new NodeSerialPortFactory(), {
      ringCapacity: config.ringCapacity ?? DEFAULT_RING_CAPACITY,
      snapshotLimit: config.snapshotLimit ?? DEFAULT_SNAPSHOT_LIMIT,
      eventSink: new JsonlSerialEventSink(config.logDirectory),
    })
    ctx.effect(
      () => async () => { await this.manager.close() },
      'dsh-serial-console: close transport and audit sink',
    )
  }

  @Remote
  async listPorts(): Promise<readonly SerialPortDescriptor[]> {
    return await this.manager.listPorts()
  }

  @Remote
  async connect(request: SerialOpenOptions): Promise<SerialSnapshot> {
    return await this.manager.connect(request)
  }

  @Remote
  async disconnect(): Promise<SerialSnapshot> {
    return await this.manager.disconnect()
  }

  @Remote
  snapshot(request: SerialSnapshotRequest, signal?: AbortSignal): SerialSnapshot {
    void signal
    return this.manager.snapshot(
      request.afterSeq ?? 0,
      request.limit ?? DEFAULT_SNAPSHOT_LIMIT,
    )
  }

  @Remote
  async waitSnapshot(
    request: SerialWaitSnapshotRequest,
    signal: AbortSignal,
  ): Promise<SerialSnapshot> {
    return await this.manager.waitSnapshot(request, signal)
  }

  @Remote
  async send(request: SerialSendRequest): Promise<SerialSendResult> {
    const bytes = decodeSendRequest(request)
    return await this.manager.send(bytes, {
      actor: request.actor,
      ...(request.text === undefined ? {} : { text: new TextDecoder().decode(bytes) }),
      ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    })
  }

  @Remote
  mark(request: SerialMarkRequest): SerialMarkerEvent {
    return this.manager.mark(request.label, request.actor, request.toolCallId)
  }

  /** Model-only bounded RX matcher; it is intentionally not a browser Remote. */
  expect(request: SerialExpectRequest, signal?: AbortSignal): Promise<SerialExpectResult> {
    return this.manager.waitForText(request, signal)
  }
}

export default SerialConsoleService
