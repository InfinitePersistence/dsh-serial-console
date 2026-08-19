/**
 * Build-only structural declarations for DSH peer APIs. The running Harness
 * supplies the real modules and shared runtime identities.
 */
declare module '@deepseek-ai/cordis' {
  export interface Context {
    effect(effect: () => unknown, label?: string): void
    tools: { register(tool: unknown): void }
    systemPrompt: { section(section: { name: string; order: number; text: string }): void }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  import type { Context } from '@deepseek-ai/cordis'

  export interface TypertCodec {
    readonly mode: 'strict'
    readonly typeSymbol: string
    readonly schema: { readonly _zod?: unknown; parse?(value: unknown): unknown }
  }
  export interface InvocationDescriptor {
    readonly id: string
    readonly service: string
    readonly namespace: string
    readonly method: string
    readonly invocation: { readonly kind: 'direct' }
    readonly parameters: readonly {
      readonly name: string
      readonly wire: string
      readonly source: 'json'
      readonly codec: TypertCodec
    }[]
    readonly result: TypertCodec
  }
  export interface TypertRemoteContribution {
    readonly package: string
    readonly descriptors: readonly InvocationDescriptor[]
  }
  export class TypertRemoteService {
    protected constructor(ctx: Context, serviceKey: string)
  }
  export const Remote: any
}

declare module '@deepseek-ai/dsh-tools' {
  export interface GenericCallView {
    readonly card: 'generic'
    readonly title: string
    readonly kind: 'read' | 'execute' | 'other'
    readonly rawInput?: unknown
  }
  export type ParameterSchemaSpec = Record<string, {
    readonly type?: string
    readonly oneOf?: readonly unknown[]
    readonly items?: unknown
    readonly properties?: ParameterSchemaSpec
    readonly additionalProperties?: boolean
    readonly required?: true
    readonly enum?: readonly unknown[]
    readonly description?: string
  }>
  interface ToolOptions {
    readonly name: string
    readonly description: string
    readonly parameters: ParameterSchemaSpec
    readonly output: {
      readonly schema: unknown
      render(args: any, value: any): readonly unknown[]
    }
    execute(args: any, execution: { readonly callId: string; readonly signal: AbortSignal }): Promise<any>
    presentCall?(args: any): GenericCallView | undefined
  }
  export function defineTool(options: ToolOptions): unknown
}

declare module '@deepseek-ai/dsh-system-prompt' {}
