import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SerialEvent } from '../protocol.js'
import type { SerialEventSink } from './transport.js'

/** Append-only JSONL evidence sink, partitioned by physical serial session. */
export class JsonlSerialEventSink implements SerialEventSink {
  private tail: Promise<void> = Promise.resolve()
  private directoryReady: Promise<void> | undefined
  private failure: Error | undefined

  constructor(private readonly directory: string) {
    if (directory.trim().length === 0) throw new TypeError('log directory must not be blank')
  }

  write(event: SerialEvent): void {
    this.tail = this.tail.then(async () => {
      if (this.failure !== undefined) throw this.failure
      this.directoryReady ??= mkdir(this.directory, { recursive: true }).then(() => undefined)
      await this.directoryReady
      const path = join(this.directory, `${safeFileSegment(event.sessionId)}.jsonl`)
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
    }).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error))
    })
  }

  async flush(): Promise<void> {
    await this.tail
    if (this.failure !== undefined) throw this.failure
  }
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}

