import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'

await mkdir(new URL('../dist/client/', import.meta.url), { recursive: true })
await copyFile(
  new URL('../src/client/serial-console.css', import.meta.url),
  new URL('../dist/client/serial-console.css', import.meta.url),
)
await copyFile(
  new URL('../src/client/assets.d.ts', import.meta.url),
  new URL('../dist/client/assets.d.ts', import.meta.url),
)

const clientTypesUrl = new URL('../dist/client/index.d.ts', import.meta.url)
const clientTypes = await readFile(clientTypesUrl, 'utf8')
const packagedClientTypes = clientTypes.replace(
  '../../src/client/assets.d.ts',
  './assets.d.ts',
)
if (packagedClientTypes === clientTypes) {
  throw new Error('Expected the emitted client CSS declaration reference')
}
await writeFile(clientTypesUrl, packagedClientTypes)
