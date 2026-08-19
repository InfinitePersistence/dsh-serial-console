import { cp, copyFile, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Ship serialport's official multi-platform prebuilds inside dist. DSH profiles
// disable dependency install scripts by default; copying the already-published
// package tree makes installation one-step without compiling native code on the
// user's machine. Each dependency is nested under its owner so incompatible
// parser versions (notably readline/delimiter 12 vs 13) cannot be flattened.
const require = createRequire(import.meta.url)
const vendorRoot = fileURLToPath(new URL('../dist/node_modules/', import.meta.url))
await rm(vendorRoot, { recursive: true, force: true })
await copyPackageTree(
  await resolvePackageManifest(require, 'serialport'),
  join(vendorRoot, 'serialport'),
)

async function copyPackageTree(manifestPath, destination) {
  const sourceRoot = dirname(await realpath(manifestPath))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await cp(sourceRoot, destination, {
    recursive: true,
    dereference: true,
    filter: source => !isNestedNodeModules(sourceRoot, source),
  })
  const nestedRequire = createRequire(manifestPath)
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    await copyPackageTree(
      await resolvePackageManifest(nestedRequire, dependency),
      join(destination, 'node_modules', ...dependency.split('/')),
    )
  }
}

async function resolvePackageManifest(packageRequire, packageName) {
  try {
    return packageRequire.resolve(`${packageName}/package.json`)
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
  }
  let current = dirname(packageRequire.resolve(packageName))
  while (true) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      const manifest = JSON.parse(await readFile(candidate, 'utf8'))
      if (manifest.name === packageName) return candidate
    }
    const parent = dirname(current)
    if (parent === current) throw new Error(`Cannot locate package.json for ${packageName}`)
    current = parent
  }
}

function isNestedNodeModules(root, source) {
  const path = relative(root, source)
  return path !== '' && path.split(sep).includes('node_modules')
}
