#!/usr/bin/env -S pkgx +nixos.org/patchelf=0.17.2 +darwinsys.com/file^5 deno run -A

// FIXME ^^ patchelf 0.18.0 has a regression that breaks libraries
//       https://github.com/NixOS/patchelf/issues/492#issuecomment-1561912775

import { utils, Installation, hooks, Path } from "pkgx"
import { backticks } from "../../lib/utils.ts"
const { useCellar } = hooks
const { host } = utils

if (import.meta.main) {
  const cellar = useCellar()
  const [installation_path, ...pkgs] = Deno.args
  const installed = await cellar.resolve(new Path(installation_path))
  await fix_rpaths(installed, pkgs)
}


//TODO this is not resilient to upgrades (obv)
//NOTE solution is to have the rpath reference major version (or more specific if poss)

/// fix rpaths or install names for executables and dynamic libraries
export default async function fix_rpaths(installation: Installation, pkgs: string[]) {
  console.info("doing SLOW rpath fixes…")
  for await (const [exename] of exefiles(installation.path)) {
    await set_rpaths(exename, pkgs, installation)
  }
}


//TODO it's an error if any binary has bad rpaths before bottling
//NOTE we should have a `safety-inspector` step before bottling to check for this sort of thing
//  and then have virtual env manager be more specific via (DY)?LD_LIBRARY_PATH
//FIXME somewhat inefficient for eg. git since git is mostly hardlinks to the same file
async function set_rpaths(exename: Path, our_rpaths: string[], installation: Installation) {
  if (host().platform != 'linux') throw new Error()

  const cmd = await (async () => {
    //FIXME we need this for perl
    // however really we should just have an escape hatch *just* for stuff that sets its own rpaths
    const their_rpaths = (await backticks({
        cmd: ["patchelf", "--print-rpath", exename],
      }))
      .split(":")
      .compact(x => x.chuzzle())
      //^^ split has ridiculous empty string behavior

    const rpaths = [...their_rpaths, ...our_rpaths]
      .map(x => {
        const transformed = transform(x, installation)
        if (transformed.startsWith("$ORIGIN")) {
          console.warn("has own special rpath", transformed)
          return transformed
        } else {
          const rel_path = new Path(transformed).relative({ to: exename.parent() })
          return `$ORIGIN/${rel_path}`
        }
      })
      .uniq()
      .join(':')
      ?? []

    //FIXME use runtime-path since then LD_LIBRARY_PATH takes precedence which our virtual env manager requires
    return ["patchelf", "--force-rpath", "--set-rpath", rpaths, exename]
  })()

  if (cmd.length) {
    const { success } = await Deno.run({ cmd: cmd.map(x => `${x}`) }).status()
    if (!success) {
      console.warn("patch-elf failed")
      //FIXME allowing this error because on Linux:
      //    patchelf: cannot find section '.dynamic'. The input file is most likely statically linked
      // happens with eg. gofmt
      // and we don't yet have a good way to detect and skip such files
    }
  }
}

//FIXME pretty slow since we execute `file` for every file
// eg. perl has hundreds of `.pm` files in its `lib`
async function* exefiles(prefix: Path): AsyncGenerator<[Path, 'exe' | 'lib']> {
  for (const basename of ["bin", "lib", "libexec"]) {
    const d = prefix.join(basename).isDirectory()
    if (!d) continue
    for await (const [exename, { isFile, isSymlink }] of d.walk()) {
      if (!isFile || isSymlink) continue
      const type = await exetype(exename)
      if (type) yield [exename, type]
    }
  }
}

//FIXME lol use https://github.com/sindresorhus/file-type when we can
export async function exetype(path: Path): Promise<'exe' | 'lib' | false> {
  // speed this up a bit
  switch (path.extname()) {
    case ".py":
    case ".pyc":
    case ".pl":
      return false
  }

  const out = await backticks({
    cmd: ["file", "--mime-type", path.string]
  })
  const lines = out.split("\n")
  const line1 = lines[0]
  if (!line1) throw new Error()
  const match = line1.match(/: (.*)$/)
  if (!match) throw new Error()
  const mime = match[1]

  console.debug(mime)

  switch (mime) {
  case 'application/x-pie-executable':
  case 'application/x-mach-binary':
  case 'application/x-executable':
    return 'exe'

  case 'application/x-sharedlib':
    return 'lib'
  default:
    return false
  }
}

// convert a full version path to a major’d version path
// this so we are resilient to upgrades without requiring us to rewrite binaries on install
// since rewriting binaries would invalidate our signatures
function transform(input: string, installation: Installation) {
  if (input.startsWith("$ORIGIN")) {
    // we leave these alone, trusting the build tool knew what it was doing
    return input
  } else if (input.startsWith(installation.path.parent().string)) {
    // don’t transform stuff that links to this actual package
    return input
  } else {
    //FIXME not very robust lol
    return input.replace(/v(\d+)\.(\d+\.)+\d+[a-z]?/, 'v$1')
  }
}
