import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    server: {
      deps: {
        // The published UI package imports CSS modules; let Vite process them.
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
