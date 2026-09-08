// One-off verification script (not part of the app): dumps the Win32 version
// resource of a built .exe using `resedit`, a transitive dependency of
// electron-builder (app-builder-lib) rather than a direct devDependency of
// this project — it is not listed in package.json's devDependencies, only in
// package-lock.json under app-builder-lib's own deps, but npm hoists it to
// the top-level node_modules so it resolves here without extra install work.
//
// Usage: node scripts/dump-exe-version.mjs <path-to-exe>
import fs from 'node:fs'
import * as ResEdit from 'resedit'

const exePath = process.argv[2]
if (!exePath) {
  console.error('usage: dump-exe-version.mjs <exe>')
  process.exit(1)
}

const data = fs.readFileSync(exePath)
const exe = ResEdit.NtExecutable.from(data)
const res = ResEdit.NtExecutableResource.from(exe)
const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries)

for (const vi of viList) {
  for (const language of vi.getAllLanguagesForStringValues()) {
    console.log(`--- language ${JSON.stringify(language)} ---`)
    const values = vi.getStringValues(language)
    for (const [k, v] of Object.entries(values)) {
      console.log(`${k}: ${v}`)
    }
  }
  console.log('fixedInfo:', vi.fixedInfo)
}
