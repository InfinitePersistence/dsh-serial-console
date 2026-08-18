/** Blueprint only: the model-facing Consumer belongs in an agent preset. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { decodeSendRequest } from '../../src/protocol.js'
import type {} from './host-service.example.js'

export const name = 'tool-serial'
export const inject = ['tools', 'serialConsole']

const SEND_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sessionId: { type: 'string', required: true },
      seq: { type: 'integer', required: true },
      byteLength: { type: 'integer', required: true },
    },
  },
  render: (_args: unknown, value: { sessionId: string; seq: number; byteLength: number }) => [{
    type: 'text' as const,
    text: `sent ${value.byteLength} bytes (serial seq ${value.seq})`,
  }],
}

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'serial_send',
    description: 'Send one bounded text or Base64 payload through the connected board serial session. '
      + 'Use expect/read to verify the board response; never assume that a successful write means the board accepted a command.',
    parameters: {
      text: { type: 'string', description: 'UTF-8 text. Mutually exclusive with data_base64.' },
      data_base64: { type: 'string', description: 'Raw bytes. Mutually exclusive with text.' },
      line_ending: {
        type: 'string',
        enum: ['none', 'cr', 'lf', 'crlf'],
        description: 'Explicit suffix for text only. Use CR for an interactive serial-console Enter key.',
      },
    },
    output: SEND_OUTPUT,
    async execute(args, exec) {
      const request = {
        actor: 'model' as const,
        ...(args.text === undefined ? {} : { text: args.text }),
        ...(args.data_base64 === undefined ? {} : { dataBase64: args.data_base64 }),
        ...(args.line_ending === undefined ? {} : { lineEnding: args.line_ending }),
      }
      const bytes = decodeSendRequest(request)
      return await ctx.serialConsole.manager.send(bytes, {
        actor: 'model',
        ...(args.text === undefined ? {} : { text: new TextDecoder().decode(bytes) }),
        toolCallId: exec.callId,
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Send serial data', kind: 'execute', rawInput: args }),
  }))

  // Add serial_list_ports, serial_connect, serial_read, serial_expect,
  // serial_mark, and serial_disconnect with bounded structured outputs.
}
