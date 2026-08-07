# Process-level tests

Process-level coverage is reserved for real Pi child runtimes and selected transport bindings. The v1 protocol itself remains transport-independent; process tests should verify endpoint setup, binding authentication, reload fencing and delivery failure reporting without changing envelope semantics.
