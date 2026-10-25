# Store installation verification

Search results, the detail pane, and Manage Content Index were verified in Raycast with a real synthetic index. Both required Store images were captured by Raycast's native Capture Window command, reviewed, and copied unchanged into metadata/.

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
- 53 TypeScript tests, 80 native core tests, and 6 native runtime/reference tests pass (139 total). Lint, typecheck, native/extension builds, Raycast validation, and npm audit pass. Audit reports no vulnerabilities.

The runtime-only Store package also passes npm install, Raycast lint, and plain ray build. It contains no native source/tests, scripts, docs, examples, tsx, or separate service-build dependency. Its explicit `ray build -e dist` output was then loaded into Raycast: the minified Search command returned the synthetic lease excerpt, and its Manage action opened the live three-file index.

## Failures found during installation testing

- launchctl bootout can return before launchd removes the job. Immediate bootstrap returned EIO. Registration now retries that error within a bounded deadline; its regression failed before the fix and passes afterward.
- Starting a filesystem watch on a selected protected folder blocked the service's main thread inside open(). A native process sample confirmed the stack. Watch startup now runs on a separate thread, keeping socket readiness and controls responsive while macOS waits for folder access.
- A failed rollback could delete the only backup of an older helper. The backup is now retained if rollback cannot complete; its regression failed before the fix.
- Removal could hide a launchd inspection error and report success. Only an explicitly missing job is ignored now; permission/transport failures are shown to the user.

## Follow-up review fixes

- Setup ownership now uses macOS `lockf -k` on a permanent inode, held by a pipe-controlled system helper. No PID parsing, stale-file deletion, or PID-file write can grant ownership. Empty/partial/dead-PID files and two forced stale-recovery contenders are covered; a real owner process is killed to verify crash recovery. The portable command form avoids newer descriptor-only lockf syntax.
- An intact helper with an unavailable socket reports stopped and restarts from installed files. The real launchd restart passed with fetch disabled and zero network requests; configuration stayed byte-for-byte unchanged. Explicit removal still prevents automatic restart, and missing files require setup. Restart failure offers offline retry or explicit online repair.
- Preferences use Raycast's generated Preferences type. Both root and staged TypeScript configurations include raycast-env.d.ts; the file remains generated, not committed.
- Live UI verification exposed duplicate startup effects racing their own lock. A command-local shared operation now coalesces those calls. Regression tests cover replay and retry; the distribution UI recovered the stopped service and displayed Ready without the stale failure message.

One early parallel run timed out waiting for an unchanged lifecycle fixture. It passed alone, and the complete serial and parallel reruns passed without changing the test timeout. The cause of that transient failure was not established.

## Reproduce as a developer

```sh
npm run build
npm test
npm run test:native
npm run test:e2e
npm run lint
npm run typecheck
npm run build
npm audit
npx tsx scripts/store-proof.ts
npx tsx scripts/offline-proof.ts
```

store-proof.ts temporarily uses this extension's launchd label, exercises fresh public downloads and synthetic files, and restores the normal installation afterward. Do not run it concurrently with another installation. Test dependencies belong in this source repository, not the Store package.

## Native UI and screenshots

- [Search and detail pane](../metadata/local-content-search-1.png): “restrictions on domestic animals” returns lease.txt and its actual indexed excerpt.
- [Manage Content Index](../metadata/local-content-search-2.png): three synthetic files, zero pending work, three vectors, and the selected Sample Documents folder.

Both images are native 2000×1250 PNGs, dark mode, default interface size, Raycast 2.9.0 on an Apple Silicon Mac running macOS 27.0.1. They use the same wallpaper. No resize, recolouring, reframing, annotations, or generated replacement content was applied. Their SHA-256 values match the original desktop captures:

```text
299034bcca966934992e98c61f362b55176a1361b5eec2ee3ee7966dbef611c1  local-content-search-1.png
5d8ea338bcdad214951f0fb39f0bb6bafa71285d4edbe3197c07c237c7e29ada  local-content-search-2.png
```

This Raycast version saves native captures to the Desktop; the unchanged files were copied into metadata/. Automated capture was unreliable, so the operator triggered the final capture manually. Accessibility worked without a permission toggle; the earlier permission diagnosis was not established.

scripts/ui-proof.ts serves a separate synthetic index on the normal socket while the normal LaunchAgent is temporarily stopped. It never replaces the user's configuration or index. After capture, it restored the normal service, checked health, and verified the saved configuration was byte-for-byte unchanged. Temporary Capture Window and development-window preferences were restored afterward.

## Limits

Older supported macOS versions and an actual iCloud eviction remain untested. The Store review and merge are still the maintainers' decision.
