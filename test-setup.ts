// Loaded by `bun test` before any test file (see bunfig.toml). The todo example's SQLite store reads
// `TODO_DB` at import time; pinning it to an in-memory database here keeps the whole suite hermetic and
// deterministic — tests get a fresh, isolated todo world (reset per test), and never read or clobber the
// persisted demo file a human builds up by running serve.ts / cli.ts.
process.env.TODO_DB = ":memory:";
