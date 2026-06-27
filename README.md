# measure-code

[![Test](https://github.com/WillBooster/measure-code/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/measure-code/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

A library for measuring code metrics with tree-sitter.

## Metrics

- Physical LOC, code lines, comment-only lines, and blank lines
- Function and class counts
- Cyclomatic complexity
- Cognitive complexity
- Maximum per-function complexity
- Nesting depth
- Intra-file call graph metrics, including call counts, fan-in/fan-out, recursion, and call depth
- File coupling metrics from imports and exports
- File cohesion metrics from shared function identifiers
- TypeScript type-shape metrics, including annotations, aliases, interfaces, generics, unions, intersections, assertions, and conditional types
- Halstead metrics
- Maintainability index

## Supported languages

Built-in parsers are registered for JavaScript, JSX, TypeScript, TSX, Python, and Go. Additional tree-sitter grammars can be registered with `TreeMeasurer.registerLanguage`.

## Usage

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

## CLI

```sh
measure-code ~/ghq/github.com/WillBoosterLab/exercode
```

The CLI scans JavaScript, JSX, TypeScript, TSX, Python, and Go files, skips generated/vendor/test directories by default, and reports functions whose complexity is above the risk thresholds. Use `--include-tests` to include test files, `--json` for machine-readable output, `--max-findings` to control report length, `--fail-on-risk` or `--fail-on-error` for CI, or tune the defaults with `--cyclomatic-threshold` and `--cognitive-threshold`.
