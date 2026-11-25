# Coding standards

Judgement rules enforced at review. The mechanical rules — non-null assertions, the rxjs/operators ban, import-type discipline — are wired in `eslint.config.mts` and are not repeated here. Read this file against a diff before approving it.

## The fiction rule: test fakes must model the real dependency

A green spec proves nothing if its fake fictionalizes the library. Both gate-3 findings in the #88 work were fakes whose semantics diverged from the installed packages while the tests stayed green.

- A fake reproduces the dependency's observable behavior at every boundary the code under test exercises — not the behavior that makes the test convenient. Two divergences that shipped: esphome-ts v4's `alive$` delivers a buffered `false` synchronously at subscribe, but that buffered value originates from `socket.connected$`'s `BehaviorSubject(false)` merged into `alive$` (which is `distinctUntilChanged` + `shareReplay(1)` over that merge), not from `alive$` itself being a BehaviorSubject; hap's `getCharacteristic(class)` never returns `undefined` — it auto-adds, logging a warning for services that do not list the characteristic as optional.
- Reach for real classes from installed dependencies first; a hand-rolled fake earns its place only at boundaries that cannot run in-process.
- Hap service and characteristic fakes come from the shared harness in `src/testing/` — do not re-derive hap semantics inline in a spec.

## HAP idioms

- `testCharacteristic(class)` is the existence check. `getCharacteristic(class)` is retrieval only, after existence is guaranteed — used as an existence probe it auto-adds with per-service warnings in production.
- A programmatically added characteristic gets an immediate `setValue` whenever its HAP default differs from the intended state.
- Device pushes use `updateValue`, never `setValue` — `setValue` re-enters the registered `onSet` handler (@homebridge/hap-nodejs Characteristic.js), so pushing device state with it echoes commands back to the device; `updateValue` writes silently and still notifies HomeKit clients on change.
- HAP values come from `api.hap`; HAP classes are type-only in `'homebridge'`. Handlers are `.onSet`/`.onGet` throwing `HapStatusError(HAPStatus.…)`.
- A component-binding row declares its getter: `read` is required, and `read: null` only when the Component exposes no live accessor (light On). A row whose Component can report live state must not leave its GET to the pushed value. When a live accessor reports "not known yet", `read` throws (the binding maps it to `SERVICE_COMMUNICATION_FAILURE`) and `project` returns `undefined` (the push skips); the two paths never share a throw. A row may instead serve a benign rest value when that is the safe default — fan's `INACTIVE`/direction default/`SWING_DISABLED`/`0` speed, non-RGB Brightness's `0`, switch and binary-sensor `status` before the first state, a preset or effect row's `false`, cover `HoldPosition`'s constant `false` — and states the reason in a row comment where it is not self-evident; never invent one where "unknown" is the honest answer (sensor, cover position). Where the library itself collapses unknown to a rest value (light `hsv` returning `{0, 0, 0}`, `status` via `!!state?.state`, `presetMode ?? ''`, `effect ?? 'None'`), the rule cannot apply.

## TypeScript and rxjs

- No `as`-cast where a guard or a generic earns its keep; the sanctioned escape is the boundary cast in spec harnesses. Hunt casts that silence a real variance the types are trying to report.
- Guard a `Map`/record lookup once, where the key arrives — not at every downstream use.
- Every subscription has an owner responsible for its teardown; errors on hot device streams are handled once at a named seam, not re-caught downstream.
