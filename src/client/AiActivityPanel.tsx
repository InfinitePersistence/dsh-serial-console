import { useEffect, useRef } from 'react'
import type { AiActivitySnapshot, AiActivityStatus, AiToolActivity } from './ai-activity.js'

export interface AiActivityPanelProps {
  readonly activity: AiActivitySnapshot
  readonly onClose: () => void
}

/** Compact read-only mirror of the selected DSH session's current AI activity. */
export function AiActivityPanel({ activity, onClose }: AiActivityPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)

  useEffect(() => {
    const element = scrollRef.current
    if (element !== null && followingRef.current) element.scrollTop = element.scrollHeight
  }, [activity.signature])

  return (
    <aside className="dsh-serial-ai-panel" aria-label="AI activity">
      <header className="dsh-serial-ai-header">
        <span className={`dsh-serial-ai-status is-${activity.status}`} aria-hidden />
        <strong>{statusLabel(activity.status)}</strong>
        {activity.turn !== undefined && (
          <span className="dsh-serial-ai-turn">
            Turn {activity.turn}{activity.step === undefined ? '' : ` · Step ${activity.step}`}
          </span>
        )}
        <button type="button" onClick={onClose} aria-label="Hide AI activity">×</button>
      </header>

      <div
        ref={scrollRef}
        className="dsh-serial-ai-scroll"
        onScroll={event => {
          const element = event.currentTarget
          followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
        }}
      >
        {activity.status === 'idle' && (
          <p className="dsh-serial-ai-empty">在底部输入栏向模型发送消息后，可在这里查看实时进度和回复。</p>
        )}

        {activity.reasoning !== '' && (
          <details className="dsh-serial-ai-reasoning" open={activity.status === 'thinking'}>
            <summary>思考过程{activity.running ? ' · 进行中' : ''}</summary>
            <div>{activity.reasoning}</div>
          </details>
        )}

        {activity.tools.length > 0 && (
          <section className="dsh-serial-ai-tools" aria-label="AI tool activity">
            <h3>工具</h3>
            {activity.tools.map(tool => <ToolActivity key={tool.callId} tool={tool} />)}
          </section>
        )}

        {activity.response !== '' && (
          <section className="dsh-serial-ai-response" aria-label="AI response">
            <h3>回复</h3>
            <div>{activity.response}</div>
          </section>
        )}

        {activity.error !== undefined && (
          <div className="dsh-serial-ai-error" role="alert">{activity.error}</div>
        )}

        {activity.running && activity.reasoning === '' && activity.response === '' && activity.tools.length === 0 && (
          <p className="dsh-serial-ai-empty">模型正在处理当前请求…</p>
        )}
      </div>
    </aside>
  )
}

function ToolActivity({ tool }: { readonly tool: AiToolActivity }) {
  return (
    <div className={`dsh-serial-ai-tool is-${tool.status}`}>
      <span className="dsh-serial-ai-tool-dot" aria-hidden />
      <code>{tool.name}</code>
      <span>{toolStatusLabel(tool.status)}</span>
    </div>
  )
}

function statusLabel(status: AiActivityStatus): string {
  switch (status) {
    case 'thinking': return 'AI 正在思考'
    case 'responding': return 'AI 正在回复'
    case 'using-tools': return 'AI 正在调用工具'
    case 'complete': return 'AI 已完成'
    case 'interrupted': return 'AI 已停止'
    case 'error': return 'AI 执行失败'
    default: return 'AI 浏览窗'
  }
}

function toolStatusLabel(status: AiToolActivity['status']): string {
  switch (status) {
    case 'running': return '运行中'
    case 'complete': return '已完成'
    case 'error': return '失败'
    default: return '已请求'
  }
}
