# src/core: the contract

Owner: lead engineer. Everything here is specified by [docs/CONTRACT.md](../../docs/CONTRACT.md); a change to any file in this directory is a contract change (edit the document, the code and `tests/contract.test.ts` in one commit, and say why).

## Responsibilities

- Types shared across modules (`types.ts`) and module interfaces (`contract.ts`).
- Constants (`constants.ts`): units, the mass quantum, clocks, presets, size ceiling, brain classes, ledger constants, protocol version.
- Deterministic maths (`dmath.ts`) and the Philox4x32-10 RNG (`rng.ts`).
- Hashes (`hash.ts`): CRC-32, xxh64 (32-bit halves, no BigInt in the hot path), `hash32` for stable neuron ids.
- SoA allocation (`soa.ts`), column layouts (`layout.ts`), world allocation and the state hash (`world.ts`, `globals.ts`), fixed-point and carry helpers (`fixed.ts`).
- Codecs: genome format v1 (`genome-schema.ts`, `genome-format.ts`), CBOR (`cbor.ts`), the view protocol (`protocol.ts`), the `.ptk` container (`container.ts`), `.ptkg` and `PTK1.` strings (`ptkg.ts`).

## Interfaces

Owns every interface in CONTRACT sections 1 to 8 and 10 to 15 at the type and byte level. Imports nothing outside `src/core`.

## Review findings addressed here

- **R1** (one contract): this directory plus the contract test, which also checks that every `T.*` and `BT.*` gene name used anywhere in `src` exists in the schema.
- **R8** (ranges): mass in 1 ng quanta as exact integers in f64, u64-as-two-u32 on GPU, carries for sub-quantum flows.
- **R16** (determinism): counter-based RNG, deterministic maths, `tests/determinism-lint.test.ts`.
- **R21** (id wrap): u64 entity ids (JS numbers below 2^53, written as u64).
- **R22** (innovation ids): the duplication key and 64-bit CPPN ids are specified in CONTRACT 6.8.
- **R26** (bit-exact versus fast CPU path): the CPU backend is f64 with deterministic maths and is bit-identical on every engine, so it is both the oracle and usable; a faster WASM path, if needed, must agree statistically.

## Acceptance tests

`tests/core/*.test.ts` (Philox known answers, xxh64 against a BigInt reference, CRC-32 check value, dmath accuracy, genome forward compatibility, CBOR strictness, protocol and container round trips), `tests/contract.test.ts`, `tests/determinism-lint.test.ts`, `tests/boundaries.test.ts`.
