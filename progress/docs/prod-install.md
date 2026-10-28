# Installing the progress plugin on a box without npm

A box needs `node_modules` for the CLI and the boards reader to import
`@getpaseo/plugin` and `zod`. Building it on the box is slow and needs network;
this route ships a prepared tree instead.

## Is the tree portable between architectures?

Yes, and it is checked, not assumed.

Built with `npm ci --omit=dev --legacy-peer-deps`, the production tree is
**5 top-level packages, 21 MB unpacked, 3 MB packed, and zero `.node` binaries**.
It is plain JavaScript, so a tree built on an arm64 Mac runs on an x64 ideaPad
unchanged.

`--legacy-peer-deps` matters: without it npm also installs the peers Paseo
supplies to the panel (`react`, `react-native`), which takes the tree to 208 MB
and adds `fsevents`, a darwin-only binary. None of that is loaded by the CLI.

## Build the bundle (on the Mac)

```sh
cd /Users/des/dev/personal/src/paseo-plugins
node scripts/plugin-prod-bundle.mjs --out /tmp
```

It prints a JSON manifest and writes three files beside each other:

- `progress-node_modules-<commit>.tar.gz` — the tree
- `...tar.gz.sha256` — its checksum
- `...tar.gz.json` — commit, branch, build host, install flags, checksum

`workingTreeDirty: true` means `progress/` had changes when it was built, so the
bundle is **not** the commit it names. Build again from a clean tree before
shipping.

## Install it on a box, without touching the live tree until it is proven

`$PLUGIN` is that box's plugin directory, for example
`/home/des/dev/paseo-plugins/progress`. Copy the tarball and its `.sha256` there
first.

```sh
set -e
PLUGIN=/home/des/dev/paseo-plugins/progress
STAGE="$PLUGIN/../.node_modules-stage"
BUNDLE=/tmp/progress-node_modules-<commit>.tar.gz

# 1. verify the artifact before anything else
cd "$(dirname "$BUNDLE")" && sha256sum -c "$(basename "$BUNDLE").sha256"

# 2. stage the tree beside the plugin, not in it
mkdir -p "$STAGE"
tar -xzf "$BUNDLE" -C "$STAGE"          # gives $STAGE/node_modules

# 3. prove the staged tree before the swap: copy the source next to it and run
rsync -a --exclude node_modules "$PLUGIN"/ "$STAGE/src"/
node "$STAGE/src/server/cli.ts" | head -2          # expect: Usage: paseo-progress <command>
node "$STAGE/src/server/boards.ts" | head -c 80    # expect: {"machine":"...
```

Both must work before step 4. If either fails, stop: nothing live has changed.

```sh
# 4. record what the symlink points at now, so the swap can be undone
readlink "$PLUGIN/node_modules" > "$STAGE/previous-target" || echo "none" > "$STAGE/previous-target"

# 5. swap the symlink atomically
ln -sfn "$STAGE/node_modules" "$PLUGIN/node_modules.new"
mv -Tf "$PLUGIN/node_modules.new" "$PLUGIN/node_modules"   # Linux; on macOS: mv -f

# 6. prove it in place, then reload the plugin
node "$PLUGIN/server/cli.ts" | head -2
node "$PLUGIN/server/boards.ts" | head -c 80
paseo plugin reload progress
```

## Roll back

The previous target is in `$STAGE/previous-target`. Restoring it puts the box
exactly where it was:

```sh
ln -sfn "$(cat "$STAGE/previous-target")" "$PLUGIN/node_modules"
paseo plugin reload progress
```

Nothing is deleted by any of this. The old tree the symlink pointed at is left
untouched, which is why the ideaPad's temporary link can stay until its own
install is proven.

## What to check afterwards

- `node "$PLUGIN/server/cli.ts"` prints the usage line, with no `MODULE_NOT_FOUND`.
- `node "$PLUGIN/server/boards.ts"` prints a boards payload, not an import error.
- `paseo plugin ls` shows `progress` running.
- If the box also runs the boards endpoint, its `/v1/boards` answers 200 once the
  reader exists and the token matches the Mac's.
