# Slimming — choosing, reusing, mapping features

Contents: Choosing how to slim · Reuse a previous result · Features → Simless slim items (iOS, Android)

## Choosing how to slim

When you create a slim device, or the user asks to change how one is slimmed, pick one of three:

1. **Full slim** (the default) — for UI and layout checks. Everything that can be turned off is off.
2. **Keep what the app needs** — for testing an app feature that relies on the device (push notifications, universal links, photo picker, contacts, location, camera …).
   - Find the features the app needs and map them to slim items — follow SKILL.md «Finding what the app needs».
   - Items differ per platform (`simless --json catalog` → `slimOff[]`: `id`, `name`, and — for iOS categories and Android settings and hardware — `detail` saying what stops working; Android package groups have no `detail`, and `avdslim profiles` lists their packages): iOS has simslim categories, Android has avdslim package groups, device settings and emulator hardware.
   - Tell the user which items you keep and why, then create with `--slim-keep <id,…>`.
3. **Custom** — the user names what to keep. Pass those IDs.

Change an existing device (only one Simless created) with `simless slim <device> --keep <id,…>` (or `--full` to go back to full slim, `--off` to remove slimming). iOS re-slims in 1–2 minutes; Android camera and audio take effect at the next boot. Use `--no-slim` only when the test needs a stock device.

## Reuse a previous result

If the app root (the folder with `app.json` / `package.json`; in a monorepo, the app's folder) has `.device-slim.json`, check whether it is still current before reading the app again:

```json
{
  "features": {
    "push": "ios/MyApp/MyApp.entitlements: aps-environment",
    "photos": "ios/MyApp/Info.plist: NSPhotoLibraryUsageDescription; expo-image-picker (3 files import it)",
    "location": "android/app/src/main/AndroidManifest.xml: ACCESS_FINE_LOCATION"
  },
  "sources": ["ios/MyApp/MyApp.entitlements", "ios/MyApp/Info.plist", "android/app/src/main/AndroidManifest.xml", "package.json", "patches/"],
  "sourcesHash": "sha256:9f2c…"
}
```

Hash the `sources` (paths are relative to the app root) the same way it was made:

```sh
find <sources…> -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256 | cut -d' ' -f1
```

1. Same hash, and no new evidence file since (a new patch, local module, extension target or config plugin — the places the `app-*.md` files list) → use `features` as is.
2. Otherwise → read the app again (SKILL.md «Finding what the app needs») and **write the file from scratch**, so features and sources that are gone disappear. Tell the user what changed («added location, dropped camera»).
3. The native folders appeared or were removed since (a prebuild, or a clean) → read the app again: the evidence changed place. When there were no native folders, the evidence was `expo config --type introspect`, so `sources` lists the app config, `.env` and local plugins.

Write or update `.device-slim.json` only if the user agrees. If they don't want it in the repository, add `/.device-slim.json` to `.git/info/exclude`.

## Features → Simless slim items

Item IDs are what `simless --json catalog` lists in `slimOff[].id`. Simless keeps whole items (a simslim category, an avdslim package group, setting or hardware) — not single daemons or packages. The IDs below were checked with simslim 0.12.0 and avdslim 1.0.15; if the catalog shows different ones, use the catalog — its `detail` text, or for an Android package group the packages `avdslim profiles` lists under it.

### iOS

| App feature | Evidence to look for | Keep |
| --- | --- | --- |
| Remote push notifications | `aps-environment` entitlement, notification library | `store` |
| In-app purchases (StoreKit) · Wallet · Apple Pay | in-app purchase library, StoreKit config, PassKit | `store` |
| Universal links / associated domains | `com.apple.developer.associated-domains` | `web` |
| Photo picker / photo library | `NSPhotoLibraryUsageDescription`, image picker library | `photos` |
| Contacts · Calendar · Reminders · Mail compose | `NSContactsUsageDescription`, `NSCalendarsUsageDescription`, `NSRemindersUsageDescription`, mail composer | `pim` |
| iCloud sync · Sign in with Apple · iCloud Keychain | iCloud / Sign in with Apple entitlements **in the app as it is now** | `icloud` |
| HealthKit · HomeKit | HealthKit / HomeKit entitlements | `health` |
| Widgets · Live Activities | widget extension, live activity library | `widgets` (about 675 MB — the heaviest) |
| Siri · speech recognition | SiriKit, `NSSpeechRecognitionUsageDescription` | `siri` |
| Spotlight / in-app search indexing | Core Spotlight usage | `search` |
| Maps background data · Weather · News · game controllers · game save sync | MapKit, WeatherKit, GameController, GameKit saved games | `apps` |
| iMessage · FaceTime | — | `messaging` |
| AirDrop · Continuity · Find My | sharing / nearby features | `connectivity` |
| Screen Time · Family | Family Controls entitlement | `family` |

**Never slimmed on iOS** — nothing to keep: camera, microphone, location, sign-in services (AuthenticationServices / web auth sessions), Face ID, App Tracking Transparency, Game Center (simslim 0.12.0 and later keep it on; an older slim turns it off until the simulator is slimmed again). **Check by hand after slimming**: the tracking prompt, Face ID, web sign-in sessions (Google / Firebase sign-in). Don't keep `web` «for sign-in» — no sign-in service is in it. The Contacts, Photos and Calendar pickers can act up without their categories — keep `pim` / `photos` when a test opens them.

### Android

| App feature | Evidence to look for | Keep |
| --- | --- | --- |
| Location | `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | `location` |
| Background work, timely push while the app is in the background | background tasks, FCM | `bglimit` (otherwise 4 background processes) |
| Account sync | the app syncs through Android's sync framework — a `SyncAdapter` / `AbstractAccountAuthenticator` service in the manifest, `ContentResolver.requestSync`, accounts added with `AccountManager`. Not in-app Google Sign-In (last row) | `sync` |
| Bluetooth | `BLUETOOTH_*` permissions | `bluetooth` |
| First-run setup state | apps that read setup state (rare) | `setup` |
| Camera | `CAMERA` permission, camera library | `camera` (emulator hardware — takes effect at the next boot) |
| Microphone · audio playback | `RECORD_AUDIO`, audio / video playback | `audio` (emulator hardware — next boot) |
| System photo picker | `PickVisualMedia` / `ACTION_PICK_IMAGES`, or `ACTION_GET_CONTENT` with an image type. An image picker library is evidence only through the intent it uses — check its Android source | nothing — the system photo picker and DocumentsUI aren't turned off |
| Opens Google Maps, Google Photos or YouTube, or picks with `ACTION_PICK` | `geo:` / maps intents, intents naming those apps; `ACTION_PICK` with an image type (once Photos is off no other app handles it) | `media-consumer-apps` |
| Opens the dialer, contacts or messaging app | `tel:` / `sms:` intents, contacts intents | `telephony-emergency-satellite` |
| Opens the calendar, clock or calculator app | calendar / alarm intents | `telemetry-feedback-screensavers` |
| Text-to-speech · accessibility tests | TTS, TalkBack testing | `accessibility-speech` |
| Push (FCM) · Google Sign-In · WebView | Firebase messaging, Google sign-in (Credential Manager / Play services) | nothing — never turned off; pair push with `bglimit` |
