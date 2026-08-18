import { copyFile, mkdir } from 'node:fs/promises'

await mkdir(new URL('../dist/client/', import.meta.url), { recursive: true })
await copyFile(
  new URL('../src/client/serial-console.css', import.meta.url),
  new URL('../dist/client/serial-console.css', import.meta.url),
)

