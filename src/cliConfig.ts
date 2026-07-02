import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Risk thresholds; a finding is reported when the measured value is greater than or equal to the threshold. */
export interface Thresholds {
  fileLoc: number;
  functionLoc: number;
  componentLoc: number;
  cognitive: number;
  cyclomatic: number;
  call: number;
  import: number;
  fanOut: number;
  parameter: number;
  duplicateBlock: number;
  transitiveDependency: number;
  structuralBreadth: number;
  structuralCoordination: number;
  stateMutation: number;
  duplicateSymbolGroup: number;
}

// Defaults tuned against blind human labels across five representative WillBooster/WillBoosterLab
// repositories to maximize F1 (precision without sacrificing recall); see PR for the evaluation.
export const defaultThresholds: Thresholds = {
  fileLoc: 500,
  functionLoc: 120,
  componentLoc: 350,
  cognitive: 25,
  cyclomatic: 20,
  call: 50,
  import: 25,
  fanOut: 10,
  parameter: 8,
  duplicateBlock: 2,
  transitiveDependency: 25,
  structuralBreadth: 8,
  structuralCoordination: 300,
  stateMutation: 50,
  duplicateSymbolGroup: 5,
};

export const defaultMaxFindings = 20;
export const configFileName = 'code-gauge.config.json';

/**
 * Profile keys for per-language and React-specific threshold overrides. A file resolves its
 * thresholds as base → its language profile → the `react` profile (when it contains a component).
 */
export const profileKeys = ['javascript', 'jsx', 'typescript', 'tsx', 'python', 'go', 'react'] as const;
export type ProfileKey = (typeof profileKeys)[number];

/**
 * Built-in per-profile overrides, calibrated because some metric distributions differ sharply by
 * language/type: Python treats every binding as an assignment (so `stateMutation` runs ~10x higher)
 * and coordinates more per file, while React files import roughly twice as many sources as pure TS.
 */
export const defaultProfileThresholds: Partial<Record<ProfileKey, Partial<Thresholds>>> = {
  python: { stateMutation: 90, structuralCoordination: 350 },
  react: { import: 30 },
};

/** Shape of the JSON configuration file. All fields are optional and fall back to the built-in defaults. */
export interface CodeGaugeConfig {
  thresholds?: Partial<Thresholds>;
  /** Per-profile overrides keyed by language name or `react`; merged over `thresholds` for matching files. */
  languageThresholds?: Partial<Record<ProfileKey, Partial<Thresholds>>>;
  maxFindings?: number;
  includeTests?: boolean;
  failOnRisk?: boolean;
  failOnError?: boolean;
  tsconfig?: string;
}

/** Options after merging command-line flags, the configuration file, and the built-in defaults. */
export interface ResolvedOptions {
  thresholds: Thresholds;
  profileThresholds: Partial<Record<ProfileKey, Partial<Thresholds>>>;
  maxFindings: number;
  includeTests: boolean;
  failOnRisk: boolean;
  failOnError: boolean;
  json: boolean;
  tsconfig?: string;
}

/**
 * Resolves the thresholds for a single file: the base thresholds overlaid with its language profile
 * and then, when the file contains a React component, the `react` profile.
 */
export function resolveThresholds(options: ResolvedOptions, language: string, isReact: boolean): Thresholds {
  let thresholds = options.thresholds;
  const languageOverride = options.profileThresholds[language as ProfileKey];
  if (languageOverride) {
    thresholds = { ...thresholds, ...languageOverride };
  }
  if (isReact && options.profileThresholds.react) {
    thresholds = { ...thresholds, ...options.profileThresholds.react };
  }
  return thresholds;
}

/** Raw command-line options; every threshold is undefined unless the user passed the flag. */
export interface CliOptions {
  config?: string;
  fileLocThreshold?: number;
  functionLocThreshold?: number;
  componentLocThreshold?: number;
  cognitiveThreshold?: number;
  cyclomaticThreshold?: number;
  callThreshold?: number;
  importThreshold?: number;
  fanOutThreshold?: number;
  parameterThreshold?: number;
  duplicateBlockThreshold?: number;
  transitiveDependencyThreshold?: number;
  structuralBreadthThreshold?: number;
  structuralCoordinationThreshold?: number;
  stateMutationThreshold?: number;
  duplicateSymbolGroupThreshold?: number;
  maxFindings?: number;
  includeTests?: boolean;
  failOnRisk?: boolean;
  failOnError?: boolean;
  json?: boolean;
  tsconfig?: string;
}

/** Maps each threshold to the matching command-line flag; the config key equals the flag without the `-threshold` suffix. */
const thresholdCliKeys: Record<keyof Thresholds, keyof CliOptions> = {
  fileLoc: 'fileLocThreshold',
  functionLoc: 'functionLocThreshold',
  componentLoc: 'componentLocThreshold',
  cognitive: 'cognitiveThreshold',
  cyclomatic: 'cyclomaticThreshold',
  call: 'callThreshold',
  import: 'importThreshold',
  fanOut: 'fanOutThreshold',
  parameter: 'parameterThreshold',
  duplicateBlock: 'duplicateBlockThreshold',
  transitiveDependency: 'transitiveDependencyThreshold',
  structuralBreadth: 'structuralBreadthThreshold',
  structuralCoordination: 'structuralCoordinationThreshold',
  stateMutation: 'stateMutationThreshold',
  duplicateSymbolGroup: 'duplicateSymbolGroupThreshold',
};

