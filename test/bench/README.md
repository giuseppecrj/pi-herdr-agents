# Supervision benchmark

Run this manual benchmark from inside Herdr:

```bash
node --experimental-strip-types test/bench/supervision-bench.mjs
```

It creates an isolated Herdr server, scratch HOME, held child panes, and a
PATH-first `herdr` logging shim. It runs 20-second steady-state windows for
1, 5, and 10 children (three rotated rounds at 10) and writes raw samples plus
gate results to `/tmp/issue29-bench/`. It is intentionally excluded from
`npm test` and the npm tarball. The benchmark cleans only its own server,
workspace, panes, and scratch directory.
