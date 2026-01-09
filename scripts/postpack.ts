/*
 * © 2021 Thoughtworks, Inc.
 */

import path from 'path'
import fs from 'fs-extra'

const packagePath = process.cwd()
const packageJsonPath = path.resolve(packagePath, './package.json')
const backupPackageJsonPath = path.resolve(
  packagePath,
  './package.json-prepack',
)

async function restorePackageJson() {
  await fs.move(backupPackageJsonPath, packageJsonPath, {
    overwrite: true,
  })
}

async function run() {
  try {
    await restorePackageJson()
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

// this modifies the package.json file, so we don't want to run it in the build process
// run()