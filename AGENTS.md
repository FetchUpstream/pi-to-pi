## Purpose

Work primarily on the requested code change. Do not spend excessive time, tokens, or context repeatedly proving that unchanged code still works.

The default loop is:

1. Read only the files needed to understand the task.
2. Make the smallest coherent implementation.
3. Run the narrowest relevant verification.
4. Fix actual failures.
5. Stop when the requested change is complete and verified.

Implementation is the work. Testing supports implementation; it is not the main activity.

## Node.js Development Rules

### Use the project's existing tooling

Before inventing commands, inspect `package.json` and use the scripts already provided by the repository.

Prefer commands such as:

```
npm test -- <target>
npm run test -- <target>
npm run lint
npm run typecheck
npm run build
```

Use the repository's actual package manager (`npm`, `pnpm`, `yarn`, or `bun`) as indicated by its lockfile and existing documentation.

Do not replace established project scripts with custom one-off Node commands.

### Do not use inline Node as a substitute for proper work

Avoid commands such as:

```
node --input-type=module -e '...'
node -e '...'
node <<'NODE'
...
NODE
```

Do not use inline Node programs to:

- recreate application logic;
- manually simulate unit tests;
- inspect values that can be understood from the source;
- repeatedly probe imports;
- duplicate behavior already covered by tests;
- build temporary test harnesses for ordinary changes.

Inline Node execution is acceptable only when it is genuinely the shortest way to answer a small, otherwise difficult environment-specific question. It must not become the normal development workflow.

If a behavior deserves repeatable verification, add or update a real test instead of constructing an ephemeral script.

## Testing Discipline

### Implement first, verify second

Do not continuously run tests after every small edit.

Make a coherent change first. Then run the smallest useful verification for that change.

Good:

```
read relevant code
→ implement change
→ run targeted test
→ fix failure if any
→ run targeted test again
→ optionally run broader validation
→ finish
```

Bad:

```
read one function
→ run experiment
→ read another function
→ run experiment
→ edit one line
→ run tests
→ edit another line
→ run tests
→ run custom Node script
→ run tests again
```

### Prefer targeted verification

Use the narrowest command that provides meaningful confidence.

Preferred order:

1. Existing test for the changed module or behavior.
2. Targeted typecheck/lint for the affected area, when supported.
3. Relevant package test suite.
4. Full repository suite only when necessary.

Do not run the entire test suite repeatedly while developing a small change.

### Do not test unchanged assumptions repeatedly

Once a command has passed, do not rerun it unless:

- relevant code changed afterward;
- a later failure gives reason to suspect it;
- final repository policy explicitly requires it.

Do not repeatedly re-check Node versions, imports, package availability, module resolution, or configuration after they have already been established.

### Treat failures as information

When a test fails:

1. Read the actual failure.
2. Identify the likely cause.
3. Make a focused fix.
4. Rerun the failing test.

Do not respond to one failure by launching many unrelated commands.

Do not brute-force the repository with repeated test variations when the error message or source code can answer the question directly.

## Context Efficiency

Every command consumes time and context. Prefer information-dense actions.

Do:

- read the relevant source;
- search directly for symbols and call sites;
- inspect `package.json` once;
- use existing tests as executable documentation;
- batch related edits;
- run concise targeted checks.

Avoid:

- large unfiltered logs;
- repeated full-file reads;
- repeated `package.json` inspection;
- dumping entire test suites into context;
- exploratory scripts with large output;
- commands whose result will not change the implementation decision.

When command output is large, request or inspect only the relevant section.

## Code Changes

### Keep changes scoped

Only modify what is required for the task.

Do not:

- refactor unrelated code;
- rename unrelated symbols;
- reformat entire files;
- update dependencies without need;
- introduce new tooling merely to test the change;
- create helper abstractions for a single trivial use unless they materially improve the implementation.

### Follow existing patterns

Prefer the repository's current:

- module system;
- TypeScript/JavaScript conventions;
- error-handling style;
- test framework;
- dependency choices;
- file organization;
- naming conventions.

Do not introduce a new pattern when an adequate one already exists.

### Write production code, not diagnostic scaffolding

Temporary logging, debug helpers, throwaway scripts, and experimental files should not be left behind unless they are explicitly part of the requested change.

If temporary instrumentation is necessary, remove it before finishing.

## Dependency Management

Do not install a package unless the task genuinely requires it.

Before adding a dependency, check whether:

- the platform already provides the capability;
- an existing dependency already solves the problem;
- a small local implementation is clearer.

Never add a package solely to make an ad-hoc test easier.

Do not upgrade unrelated dependencies.

## Verification Budget

For a normal focused change, aim for:

- one targeted verification after the initial implementation;
- one rerun after fixing any discovered issue;
- one broader final check only when justified.

This is a guideline, not a prohibition against necessary testing. Use more verification when risk warrants it, but every additional test command should have a clear reason.

For trivial changes, static inspection may be sufficient if repository policy does not require automated validation.

For high-risk changes involving persistence, security, concurrency, authentication, money, migrations, or public APIs, use appropriately stronger verification.

## When to Stop

Stop investigating when all of the following are true:

- the requested behavior is implemented;
- the changed code is internally consistent;
- the relevant targeted verification passes;
- no known failure remains;
- no acceptance criterion is unresolved.

Do not continue searching for hypothetical problems after the task is complete.

Do not invent additional work.

## Reporting

At completion, report concisely:

- what changed;
- which relevant verification was run;
- any known limitation or unresolved issue.

Do not paste long command logs unless specifically requested.

## Core Rule

Use Node.js to build the application, not to create an endless sequence of disposable experiments.

Read deliberately. Implement coherently. Verify narrowly. Finish.