/** Resolves options with precedence command-line flags > configuration file > built-in defaults. */
export function resolveOptions(cli: CliOptions, config: CodeGaugeConfig): ResolvedOptions {
  const thresholds = { ...defaultThresholds };
  for (const key of Object.keys(thresholds) as (keyof Thresholds)[]) {
    thresholds[key] = (cli[thresholdCliKeys[key]] as number | undefined) ?? config.thresholds?.[key] ?? thresholds[key];
  }

  return {
    thresholds,
    profileThresholds: mergeProfileThresholds(defaultProfileThresholds, config.languageThresholds),
    maxFindings: cli.maxFindings ?? config.maxFindings ?? defaultMaxFindings,
    includeTests: cli.includeTests ?? config.includeTests ?? false,
    failOnRisk: cli.failOnRisk ?? config.failOnRisk ?? false,
    failOnError: cli.failOnError ?? config.failOnError ?? false,
    json: cli.json ?? false,
    tsconfig: cli.tsconfig ?? config.tsconfig,
  };
}

/** Merges user-supplied per-profile overrides on top of the built-in ones, per profile. */
function mergeProfileThresholds(
  defaults: Partial<Record<ProfileKey, Partial<Thresholds>>>,
  overrides: Partial<Record<ProfileKey, Partial<Thresholds>>> | undefined
): Partial<Record<ProfileKey, Partial<Thresholds>>> {
  const merged: Partial<Record<ProfileKey, Partial<Thresholds>>> = {};
  for (const key of profileKeys) {
    const combined = { ...defaults[key], ...overrides?.[key] };
    if (Object.keys(combined).length > 0) {
      merged[key] = combined;
    }
  }
  return merged;
}

/**
 * Loads the configuration file. An explicit path must exist; otherwise the nearest
 * `code-gauge.config.json` is searched by walking up from the target directory.
 */
export async function loadConfig(explicitPath: string | undefined, targetDirectory: string): Promise<CodeGaugeConfig> {
  const configFile = explicitPath ?? (await findNearestConfig(targetDirectory));
  if (!configFile) {
    return {};
  }

  let content;
  try {
    content = await readFile(configFile, 'utf8');
  } catch (error) {
    if (explicitPath) {
      throw new Error(`Cannot read config file "${configFile}": ${formatError(error)}`);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in config file "${configFile}": ${formatError(error)}`);
  }

  return validateConfig(parsed, configFile);
}

async function findNearestConfig(targetDirectory: string): Promise<string | undefined> {
  let currentDirectory = targetDirectory;
  while (true) {
    const configFile = path.join(currentDirectory, configFileName);
    if (await fileExists(configFile)) {
      return configFile;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const fileStat = await stat(file);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

function validateConfig(value: unknown, configFile: string): CodeGaugeConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}" must contain a JSON object.`);
  }

  const raw = value as Record<string, unknown>;
  const config: CodeGaugeConfig = {};

  if (raw.thresholds !== undefined) {
    config.thresholds = validateThresholdObject(raw.thresholds, 'thresholds', configFile);
  }

  if (raw.languageThresholds !== undefined) {
    if (
      typeof raw.languageThresholds !== 'object' ||
      raw.languageThresholds === null ||
      Array.isArray(raw.languageThresholds)
    ) {
      throw new Error(`Config file "${configFile}": "languageThresholds" must be an object.`);
    }
    const languageThresholds: Partial<Record<ProfileKey, Partial<Thresholds>>> = {};
    for (const [profile, thresholds] of Object.entries(raw.languageThresholds as Record<string, unknown>)) {
      if (!(profileKeys as readonly string[]).includes(profile)) {
        throw new Error(
          `Config file "${configFile}": unknown language profile "${profile}" (expected one of ${profileKeys.join(', ')}).`
        );
      }
      languageThresholds[profile as ProfileKey] = validateThresholdObject(
        thresholds,
        `languageThresholds.${profile}`,
        configFile
      );
    }
    config.languageThresholds = languageThresholds;
  }

  if (raw.maxFindings !== undefined) {
    config.maxFindings = requirePositiveInteger(raw.maxFindings, 'maxFindings', configFile);
  }
  for (const key of ['includeTests', 'failOnRisk', 'failOnError'] as const) {
    if (raw[key] !== undefined) {
      config[key] = requireBoolean(raw[key], key, configFile);
    }
  }
  if (raw.tsconfig !== undefined) {
    if (typeof raw.tsconfig !== 'string') {
      throw new TypeError(`Config file "${configFile}": "tsconfig" must be a string.`);
    }
    config.tsconfig = raw.tsconfig;
  }

  return config;
}

function validateThresholdObject(value: unknown, label: string, configFile: string): Partial<Thresholds> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}": "${label}" must be an object.`);
  }
  const thresholds: Partial<Thresholds> = {};
  for (const [key, threshold] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in defaultThresholds)) {
      throw new Error(`Config file "${configFile}": unknown threshold "${key}" in "${label}".`);
    }
    thresholds[key as keyof Thresholds] = requirePositiveInteger(threshold, `${label}.${key}`, configFile);
  }
  return thresholds;
}

function requirePositiveInteger(value: unknown, key: string, configFile: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Config file "${configFile}": "${key}" must be a positive integer.`);
  }
  return value;
}

function requireBoolean(value: unknown, key: string, configFile: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Config file "${configFile}": "${key}" must be a boolean.`);
  }
  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
