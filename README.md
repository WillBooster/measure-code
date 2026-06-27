# tree-measurer

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
import { measureCode } from 'tree-measurer';

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
