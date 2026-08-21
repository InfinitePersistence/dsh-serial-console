/** Minimal public Conversation snapshot surface consumed by the serial view. */
export interface SerialConversationSnapshot {
  readonly running: boolean
  readonly partial: SerialPartialAssistant | null
  readonly nodes: readonly SerialConversationNode[]
  readonly runningCalls: readonly SerialRunningToolCall[]
  readonly lastAgentError: string | null
}

export type UseSerialConversation = <Selected>(
  selector: (snapshot: SerialConversationSnapshot) => Selected,
) => Selected

export interface SerialAssistantBlock {
  readonly kind: 'text' | 'reasoning' | 'image' | 'tool-call' | 'other'
  readonly text?: string
  readonly callId?: string
  readonly name?: string
}

interface SerialPartialAssistant {
  readonly turn: number
  readonly step: number
  readonly blocks: readonly SerialAssistantBlock[]
}

interface SerialAssistantNode {
  readonly kind: 'assistant'
  readonly seq: number
  readonly turn: number
  readonly step: number
  readonly blocks: readonly SerialAssistantBlock[]
  readonly interrupted?: true
}

interface SerialToolResultNode {
  readonly kind: 'tool-result'
  readonly seq: number
  readonly callId: string
  readonly call: { readonly name: string } | null
  readonly isError: boolean
}

interface SerialTurnErrorNode {
  readonly kind: 'turn-error'
  readonly seq: number
  readonly turn: number
  readonly message: string
  readonly code?: string
}

interface SerialOtherNode {
  readonly kind: string
  readonly seq: number
}

type SerialConversationNode =
  | SerialAssistantNode
  | SerialToolResultNode
  | SerialTurnErrorNode
  | SerialOtherNode

interface SerialRunningToolCall {
  readonly callId: string
  readonly name: string
  readonly turn: number
  readonly step: number
}

export type AiActivityStatus =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'using-tools'
  | 'complete'
  | 'interrupted'
  | 'error'

export interface AiToolActivity {
  readonly callId: string
  readonly name: string
  readonly status: 'requested' | 'running' | 'complete' | 'error'
}

/** Immutable, presentation-ready subset of the currently selected DSH session. */
export interface AiActivitySnapshot {
  readonly status: AiActivityStatus
  readonly running: boolean
  readonly turn: number | undefined
  readonly step: number | undefined
  readonly reasoning: string
  readonly response: string
  readonly tools: readonly AiToolActivity[]
  readonly error: string | undefined
  readonly signature: string
}

export const EMPTY_AI_ACTIVITY: AiActivitySnapshot = {
  status: 'idle',
  running: false,
  turn: undefined,
  step: undefined,
  reasoning: '',
  response: '',
  tools: [],
  error: undefined,
  signature: 'idle',
}

interface ConversationNodeSummary {
  readonly assistant: SerialAssistantNode | undefined
  readonly turnError: SerialTurnErrorNode | undefined
  readonly toolResults: ReadonlyMap<string, SerialToolResultNode>
}

const NODE_SUMMARIES = new WeakMap<readonly SerialConversationNode[], ConversationNodeSummary>()

/** Fold the public DSH Conversation snapshot into the compact serial-side viewer. */
export function deriveAiActivity(snapshot: SerialConversationSnapshot): AiActivitySnapshot {
  const summary = summarizeConversationNodes(snapshot.nodes)
  const { assistant, turnError } = summary
  const blocks = snapshot.partial?.blocks ?? assistant?.blocks ?? []
  const turn = snapshot.partial?.turn
    ?? snapshot.runningCalls.at(-1)?.turn
    ?? assistant?.turn
    ?? turnError?.turn
  const step = snapshot.partial?.step
    ?? snapshot.runningCalls.at(-1)?.step
    ?? assistant?.step
  const reasoning = joinBlockText(blocks, 'reasoning')
  const response = joinBlockText(blocks, 'text')
  const tools = deriveTools(blocks, snapshot.runningCalls, summary.toolResults)
  const newerTurnError = turnError !== undefined && turnError.seq > (assistant?.seq ?? -1)
  const error = newerTurnError
    ? formatTurnError(turnError)
    : !snapshot.running && snapshot.lastAgentError !== null
      ? snapshot.lastAgentError
      : undefined
  const status = activityStatus(snapshot, assistant, reasoning, response, tools, error)
  const signature = [
    status,
    snapshot.running ? '1' : '0',
    turn ?? '',
    step ?? '',
    reasoning.length,
    reasoning.slice(-64),
    response.length,
    response.slice(-64),
    tools.map(tool => `${tool.callId}:${tool.status}`).join(','),
    error ?? '',
  ].join('|')
  return {
    status,
    running: snapshot.running,
    turn,
    step,
    reasoning,
    response,
    tools,
    error,
    signature,
  }
}

