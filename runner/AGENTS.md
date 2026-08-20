# Expo Harmony Fast orchestrator

- Preserve the compact model-visible sequence brief → code. Capability resolution,
  dependency setup, typecheck, Harmony Go export/launch, and evidence are deterministic.
- Do not add HTML design artifacts, ArkTS generation, native edits, subagents, or a
  controller DAG.
- Every Expo import must be allowed by the selected devkit `harmony-support.json`.
- Third-party React Native imports must be allowed by the selected devkit compatibility
  contracts or an explicit Harmony Go runtime override. Select all product capabilities
  from `.expo-fast/capability-catalog.json` at exact versions. Use local
  `react-native-svg` primitives for icons/charts. Use AsyncStorage only for bulk,
  non-sensitive persistence when its host-specific catalog entry is available; reserve
  SecureStore for small secrets.
- Product agents may edit `App.tsx`, `src/**`, assets, tests, permitted `app.json`
  metadata, `.expo-fast/brief.json`, and only the `dependencies` object of `package.json`.
  Preserve scaffold dependencies. Never edit `harmony/`, `.expo/`, Metro config,
  devDependencies, lockfiles, or the SDK.
- Use `useWindowDimensions().width` as logical layout width: phone `<640`, tablet
  `640–1279`, desktop `>=1280`. Multi-destination phone layouts use bottom navigation
  and one column; tablet layouts use top horizontal navigation; desktop layouts put a
  fixed-width left sidebar and flexible multi-column main content inside the same
  horizontal root container. Never derive breakpoints from physical device pixels.
- For runtime QA, verify the resolved Harmony Go bundle name before and after the
  action. Resolve it from `EXPO_HARMONY_GO_BUNDLE_NAME`, then HAP metadata, with
  `com.example.myapplication1.ide` as the fallback; assert an app-specific
  accessibility value change and save a screenshot.
- Run `npm test` after workflow changes. The retired skill package no longer has a
  `SKILL.md` target for the skill-creator validator.
