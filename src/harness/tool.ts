/** Model-facing serial tools over the single Host-owned serial service. */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { SerialSnapshot } from '../protocol.js'
import type {} from './host.js'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-serial-console'
export const inject = ['tools', 'serialConsole', 'systemPrompt']

export interface Config {
  readonly maxReadLines?: number
  readonly maxReadBytes?: number
}

export const Config: schema<Config> = schema.object({
  maxReadLines: schema.number().step(1).min(1).default(200),
  maxReadBytes: schema.number().step(1).min(64).default(16_384),
})

const objectOutput = <const Properties extends ParameterSchemaSpec>(properties: Properties) => ({
  type: 'object' as const,
  additionalProperties: false,
  properties,
})
const statusProperty = {
  type: 'string' as const,
  required: true as const,
  enum: ['disconnected', 'opening', 'connected', 'closing', 'error'],
} as const
const snapshotOutput = objectOutput({
  sessionId: { type: 'string' },
  status: statusProperty,
  earliestSeq: { type: 'integer', required: true },
  nextSeq: { type: 'integer', required: true },
  truncated: { type: 'boolean', required: true },
})
const sendOutput = objectOutput({
  sessionId: { type: 'string', required: true },
  seq: { type: 'integer', required: true },
  byteLength: { type: 'integer', required: true },
})

