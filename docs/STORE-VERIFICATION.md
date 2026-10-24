# Store installation verification

Not verified: Raycast result rendering and Store screenshots. Orca could not read Raycast's accessibility window, despite macOS reporting Accessibility and Screen Recording permissions as granted. No screenshots were fabricated, edited, or submitted. The Store PR must remain a draft until at least two actual Window Capture images are added.

## What users do

1. Install the extension from the Store and open any of its three commands. Raycast executes setup on first command launch, not at the moment the Store installation completes.
2. Keep the command open while it downloads and verifies the helper and models. No Terminal, compiler, separately installed Node, or API key is required.
3. Open Manage Content Index, choose folders, wait for searchable files, then describe a file in Search File Contents. macOS folder-access prompts still require the user's approval.

The helper is a public, versioned GitHub release containing the native engine, Node 22.22.2, the service bundle, and license notices. The extension pins the archive size and SHA-256 in service/artifacts.ts. Both model files retain their revision and SHA-256 pins. No helper binaries or model weights are committed to the Store extension.

## Verified on macOS 27.0.1, Apple Silicon

- The public 0.2.1 helper and both models downloaded into fresh temporary state, without model symlinks or a developer-service build. The service became healthy through its real launchd registration. Its initial selected-folder list was empty.
- After selecting two synthetic documents, the released helper returned lease.txt first for “restrictions on domestic animals” in 496 ms and 860 ms across two clean-install runs. This was a real EmbeddingGemma 2 query, not a mocked result or a UI screenshot.
- Removal stopped the socket service. Reinstallation restored the normal service using its bundled Node and preserved the existing saved configuration. No personal folders were added or removed by the test.
- The broader real-model E2E passed semantic retrieval, watcher updates, pause/resume without Raycast, unavailable-folder retention, deletions, secret exclusions, PDF/image/audio/video matches, native scope, Unicode paths, and final-folder cleanup.
- 46 TypeScript tests, 80 native core tests, and 6 native runtime/reference tests pass (132 total). Lint, typecheck, native/extension builds, Raycast validation, and npm audit pass. Audit reports no vulnerabilities.

The runtime-only Store package also passes npm install, Raycast lint, and plain ray build. It contains no native source/tests, scripts, docs, examples, tsx, or separate service-build dependency.

## Failures found during installation testing

- launchctl bootout can return before launchd removes the job. Immediate bootstrap returned EIO. Registration now retries that error within a bounded deadline; its regression failed before the fix and passes afterward.
- Starting a filesystem watch on a selected protected folder blocked the service's main thread inside open(). A native process sample confirmed the stack. Watch startup now runs on a separate thread, keeping socket readiness and controls responsive while macOS waits for folder access.
- A failed rollback could delete the only backup of an older helper. The backup is now retained if rollback cannot complete; its regression failed before the fix.
- Removal could hide a launchd inspection error and report success. Only an explicitly missing job is ignored now; permission/transport failures are shown to the user.

## Reproduce as a developer

```sh
npm test
npm run test:native
npm run test:e2e
npm run lint
npm run typecheck
npm run build
npm audit
npx tsx scripts/store-proof.ts
```

store-proof.ts temporarily uses this extension's launchd label, exercises fresh public downloads and synthetic files, and restores the normal installation afterward. Do not run it concurrently with another installation. Test dependencies belong in this source repository, not the Store package.

## Pending

Capture Search File Contents with a synthetic match/detail pane and Manage Content Index using Raycast Window Capture with Save to Metadata. Keep the captures unmodified. Then verify the visible screens, add metadata to the PR, and mark it ready for review. Older supported macOS versions and an actual iCloud eviction remain untested.
