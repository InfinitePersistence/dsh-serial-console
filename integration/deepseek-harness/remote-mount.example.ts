/** Blueprint only: dedicated Client package that mounts the generated Remote contribution. */
import type { Context } from '@deepseek-ai/cordis'
import serialRemote from '@community/dsh-serial-console/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@community/dsh-serial-console/remote'

export const inject = ['remote']

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const dispose = await ctx.remote.$mount(serialRemote)
  return async () => { await dispose() }
}

