# Swamp runs checks

Run from the repository root with Node.js 22 or later:

```sh
node --test tests/swamp-runs.test.cjs
node --check mods/swamp-runs/main.js
git diff --check
```

The tests load the shipped mod with small stubs for Herdr and GPUI. No dependencies,
credentials, live repositories or Swamp processes are needed. They cover:

- Inclusive time boundaries, open workflows, separate repositories, invalid dates,
  overlapping windows, input order and unchanged input objects.
- 4,000 seeded differential histories against the previous implementation.
- Refresh caching, repeated render calls, failure notifications and failed reads.
- A synthetic history of 6,000 methods and 950 workflows. Timing is informational;
  the test checks equivalent output and a deterministic bound on date parsing.

`top-level-original.cjs` preserves the old function from commit
`0d5e2c523061e9a59ef8f042f722e60784e0885e` as the comparison reference.

These checks reproduce the expensive algorithm, not the native Herdr `interrupted`
error. A native smoke test should open the panel against a large scratch history,
refresh, change filters, expand a row and check failure counts and notifications.
