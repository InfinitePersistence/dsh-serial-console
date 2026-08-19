import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = '@infinitepersistence/dsh-serial-console'
const CSS_PREFIX = '\0dsh-serial-css:'
const CSS_SUFFIX = '.mjs'

export default defineConfig({
  name: `${PACKAGE_NAME}/client`,
  entry: { client: 'src/harness/client.tsx' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: ['react', 'react/jsx-runtime', '@deepseek-ai/cordis'],
    alwaysBundle: ['@xterm/addon-fit', '@xterm/xterm', 'zod'],
    onlyBundle: ['@xterm/addon-fit', '@xterm/xterm', 'zod'],
  },
  plugins: [{
    name: 'dsh-serial-inline-css',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || importer === undefined) return null
      return CSS_PREFIX + resolve(dirname(importer), source) + CSS_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const css = await readFile(id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length), 'utf8')
      return [
        `const css = ${JSON.stringify(css)};`,
        `const owner = ${JSON.stringify(PACKAGE_NAME)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin=' + JSON.stringify(owner) + ']') === null) {",
        "  const style = document.createElement('style');",
        '  style.dataset.plugin = owner;',
        '  style.textContent = css;',
        '  document.head.appendChild(style);',
        '}',
        'export default css;',
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
