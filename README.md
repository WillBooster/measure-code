# measure-code

[![Test](https://github.com/WillBooster/measure-code/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/measure-code/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

A command-line tool for measuring code metrics with tree-sitter. It scans a project and reports high-risk files, functions, and React components so you can spot code that is worth refactoring. A [programmatic API](#programmatic-api) is also available.

## Getting started

```sh
# Run without installing
npx measure-code path/to/project

# Or install globally
npm install -g measure-code
measure-code path/to/project
```

The CLI scans JavaScript, JSX, TypeScript, TSX, Python, and Go files. By default it skips generated, vendor, test, and tool directories, prints a summary, and lists the highest-risk findings. TypeScript project metrics and React component classification turn on automatically when a `tsconfig.json` is found.

## Options

| Option                     | Description                                                                   |
| -------------------------- | ----------------------------------------------------------------------------- |
| `--config <path>`          | Use this config file instead of the auto-detected `measure-code.config.json`. |
| `--include-tests`          | Include test files and test directories.                                      |
| `--tsconfig <path>`        | Use this `tsconfig.json` instead of the auto-detected one.                    |
| `--max-findings <n>`       | Maximum number of findings to print (default: 20).                            |
| `--json`                   | Print machine-readable JSON.                                                  |
| `--fail-on-risk`           | Exit with code 1 when any high-risk finding is reported.                      |
| `--fail-on-error`          | Exit with code 1 when any file or directory cannot be scanned.                |
| `--<metric>-threshold <n>` | Override a risk threshold (see below).                                        |

## Risk thresholds

A finding is reported when a measured value is **greater than or equal to** its threshold. Every threshold can be set on the command line (e.g. `--file-loc-threshold 400`) or in a config file; the command line wins over the config file, which wins over the defaults.

`measure-code` looks for `measure-code.config.json` by walking up from the target directory (override with `--config`). The following config reproduces every built-in default:

```json
{
  "thresholds": {
    "fileLoc": 500,
    "functionLoc": 120,
    "componentLoc": 350,
    "cognitive": 25,
    "cyclomatic": 20,
    "call": 50,
    "import": 25,
    "fanOut": 10,
    "parameter": 8,
    "duplicateBlock": 2,
    "transitiveDependency": 25,
    "structuralBreadth": 8,
    "structuralCoordination": 300,
    "stateMutation": 50,
    "duplicateSymbolGroup": 5
  },
  "maxFindings": 20,
  "includeTests": false,
  "failOnRisk": false,
  "failOnError": false
}
```

| Threshold                | CLI flag                              | Reports when a …                                 |
| ------------------------ | ------------------------------------- | ------------------------------------------------ |
| `fileLoc`                | `--file-loc-threshold`                | file's code LOC is large.                        |
| `functionLoc`            | `--function-loc-threshold`            | function's physical LOC span is large.           |
| `componentLoc`           | `--component-loc-threshold`           | React component's physical LOC span is large.    |
| `cognitive`              | `--cognitive-threshold`               | function's cognitive complexity is high.         |
| `cyclomatic`             | `--cyclomatic-threshold`              | function's cyclomatic complexity is high.        |
| `call`                   | `--call-threshold`                    | function makes many calls.                       |
| `import`                 | `--import-threshold`                  | file has many unique import sources.             |
| `fanOut`                 | `--fan-out-threshold`                 | function calls many other in-file functions.     |
| `parameter`              | `--parameter-threshold`               | function declares many parameters.               |
| `duplicateBlock`         | `--duplicate-block-threshold`         | file contains copy-pasted code blocks.           |
| `transitiveDependency`   | `--transitive-dependency-threshold`   | file transitively reaches many local files.      |
| `structuralBreadth`      | `--structural-breadth-threshold`      | file coordinates many structural concerns.       |
| `structuralCoordination` | `--structural-coordination-threshold` | file's structural coordination score is high.    |
| `stateMutation`          | `--state-mutation-threshold`          | file mutates state heavily.                      |
| `duplicateSymbolGroup`   | `--duplicate-symbol-group-threshold`  | file shares many duplicated symbols with others. |

## Metrics

- Physical LOC, code lines, comment-only lines, and blank lines
- Function and class counts
- Cyclomatic and cognitive complexity (per function and maximum)
- Nesting depth
- Intra-file call graph metrics: call counts, fan-in/fan-out, recursion, call depth, and parameter counts
- Within-file structural duplication: copy-pasted code blocks (distinct from cross-file duplicate symbol names)
- File coupling (imports/exports) and cohesion (shared function identifiers)
- Architecture metrics: transitive local dependencies, structural coordination and breadth, state mutation, and cross-file duplicate symbols
- TypeScript type-shape metrics: annotations, aliases, interfaces, generics, unions, intersections, assertions, and conditional types
- Halstead metrics and the maintainability index

## Supported languages

Built-in parsers cover JavaScript, JSX, TypeScript, TSX, Python, and Go. Additional tree-sitter grammars can be registered with `TreeMeasurer.registerLanguage`.

## Programmatic API

```ts
import { measureCode } from 'measure-code';

const metrics = measureCode(
  `
function score(value) {
  if (value < 0 || value == null) {
    return 0;
  }
  return value > 10 ? 10 : value;
}
`,
  { language: 'javascript' }
);

console.log(metrics.cyclomaticComplexity);
```
