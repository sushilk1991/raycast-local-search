# Development and helper releases

Store users open a command; they do not run these steps.

## Build locally

Requires Apple Silicon, macOS 14+, 8 GB RAM, Node 22.22.2+, full Xcode with Swift 6.2+, and CMake.

```sh
npm ci
npm run build:native
npm run download:models
npm run install:service
npm run dev
```

The development installer uses your current Node. The Store installer uses the runtime inside the helper release.

## Local release gate

Build first on a fresh checkout so Raycast generates raycast-env.d.ts for the Preferences type.

```sh
npm run build
npm test
npm run lint
npm run typecheck
npm run build
npm run test:native
npm run test:e2e
npm audit
npx ray lint --exit-on-error
```

`npx tsx scripts/offline-proof.ts` stops the installed service, forbids fetch, and verifies recovery with cached files and unchanged configuration. It restores normal registration if verification fails.

E2E uses synthetic files and real models. Fixture generation requires macOS `say` and `ffmpeg`; neither is a runtime dependency.

## Package the helper

1. Run the full local gate before publishing a tag. The helper must be rebuilt if native source or service source changes.
2. Download the official `node-v22.22.2-darwin-arm64.tar.gz` from nodejs.org. Its checksum is pinned in `scripts/package-helper.ts` against the official SHASUMS256.txt.
3. Run `npx tsx scripts/package-helper.ts /path/to/node-v22.22.2-darwin-arm64.tar.gz`. It packages Node, the native engine, service bundle, and license notices, and prints the archive size and SHA-256.
4. Publish the archive at an immutable versioned GitHub release in this repository. Never replace an asset already referenced by a Store release. Update `service/artifacts.ts` to the exact release URL, bytes, SHA-256, and version.
5. Verify a fresh install through that public URL, real queries, and removal/reinstallation. The optional Helper Path preference accepts an extracted release directory, not a bare engine executable.

## Stage the Store submission

```sh
npx tsx scripts/stage-store.ts /tmp/local-search-store
cd /tmp/local-search-store
npm install
npm run lint
npm run build
```

The allowlist excludes native/build source, development scripts, tests, fixtures, docs, generated reports, and tsx. Never submit STATE.md, PROGRESS.md, local logs, account screenshots, downloaded models, or helper binaries to raycast/extensions.

Capture at least two actual Raycast command windows using the native Capture Window command. Use Save to Metadata where available; Raycast 2.9 saves to Desktop, so copy those original PNGs into metadata/. Use synthetic data only. Do not edit, resize, or recolour the captures.

For isolated UI verification, run `npx tsx scripts/ui-proof.ts` after the normal service is installed. It temporarily replaces only the socket service with a synthetic index; the normal configuration and index stay untouched. Keep the process running while inspecting Search and Manage, then stop it with Ctrl-C. Confirm its RESTORED message before finishing. Do not run another installation concurrently.
