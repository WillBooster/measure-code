import Go from 'tree-sitter-go';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import TypeScript from 'tree-sitter-typescript';
import type { LanguageDefinition, LanguageName, ParserLanguage } from './types.js';

type GrammarModule = unknown;

const commonFunctionNodes = [
  'function',
  'function_declaration',
  'function_definition',
  'function_item',
  'function_declarator',
  'method_declaration',
  'method_definition',
  'method_spec',
  'arrow_function',
  'generator_function',
  'generator_function_declaration',
  'lambda',
  'lambda_expression',
] as const;

const commonClassNodes = [
  'class',
  'class_declaration',
  'class_definition',
  'interface_declaration',
  'trait_item',
  'impl_item',
  'struct_item',
  'enum_item',
] as const;

const commonDecisionNodes = [
  'if_statement',
  'elif_clause',
  'else_if_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'except_clause',
  'case_clause',
  'switch_case',
  'match_arm',
  'conditional_expression',
  'ternary_expression',
] as const;

function normalizeGrammar(module: GrammarModule): ParserLanguage {
  if (isGrammarWrapper(module, 'default')) {
    return module.default;
  }

  return module;
}

function getTypeScriptGrammar(name: 'typescript' | 'tsx'): ParserLanguage {
  const grammars = TypeScript as unknown as Record<string, GrammarModule>;
  return grammars[name];
}

function isGrammarWrapper(value: GrammarModule, key: 'default'): value is Record<typeof key, ParserLanguage> {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return false;
  }

  return Boolean((value as Record<string, ParserLanguage>)[key]);
}

export const defaultLanguages: readonly LanguageDefinition[] = [
  {
    name: 'javascript',
    aliases: ['js', 'mjs', 'cjs'],
    parserLanguage: normalizeGrammar(JavaScript as unknown as GrammarModule),
  },
  {
    name: 'jsx',
    parserLanguage: normalizeGrammar(JavaScript as unknown as GrammarModule),
  },
  {
    name: 'typescript',
    aliases: ['ts'],
    parserLanguage: getTypeScriptGrammar('typescript'),
  },
  {
    name: 'tsx',
    parserLanguage: getTypeScriptGrammar('tsx'),
  },
  {
    name: 'python',
    aliases: ['py'],
    parserLanguage: normalizeGrammar(Python as unknown as GrammarModule),
  },
  {
    name: 'go',
    parserLanguage: normalizeGrammar(Go as unknown as GrammarModule),
  },
].map((language) => ({
  functionNodeTypes: commonFunctionNodes,
  classNodeTypes: commonClassNodes,
  decisionNodeTypes: commonDecisionNodes,
  nestingNodeTypes: commonDecisionNodes,
  ...language,
}));

export function createLanguageRegistry(
  languages: readonly LanguageDefinition[] = defaultLanguages
): Map<LanguageName, LanguageDefinition> {
  const registry = new Map<LanguageName, LanguageDefinition>();

  for (const language of languages) {
    registry.set(language.name, language);
    for (const alias of language.aliases ?? []) {
      registry.set(alias, language);
    }
  }

  return registry;
}

export const supportedLanguages = defaultLanguages.map((language) => language.name);
