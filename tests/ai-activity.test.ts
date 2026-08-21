import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AiActivityPanel } from '../src/client/AiActivityPanel.js'
import { deriveAiActivity } from '../src/client/ai-activity.js'
import type { SerialConversationSnapshot } from '../src/client/ai-activity.js'

describe('AI activity projection', () => {
  it('reports live reasoning and a running tool without duplicating chat rendering', () => {
    const activity = deriveAiActivity(snapshot({
      running: true,
      partial: {
        turn: 4,
        step: 2,
        blocks: [
          { kind: 'reasoning', text: '先检查串口状态' },
          { kind: 'tool-call', callId: 'call-1', name: 'serial_read' },
        ],
      },
      runningCalls: [{ callId: 'call-1', name: 'serial_read', turn: 4, step: 2 }],
    }))

    expect(activity.status).toBe('using-tools')
    expect(activity.turn).toBe(4)
    expect(activity.step).toBe(2)
    expect(activity.reasoning).toBe('先检查串口状态')
    expect(activity.tools).toEqual([{ callId: 'call-1', name: 'serial_read', status: 'running' }])
  })

  it('shows the latest settled response and completed tool result', () => {
    const activity = deriveAiActivity(snapshot({
      nodes: [
        {
          kind: 'tool-result',
          seq: 8,
          callId: 'call-2',
          call: { name: 'serial_send' },
          isError: false,
        },
        {
          kind: 'assistant',
          seq: 9,
          turn: 2,
          step: 1,
          blocks: [
            { kind: 'tool-call', callId: 'call-2', name: 'serial_send' },
            { kind: 'text', text: '命令已经发送。' },
          ],
        },
      ],
    }))

    expect(activity.status).toBe('complete')
    expect(activity.response).toBe('命令已经发送。')
    expect(activity.tools).toEqual([{ callId: 'call-2', name: 'serial_send', status: 'complete' }])
  })

  it('surfaces a newer terminal turn error instead of an older answer', () => {
    const activity = deriveAiActivity(snapshot({
      nodes: [
        { kind: 'assistant', seq: 4, turn: 1, step: 1, blocks: [{ kind: 'text', text: '旧回复' }] },
        { kind: 'turn-error', seq: 7, turn: 2, message: '模型连接失败', code: 'provider' },
      ],
    }))

    expect(activity.status).toBe('error')
    expect(activity.error).toBe('provider: 模型连接失败')
  })

  it('renders the compact status, reasoning, tool, and response surfaces', () => {
    const activity = deriveAiActivity(snapshot({
      running: true,
      partial: {
        turn: 3,
        step: 1,
        blocks: [
          { kind: 'reasoning', text: '读取板卡输出' },
          { kind: 'tool-call', callId: 'call-3', name: 'serial_read' },
          { kind: 'text', text: '正在检查。' },
        ],
      },
      runningCalls: [{ callId: 'call-3', name: 'serial_read', turn: 3, step: 1 }],
    }))

    const html = renderToStaticMarkup(createElement(AiActivityPanel, {
      activity,
      onClose: () => undefined,
    }))

    expect(html).toContain('AI 正在调用工具')
    expect(html).toContain('读取板卡输出')
    expect(html).toContain('serial_read')
    expect(html).toContain('正在检查。')
  })
})

function snapshot(overrides: Partial<SerialConversationSnapshot>): SerialConversationSnapshot {
  return {
    running: false,
    partial: null,
    nodes: [],
    runningCalls: [],
    lastAgentError: null,
    ...overrides,
  }
}
