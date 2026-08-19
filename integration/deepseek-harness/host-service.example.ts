/**
 * Blueprint only. Move into packages/serial/serial and replace relative core
 * imports with package-owned sources before adding it to the Host aggregate.
 */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  JsonlSerialEventSink,
  NodeSerialPortFactory,
  SerialSessionManager,
} from '../../src/serial/index.js'
import { decodeSendRequest } from '../../src/protocol.js'
import type {
  SerialActor,
  SerialMarkerEvent,
  SerialOpenOptions,
  SerialPortDescriptor,
  SerialSendRequest,
  SerialSendResult,
  SerialSnapshot,
  SerialSnapshotRequest,
  SerialWaitSnapshotRequest,
} from '../../src/protocol.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    serialConsole: SerialConsoleService
  }
}

export interface Config {
  readonly logDirectory: string
  readonly ringCapacity?: number
}

interface EmptyRequest {}
interface MarkRequest {
  readonly label: string
  readonly actor: SerialActor
  readonly toolCallId?: string
}

export class SerialConsoleService extends TypertRemoteService {
  static Config: schema<Config> = schema.object({
    logDirectory: schema.string().required(),
    ringCapacity: schema.number().step(1).min(100).default(20_000),
  })

  readonly manager: SerialSessionManager

  constructor(ctx: Context, config: Config) {
    super(ctx, 'serialConsole')
    this.manager = new SerialSessionManager(new NodeSerialPortFactory(), {
      ringCapacity: config.ringCapacity ?? 20_000,
      eventSink: new JsonlSerialEventSink(config.logDirectory),
    })
    ctx.effect(() => async () => { await this.manager.close() }, 'serial-console: close transport and audit')
  }

  @Remote('listPorts')
  async listPorts(_request: EmptyRequest): Promise<readonly SerialPortDescriptor[]> {
    return await this.manager.listPorts()
  }

  @Remote('connect')
  async connect(request: SerialOpenOptions): Promise<SerialSnapshot> {
    return await this.manager.connect(request)
  }

  @Remote('disconnect')
  async disconnect(_request: EmptyRequest): Promise<SerialSnapshot> {
    return await this.manager.disconnect()
  }

  @Remote('snapshot')
  snapshot(request: SerialSnapshotRequest, signal?: AbortSignal): SerialSnapshot {
    void signal
    return this.manager.snapshot(request.afterSeq ?? 0, request.limit)
  }

  @Remote('waitSnapshot')
  async waitSnapshot(
    request: SerialWaitSnapshotRequest,
    signal: AbortSignal,
  ): Promise<SerialSnapshot> {
    return await this.manager.waitSnapshot(request, signal)
  }

  @Remote('send')
  async send(request: SerialSendRequest): Promise<SerialSendResult> {
    const bytes = decodeSendRequest(request)
    return await this.manager.send(bytes, {
      actor: request.actor,
      text: new TextDecoder().decode(bytes),
      ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    })
  }

  @Remote('mark')
  mark(request: MarkRequest): SerialMarkerEvent {
    return this.manager.mark(request.label, request.actor, request.toolCallId)
  }
}

export default SerialConsoleService
