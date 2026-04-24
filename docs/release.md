# Release Checklist

This document covers how CUT3 desktop releases are built, optionally signed, and published from one tag.

## Local desktop builds for your own machine

If you just want a release artifact for your own platform, you do not need to publish a GitHub release.

Start from the repo root:

```bash
bun install
```

Build commands:

- macOS Apple Silicon DMG:
  - `bun run dist:desktop:dmg:arm64`
- macOS Intel DMG:
  - `bun run dist:desktop:dmg:x64`
- Linux x64 AppImage:
  - `bun run dist:desktop:linux`
- Windows x64 NSIS installer:
  - `bun run dist:desktop:win`
  - or `build-windows-installer.bat` from the repo root on Windows

All artifacts are written to `./release`.

If you need a custom target or arch, use the generic entrypoint:

```bash
bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>
```

Examples:

- `bun run dist:desktop:artifact -- --platform mac --target dmg --arch universal`
- `bun run dist:desktop:artifact -- --platform linux --target AppImage --arch arm64`
- `bun run dist:desktop:artifact -- --platform win --target nsis --arch x64`

Practical guidance:

- Build macOS artifacts on macOS.
- Build Linux artifacts on Linux.
- Build Windows artifacts on Windows.
- Unsigned local builds are the normal default.
- Add `--signed` only when you have the signing credentials configured for that platform.
- To reuse an existing `apps/desktop/dist-electron` + `apps/server/dist` build, add `--skip-build`.
- To generate a checksum manifest for a local `./release` directory, run `bun run release:checksums`.

Recommended local verification before sharing artifacts:

- Run `bun run fmt`, `bun run lint`, `bun run typecheck`, and `bun run test` from the repo root.
- Install the browser test runtime with `bun run --cwd apps/web test:browser:install`, then run `bun run --cwd apps/web test:browser`.
- Run `bun run test:desktop-smoke` after the desktop build so Electron launch, bundled backend bootstrap, and the backend ready marker are all rechecked on the target OS.
- The desktop smoke test is intentionally narrow: it verifies launch-time startup and the backend readiness handshake, not full renderer interaction or installer behavior.
- Use `apps/desktop/README.md` together with this release guide when debugging desktop startup or packaging issues.

## What the GitHub workflow does

- Trigger: push a tag matching `v*.*.*`, or run the workflow manually with `workflow_dispatch`.
- Manual workflow runs support `dry_run=true`, which validates the full packaging flow without publishing a GitHub Release or pushing a version-bump commit to `main`.
- Runs quality gates first: lint, typecheck, test, browser tests, and a Linux desktop build/smoke pass.
- Aligns package version strings to the release version before the reusable desktop/server build is produced, so the bundled web/server/desktop metadata matches the tag being published.
- Archives and uploads the prebuilt `apps/desktop/dist-electron` and `apps/server/dist` output from preflight, then each packaging job extracts that bundle and reuses it via `--skip-build` so the matrix does not rebuild the same JS bundles four times.
- Builds four desktop artifacts in parallel:
  - macOS `arm64` DMG and ZIP, named `CUT3-macOS-<version>-<arch>.<ext>`
  - macOS `x64` DMG and ZIP, named `CUT3-macOS-<version>-<arch>.<ext>`
  - Linux `x64` AppImage, named `CUT3-linux-<version>-<arch>.<ext>`
  - Windows `x64` NSIS installer, named `CUT3-windows-<version>-<arch>.<ext>`
- Publishes one GitHub Release with all produced files.
  - Versions with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain `X.Y.Z` releases are marked as the repository's latest release.
  - Desktop prerelease artifacts launch as `CUT3`, the same as stable builds.
  - The GitHub Release title is `CUT3 v<version>`.
- Includes Electron auto-update metadata (`latest*.yml` and `*.blockmap`) in release assets.
- Generates and verifies a `SHA256SUMS` manifest before publishing the GitHub Release.
- Optionally publishes the CLI package (`apps/server`, npm package `cut3`) when explicitly enabled.
- Auto-enables signing when the required platform secrets are present.
- Can fail the release instead of silently shipping unsigned macOS/Windows artifacts when signing is required.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `CUT3_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Temporary private-repo auth workaround:
  - set `CUT3_DESKTOP_UPDATE_GITHUB_TOKEN` (or `GH_TOKEN`) in the desktop app runtime environment.
  - the app forwards it as an `Authorization: Bearer <token>` request header for updater HTTP calls.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - `latest*.yml` metadata
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` for both Intel and Apple Silicon.
  - the workflow merges the per-arch mac manifests into one `latest-mac.yml` before publishing the GitHub Release.

