# Coding standards

Judgement rules enforced at review. The mechanical rules — non-null assertions, the rxjs/operators ban, import-type discipline — are wired in `eslint.config.mts` and are not repeated here. Read this file against a diff before approving it.

## The fiction rule: test fakes must model the real dependency

A green spec proves nothing if its fake fictionalizes the library. Both gate-3 findings in the #88 work were fakes whose semantics diverged from the installed packages while the tests stayed green.

- A fake reproduces the dependency's observable behavior at every boundary the code under test exercises — not the behavior that makes the test convenient. Two divergences that shipped: esphome-ts v4's `alive$` is a `BehaviorSubject(false)` behind `shareReplay(1)`, so every subscriber receives a buffered `false` synchronously at subscribe; hap's `getCharacteristic(class)` never returns `undefined` — it auto-adds, logging a warning for services that do not list the characteristic as optional.
- Reach for real classes from installed dependencies first; a hand-rolled fake earns its place only at boundaries that cannot run in-process.
- Hap service and characteristic fakes come from the shared harness in `src/testing/` — do not re-derive hap semantics inline in a spec.

## HAP idioms

- `testCharacteristic(class)` is the existence check. `getCharacteristic(class)` is retrieval only, after existence is guaranteed — used as an existence probe it auto-adds with per-service warnings in production.
- A programmatically added characteristic gets an immediate `setValue` whenever its HAP default differs from the intended state.
- HAP values come from `api.hap`; HAP classes are type-only in `'homebridge'`. Handlers are `.onSet`/`.onGet` throwing `HapStatusError(HAPStatus.…)`.

## TypeScript and rxjs

- No `as`-cast where a guard or a generic earns its keep; the sanctioned escape is the boundary cast in spec harnesses. Hunt casts that silence a real variance the types are trying to report.
- Guard a `Map`/record lookup once, where the key arrives — not at every downstream use.
- Every subscription has an owner responsible for its teardown; errors on hot device streams are handled once at a named seam, not re-caught downstream.