function present(title: string, kind: 'read' | 'execute' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

function snapshotView(value: SerialSnapshot) {
  return {
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    status: value.status,
    earliestSeq: value.earliestSeq,
    nextSeq: value.nextSeq,
    truncated: value.truncated,
  }
}

/** Register the serial tool set in the active agent/tool scope. */
export function apply(ctx: Context, config: Config = {}): void {
  const maxReadLines = config.maxReadLines ?? 200
  const maxReadBytes = config.maxReadBytes ?? 16_384

  ctx.systemPrompt.section({
    name: 'tool:serial-console',
    order: 115,
    text: 'Serial tools and the browser share one Host-owned physical port. Verify writes with serial_expect or serial_read. Never replay destructive commands after reconnecting.',
  })

  ctx.tools.register(defineTool({
    name: 'serial_list_ports',
    description: 'List physical serial ports visible to the Harness Host.',
    parameters: {},
    output: {
      schema: objectOutput({
        ports: {
          type: 'array',
          required: true,
          items: objectOutput({
            path: { type: 'string', required: true },
            serialNumber: { type: 'string' },
            manufacturer: { type: 'string' },
            friendlyName: { type: 'string' },
            vendorId: { type: 'string' },
            productId: { type: 'string' },
          }),
        },
      }),
      render: (_args: unknown, value: { ports: readonly { path: string; friendlyName?: string }[] }) => [{
        type: 'text' as const,
        text: value.ports.length === 0
          ? 'No serial ports found.'
          : value.ports.map(item => item.friendlyName === undefined ? item.path : `${item.path} (${item.friendlyName})`).join('\n'),
      }],
    },
    async execute() {
      return { ports: (await ctx.serialConsole.listPorts()).map(item => ({ ...item })) }
    },
    presentCall: () => present('List serial ports', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'serial_connect',
    description: 'Open the shared serial port with explicit line settings.',
    parameters: {
      port: { type: 'string', required: true, description: 'Port path returned by serial_list_ports.' },
      baud_rate: { type: 'integer', required: true, description: 'Baud rate, for example 115200.' },
      data_bits: { type: 'integer', enum: [5, 6, 7, 8] },
      stop_bits: { type: 'number', enum: [1, 1.5, 2] },
      parity: { type: 'string', enum: ['none', 'even', 'odd', 'mark', 'space'] },
      rtscts: { type: 'boolean' },
    },
    output: {
      schema: snapshotOutput,
      render: (_args: unknown, value) => [{ type: 'text' as const, text: `Serial connection ${value.status}` }],
    },
    async execute(args) {
      return snapshotView(await ctx.serialConsole.connect({
        path: args.port,
        baudRate: args.baud_rate,
        ...(args.data_bits === undefined ? {} : { dataBits: args.data_bits as 5 | 6 | 7 | 8 }),
        ...(args.stop_bits === undefined ? {} : { stopBits: args.stop_bits as 1 | 1.5 | 2 }),
        ...(args.parity === undefined ? {} : { parity: args.parity }),
        ...(args.rtscts === undefined ? {} : { rtscts: args.rtscts }),
      }))
    },
    presentCall: args => present(`Connect ${args.port} @ ${args.baud_rate}`, 'execute'),
  }))

  ctx.tools.register(defineTool({
    name: 'serial_send',
    description: 'Send UTF-8 text or Base64 bytes through the connected serial session.',
    parameters: {
      text: { type: 'string', description: 'UTF-8 text; mutually exclusive with data_base64.' },
      data_base64: { type: 'string', description: 'Raw bytes; mutually exclusive with text.' },
      line_ending: { type: 'string', enum: ['none', 'cr', 'lf', 'crlf'] },
    },
    output: {
      schema: sendOutput,
      render: (_args: unknown, value: { seq: number; byteLength: number }) => [{
        type: 'text' as const,
        text: `sent ${value.byteLength} bytes (serial seq ${value.seq})`,
      }],
    },
    async execute(args, execution) {
      return await ctx.serialConsole.send({
        actor: 'model',
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.data_base64 === undefined ? {} : { dataBase64: args.data_base64 }),
        ...(args.line_ending === undefined ? {} : { lineEnding: args.line_ending }),
        toolCallId: execution.callId,
      })
    },
    presentCall: args => present('Send serial data', 'execute', args.text ?? args.data_base64),
  }))

  ctx.tools.register(defineTool({
    name: 'serial_read',
    description: 'Read a bounded recent window from the shared serial event stream.',
    parameters: {
      after_seq: { type: 'integer' },
      limit: { type: 'integer', description: 'Maximum event count, capped at 2000.' },
    },
    output: {
      schema: objectOutput({
        sessionId: { type: 'string' },
        status: statusProperty,
        startSeq: { type: 'integer', required: true },
        endSeq: { type: 'integer', required: true },
        nextSeq: { type: 'integer', required: true },
        truncated: { type: 'boolean', required: true },
        text: { type: 'string', required: true },
      }),
      render: (_args: unknown, value) => [{
        type: 'text' as const,
        text: value.text.length === 0 ? `serial ${value.status} has no new text` : value.text,
      }],
    },
    execute(args) {
      const snapshot = ctx.serialConsole.snapshot({
        afterSeq: args.after_seq ?? 0,
        limit: Math.min(args.limit ?? 200, 2_000),
      })
      const fragments: { seq: number; text: string }[] = []
      for (const event of snapshot.events) {
        if ((event.type === 'rx' || event.type === 'tx') && event.text !== undefined) {
          fragments.push({ seq: event.seq, text: event.text })
        }
      }
      let text = fragments.map(item => item.text).join('')
      const lines = text.split('\n')
      if (lines.length > maxReadLines) text = lines.slice(-maxReadLines).join('\n')
      const encoder = new TextEncoder()
      while (text.length > 0 && encoder.encode(text).byteLength > maxReadBytes) text = text.slice(Math.max(1, Math.floor(text.length / 2)))
      return Promise.resolve({
        ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
        status: snapshot.status,
        startSeq: fragments[0]?.seq ?? snapshot.nextSeq,
        endSeq: fragments.at(-1)?.seq ?? snapshot.earliestSeq,
        nextSeq: snapshot.nextSeq,
        truncated: snapshot.truncated,
        text,
      })
    },
    presentCall: () => present('Read serial output', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'serial_expect',
    description: 'Wait for a regular expression in future board RX output.',
    parameters: {
      pattern: { type: 'string', required: true },
      flags: { type: 'string' },
      after_seq: { type: 'integer' },
      timeout_ms: { type: 'integer' },
      max_chars: { type: 'integer' },
    },
    output: {
      schema: objectOutput({
        sessionId: { type: 'string', required: true },
        startSeq: { type: 'integer', required: true },
        endSeq: { type: 'integer', required: true },
        match: { type: 'string', required: true },
        index: { type: 'integer', required: true },
      }),
      render: (_args: unknown, value) => [{ type: 'text' as const, text: value.match }],
    },
    async execute(args, execution) {
      return await ctx.serialConsole.expect({
        pattern: args.pattern,
        ...(args.flags === undefined ? {} : { flags: args.flags }),
        ...(args.after_seq === undefined ? {} : { afterSeq: args.after_seq }),
        ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
        ...(args.max_chars === undefined ? {} : { maxChars: args.max_chars }),
      }, execution.signal)
    },
    presentCall: args => present(`Expect /${args.pattern}/`, 'other'),
  }))

  ctx.tools.register(defineTool({
    name: 'serial_mark',
    description: 'Add a named model evidence marker to the shared serial stream.',
    parameters: { label: { type: 'string', required: true } },
    output: {
      schema: objectOutput({
        sessionId: { type: 'string', required: true },
        seq: { type: 'integer', required: true },
        label: { type: 'string', required: true },
      }),
      render: (_args: unknown, value) => [{ type: 'text' as const, text: `marked ${value.label} (serial seq ${value.seq})` }],
    },
    execute(args, execution) {
      const marker = ctx.serialConsole.mark({ label: args.label, actor: 'model', toolCallId: execution.callId })
      return Promise.resolve({ sessionId: marker.sessionId, seq: marker.seq, label: marker.label })
    },
    presentCall: args => present(`Mark ${args.label}`, 'other'),
  }))

  ctx.tools.register(defineTool({
    name: 'serial_disconnect',
    description: 'Disconnect the shared Host-owned serial port.',
    parameters: {},
    output: {
      schema: snapshotOutput,
      render: (_args: unknown, value) => [{ type: 'text' as const, text: `Serial connection ${value.status}` }],
    },
    async execute() { return snapshotView(await ctx.serialConsole.disconnect()) },
    presentCall: () => present('Disconnect serial port', 'execute'),
  }))
}