function activityStatus(
  snapshot: SerialConversationSnapshot,
  assistant: SerialAssistantNode | undefined,
  reasoning: string,
  response: string,
  tools: readonly AiToolActivity[],
  error: string | undefined,
): AiActivityStatus {
  if (error !== undefined) return 'error'
  if (snapshot.runningCalls.length > 0 || tools.some(tool => tool.status === 'running')) return 'using-tools'
  if (snapshot.running) {
    if (response !== '') return 'responding'
    if (reasoning !== '') return 'thinking'
    if (tools.length > 0) return 'using-tools'
    return 'thinking'
  }
  if (assistant?.interrupted === true) return 'interrupted'
  if (assistant !== undefined) return 'complete'
  return 'idle'
}

function deriveTools(
  blocks: readonly SerialAssistantBlock[],
  runningCalls: readonly SerialRunningToolCall[],
  results: ReadonlyMap<string, SerialToolResultNode>,
): readonly AiToolActivity[] {
  const running = new Map(runningCalls.map(call => [call.callId, call]))
  const tools: AiToolActivity[] = []
  const seen = new Set<string>()
  for (const block of blocks) {
    if (block.kind !== 'tool-call' || block.callId === undefined || seen.has(block.callId)) continue
    seen.add(block.callId)
    const result = results.get(block.callId)
    tools.push({
      callId: block.callId,
      name: block.name === undefined || block.name === '' ? 'tool' : block.name,
      status: result === undefined
        ? running.has(block.callId) ? 'running' : 'requested'
        : result.isError ? 'error' : 'complete',
    })
  }
  for (const call of runningCalls) {
    if (seen.has(call.callId)) continue
    seen.add(call.callId)
    tools.push({ callId: call.callId, name: call.name, status: 'running' })
  }
  return tools
}

function joinBlockText(blocks: readonly SerialAssistantBlock[], kind: 'text' | 'reasoning'): string {
  return blocks
    .filter((block): block is SerialAssistantBlock & { readonly text: string } => (
      block.kind === kind && typeof block.text === 'string'
    ))
    .map(block => block.text)
    .join('\n\n')
}

function formatTurnError(error: SerialTurnErrorNode): string {
  return error.code === undefined ? error.message : `${error.code}: ${error.message}`
}

function isAssistantNode(node: SerialConversationNode): node is SerialAssistantNode {
  return node.kind === 'assistant'
}

function isToolResultNode(node: SerialConversationNode): node is SerialToolResultNode {
  return node.kind === 'tool-result'
}

function isTurnErrorNode(node: SerialConversationNode): node is SerialTurnErrorNode {
  return node.kind === 'turn-error'
}

function summarizeConversationNodes(nodes: readonly SerialConversationNode[]): ConversationNodeSummary {
  const cached = NODE_SUMMARIES.get(nodes)
  if (cached !== undefined) return cached
  let assistant: SerialAssistantNode | undefined
  let turnError: SerialTurnErrorNode | undefined
  const toolResults = new Map<string, SerialToolResultNode>()
  for (const node of nodes) {
    if (isAssistantNode(node)) assistant = node
    else if (isTurnErrorNode(node)) turnError = node
    else if (isToolResultNode(node)) toolResults.set(node.callId, node)
  }
  const summary = { assistant, turnError, toolResults }
  NODE_SUMMARIES.set(nodes, summary)
  return summary
}
