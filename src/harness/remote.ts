/** Hand-authored strict Typert descriptors shared by Host and browser faces. */
import { z } from 'zod'
import { SERIAL_WAIT_SNAPSHOT_CAPABILITY } from '../protocol.js'
import type {
  InvocationDescriptor,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'

const PACKAGE_NAME = '@infinitepersistence/dsh-serial-console'

const actor = z.enum(['model', 'user'])
const status = z.enum(['disconnected', 'opening', 'connected', 'closing', 'error'])
const port = z.object({
  path: z.string(),
  manufacturer: z.string().optional(),
  serialNumber: z.string().optional(),
  vendorId: z.string().optional(),
  productId: z.string().optional(),
  friendlyName: z.string().optional(),
})
const openOptions = z.object({
  path: z.string(),
  baudRate: z.number(),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).optional(),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).optional(),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).optional(),
  rtscts: z.boolean().optional(),
})
const eventBase = {
  sessionId: z.string(),
  seq: z.number(),
  timestamp: z.number(),
  monotonicMs: z.number(),
}
const event = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('rx'), dataBase64: z.string(), text: z.string().optional() }),
  z.object({
    ...eventBase,
    type: z.literal('tx'),
    actor,
    dataBase64: z.string(),
    text: z.string().optional(),
    toolCallId: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('state'),
    status,
    port: openOptions.optional(),
    message: z.string().optional(),
  }),
  z.object({
    ...eventBase,
    type: z.literal('marker'),
    actor,
    label: z.string(),
    toolCallId: z.string().optional(),
  }),
  z.object({ ...eventBase, type: z.literal('error'), code: z.string(), message: z.string() }),
])
const snapshot = z.object({
  sessionId: z.string().optional(),
  status,
  port: openOptions.optional(),
  capabilities: z.object({
    waitSnapshot: z.literal(SERIAL_WAIT_SNAPSHOT_CAPABILITY),
  }).optional(),
  earliestSeq: z.number(),
  nextSeq: z.number(),
  truncated: z.boolean(),
  events: z.array(event),
})
const snapshotRequest = z.object({ afterSeq: z.number().optional(), limit: z.number().optional() })
const waitSnapshotRequest = snapshotRequest.extend({
  waitMs: z.number().int().min(0).max(1_000).optional(),
})
const sendRequest = z.object({
  actor,
  text: z.string().optional(),
  dataBase64: z.string().optional(),
  lineEnding: z.enum(['none', 'cr', 'lf', 'crlf']).optional(),
  toolCallId: z.string().optional(),
})
const sendResult = z.object({ sessionId: z.string(), seq: z.number(), byteLength: z.number() })
const markRequest = z.object({ label: z.string(), actor, toolCallId: z.string().optional() })
const marker = z.object({
  ...eventBase,
  type: z.literal('marker'),
  actor,
  label: z.string(),
  toolCallId: z.string().optional(),
})

function codec(typeSymbol: string, schema: z.ZodType): {
  readonly mode: 'strict'
  readonly typeSymbol: string
  readonly schema: z.ZodType
} {
  return { mode: 'strict', typeSymbol, schema }
}

function descriptor(
  method: string,
  parameter: { readonly type: string; readonly schema: z.ZodType } | undefined,
  result: { readonly type: string; readonly schema: z.ZodType },
  cancellable = false,
): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#serialConsole/${method}`,
    service: 'serialConsole',
    namespace: 'serialConsole',
    method,
    invocation: { kind: 'direct' },
    parameters: parameter === undefined ? [] : [{
      name: 'request',
      wire: 'request',
      source: 'json',
      codec: codec(parameter.type, parameter.schema),
    }],
    ...(cancellable ? { cancellation: { parameter: 'signal' as const } } : {}),
    result: codec(result.type, result.schema),
  }
}

export const SERIAL_REMOTE_DESCRIPTORS: readonly InvocationDescriptor[] = [
  descriptor('connect', { type: `${PACKAGE_NAME}/protocol#SerialOpenOptions`, schema: openOptions }, { type: `${PACKAGE_NAME}/protocol#SerialSnapshot`, schema: snapshot }),
  descriptor('disconnect', undefined, { type: `${PACKAGE_NAME}/protocol#SerialSnapshot`, schema: snapshot }),
  descriptor('listPorts', undefined, { type: `${PACKAGE_NAME}/protocol#SerialPortDescriptor[]`, schema: z.array(port) }),
  descriptor('mark', { type: `${PACKAGE_NAME}/protocol#SerialMarkRequest`, schema: markRequest }, { type: `${PACKAGE_NAME}/protocol#SerialMarkerEvent`, schema: marker }),
  descriptor('send', { type: `${PACKAGE_NAME}/protocol#SerialSendRequest`, schema: sendRequest }, { type: `${PACKAGE_NAME}/protocol#SerialSendResult`, schema: sendResult }),
  descriptor('snapshot', { type: `${PACKAGE_NAME}/protocol#SerialSnapshotRequest`, schema: snapshotRequest }, { type: `${PACKAGE_NAME}/protocol#SerialSnapshot`, schema: snapshot }, true),
  descriptor('waitSnapshot', { type: `${PACKAGE_NAME}/protocol#SerialWaitSnapshotRequest`, schema: waitSnapshotRequest }, { type: `${PACKAGE_NAME}/protocol#SerialSnapshot`, schema: snapshot }, true),
]

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: PACKAGE_NAME,
  descriptors: SERIAL_REMOTE_DESCRIPTORS,
}

export default TYPERT_REMOTE
