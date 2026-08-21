import { copyFile, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
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
const serialportManifest = await resolvePackageManifest(require, 'serialport')
const pinnedSerialport = JSON.parse(await readFile(serialportManifest, 'utf8'))
const vendorManifestPath = join(vendorRoot, 'serialport', 'package.json')
let vendorMatches = false
try {
  const retained = JSON.parse(await readFile(vendorManifestPath, 'utf8'))
  vendorMatches = retained.name === 'serialport' && retained.version === pinnedSerialport.version
} catch {
  vendorMatches = false
}
if (!vendorMatches) {
  // A live DSH profile can link this checkout's dist (`dsh plugin add <path>`)
  // and the running Host then holds serialport's native prebuild open, which
  // Windows refuses to unlink. Deleting is only attempted when the retained
  // version no longer matches the pinned one, so this normally never runs.
  try {
    await rm(vendorRoot, { recursive: true, force: true })
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EBUSY') {
      throw new Error(
        `cannot refresh the vendored serialport tree: ${vendorRoot} is locked by a running process `
        + '(stop the dsh web server or the profile that links this checkout, then rebuild)',
        { cause: error },
      )
    }
    throw error
  }
}
// The copy is tolerant of locked files: rebuilding while the linked profile is
// running skips the exact prebuild the Host already loaded (the retained tree
// was checked against the pinned package version above) and fills any other
// missing or changed files.
await copyPackageTree(serialportManifest, join(vendorRoot, 'serialport'))
process.stderr.write(`copy-assets: vendored serialport ${pinnedSerialport.version}\n`)

async function copyPackageTree(manifestPath, destination) {
  const sourceRoot = dirname(await realpath(manifestPath))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  await copyTreeTolerant(sourceRoot, destination)
  const nestedRequire = createRequire(manifestPath)
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    await copyPackageTree(
      await resolvePackageManifest(nestedRequire, dependency),
      join(destination, 'node_modules', ...dependency.split('/')),
    )
  }
}

async function copyTreeTolerant(source, destination) {
  await mkdir(destination, { recursive: true })
  const entries = await readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue // nested deps walk their own manifests
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isDirectory()) {
      await copyTreeTolerant(sourcePath, destinationPath)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    try {
      await copyFile(sourcePath, destinationPath)
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EBUSY') {
        process.stderr.write(`copy-assets: skipping locked ${destinationPath}\n`)
        continue
      }
      throw error
    }
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