## 0) Optional npm OIDC trusted publishing setup (CLI)

The workflow only publishes the CLI when you explicitly opt in:

- `workflow_dispatch` with `publish_cli=true`, or
- repository variable `CUT3_PUBLISH_CLI=true` for tag-triggered releases.

When enabled, it publishes the CLI with `bun publish` from `apps/server` after bumping the package version to the release tag version.

Checklist:

1. Confirm npm org/user owns package `cut3`.
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will, when CLI publishing is enabled:
   - set `apps/server/package.json` version to `X.Y.Z`
   - build web + server
   - run `bun publish --access public`

## 1) Dry-run release without signing

Use this first to validate the packaging pipeline without mutating releases or `main`.

Recommended approach: manual workflow dispatch.

1. Open `.github/workflows/release.yml` in GitHub Actions and run `Release Desktop` manually.
2. Use inputs like:
   - `version=1.0.1-dryrun.1`
   - `publish_cli=false`
   - `require_signing=false`
   - `dry_run=true`
3. Wait for the workflow to finish.
4. Verify the workflow summary shows a dry-run result and the artifact named `release-dry-run-<version>` exists.
5. Download that workflow artifact and confirm it contains all platform assets plus `SHA256SUMS`.
6. Validate the checksum manifest locally if desired:
   - `sha256sum --check SHA256SUMS`
7. Sanity-check installation on each OS before distributing a real release.

Notes:

- Dry runs do **not** publish a GitHub Release.
- Dry runs do **not** push the finalize version-bump commit to `main`.
- Tag pushes are still the path for real releases.

## 2) Signed release policy controls

Release signing is still auto-detected from secrets, but you can now make unsigned macOS/Windows releases fail instead of silently continuing.

Controls:

- Tag-triggered releases:
  - set repository variable `CUT3_REQUIRE_SIGNING=true`
- Manual releases:
  - set workflow-dispatch input `require_signing=true`

Behavior:

- macOS build jobs fail if Apple signing/notarization secrets are missing while signing is required.
- Windows build jobs fail if Azure Trusted Signing secrets are missing while signing is required.
- Linux builds still publish unsigned AppImages, but the release always includes `SHA256SUMS` for integrity verification.
- When signing is enabled, the workflow also verifies:
  - macOS extracted app bundles with `codesign --verify` and `spctl`, plus DMGs with `xcrun stapler validate`
  - Windows installers with `Get-AuthenticodeSignature`

## 3) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Checklist:

1. Confirm Apple Developer account access with permission to create Developer ID certificates.
2. Create a `Developer ID Application` certificate.
3. Export certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store it as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. In App Store Connect, create an API key (team key).
7. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
8. Re-run a tag release and confirm macOS artifacts are signed and notarized.
9. If you want stable releases to fail when signing is unavailable, enable `CUT3_REQUIRE_SIGNING=true`.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 4) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create an Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - endpoint
   - account name
   - certificate profile name
   - publisher name
3. Create or choose an Entra app registration (service principal).
4. Grant the service principal the permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add the Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm the Windows installer is signed.
8. If you want stable releases to fail when signing is unavailable, enable `CUT3_REQUIRE_SIGNING=true`.

## 5) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Confirm the release version is correct.
3. Decide whether signing must be enforced for this run:
   - repository variable `CUT3_REQUIRE_SIGNING=true`, or
   - manual `require_signing=true`
4. Create release tag: `vX.Y.Z`.
5. Push tag.
6. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - release job uploads expected files
   - `SHA256SUMS` is present on the GitHub Release
7. Smoke test downloaded artifacts.
8. Confirm the downloaded app reaches the desktop backend ready state before manual UI checks begin.

## 6) Troubleshooting

- macOS build is unsigned when it should be signed:
  - check all Apple secrets are populated and non-empty
  - enable `CUT3_REQUIRE_SIGNING=true` so the workflow fails instead of silently continuing unsigned
- Windows build is unsigned when it should be signed:
  - check all Azure ATS and auth secrets are populated and non-empty
  - enable `CUT3_REQUIRE_SIGNING=true` so the workflow fails instead of silently continuing unsigned
- Build fails with signing verification errors:
  - retry with signing disabled to isolate packaging vs signing problems
  - re-check certificate/profile names and tenant/client credentials
  - on macOS, confirm notarization credentials are valid and `xcrun stapler validate` passes
- `SHA256SUMS` is missing or wrong:
  - regenerate it locally with `bun run release:checksums`
  - on Linux, validate it with `sha256sum --check SHA256SUMS`
