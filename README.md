# tree-measurer

[![Test](https://github.com/WillBooster/tree-measurer/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/tree-measurer/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

A library for measuring code metrics with tree-sitter.

## Metrics

- Physical LOC, code lines, comment-only lines, and blank lines
- Function and class counts
- Cyclomatic complexity
- Cognitive complexity
- Maximum per-function complexity
- Nesting depth
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
