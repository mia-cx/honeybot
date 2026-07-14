import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getRepositories,
  imageReferences,
  releaseLabels,
  type RegistryRepositories,
  type ReleaseIdentity,
} from './releaseMetadata.js';
import { runCommand, withDetachedWorktree } from './releaseGit.js';

export interface ImageObservation {
  reference: string;
  digest: string;
  labels: Record<string, string>;
}

export interface BuildRequest {
  identity: ReleaseIdentity;
  references: string[];
  labels: Record<string, string>;
}

export interface PublicationAdapter {
  inspect(reference: string): ImageObservation | null;
  build(request: BuildRequest): string;
  copy(
    sourceReference: string,
    digest: string,
    destinationReference: string,
  ): void;
}

export interface PublicationResult {
  state: 'built' | 'repaired' | 'complete';
  digest: string;
  canonicalReference: string;
  references: string[];
}

export interface ReconcilePublicationInput {
  identity: ReleaseIdentity;
  repositories: RegistryRepositories;
  repository: string;
}

export class DockerBuildxAdapter implements PublicationAdapter {
  inspect(reference: string): ImageObservation | null {
    let output: string;
    try {
      output = runCommand('docker', [
        'buildx',
        'imagetools',
        'inspect',
        reference,
        '--format',
        '{{json .}}',
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        /manifest unknown|not found/i.test(error.message)
      )
        return null;
      throw error;
    }

    const value: unknown = JSON.parse(output);
    if (
      !isRecord(value) ||
      !isRecord(value.manifest) ||
      typeof value.manifest.digest !== 'string'
    ) {
      throw new Error(`Unable to read digest for ${reference}`);
    }
    if (!isRecord(value.image))
      throw new Error(`Unable to read image configs for ${reference}`);

    const platformLabels = Object.values(value.image).map((image) =>
      extractLabels(image, reference),
    );
    if (platformLabels.length === 0)
      throw new Error(`No platform images found for ${reference}`);
    const labels = platformLabels[0];
    if (!labels) throw new Error(`No labels found for ${reference}`);
    for (const candidate of platformLabels.slice(1)) {
      if (
        JSON.stringify(sortedRecord(candidate)) !==
        JSON.stringify(sortedRecord(labels))
      ) {
        throw new Error(`Platform labels disagree for ${reference}`);
      }
    }

    return { reference, digest: value.manifest.digest, labels };
  }

  build(request: BuildRequest): string {
    return withDetachedWorktree(request.identity.ref, (worktree) => {
      if (request.identity.channel === 'beta') {
        const packagePath = join(worktree, 'package.json');
        const packageJson: unknown = JSON.parse(
          readFileSync(packagePath, 'utf8'),
        );
        if (!isRecord(packageJson))
          throw new Error('package.json must be an object');
        packageJson.version = request.identity.version;
        writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
      }

      const temporary = mkdtempSync(join(tmpdir(), 'honeybot-build-metadata-'));
      const metadataFile = join(temporary, 'metadata.json');
      try {
        const args = [
          'buildx',
          'build',
          worktree,
          '--file',
          join(worktree, 'docker', 'Dockerfile'),
          '--platform',
          'linux/amd64,linux/arm64',
          '--push',
          '--provenance=mode=max',
          '--metadata-file',
          metadataFile,
        ];
        for (const reference of request.references)
          args.push('--tag', reference);
        for (const [key, value] of Object.entries(request.labels)) {
          args.push('--label', `${key}=${value}`);
        }
        const hasGhaCacheCredentials =
          process.env.ACTIONS_RUNTIME_TOKEN !== undefined &&
          (process.env.ACTIONS_RESULTS_URL !== undefined ||
            process.env.ACTIONS_CACHE_URL !== undefined);
        if (hasGhaCacheCredentials) {
          args.push(
            '--cache-from',
            'type=gha',
            '--cache-to',
            'type=gha,mode=max',
          );
        }
        runCommand('docker', args);

        const metadata: unknown = JSON.parse(
          readFileSync(metadataFile, 'utf8'),
        );
        if (
          !isRecord(metadata) ||
          typeof metadata['containerimage.digest'] !== 'string'
        ) {
          const observation = this.inspect(request.references[0] ?? '');
          if (!observation)
            throw new Error('Build completed without an inspectable digest');
          return observation.digest;
        }
        return metadata['containerimage.digest'];
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
  }

  copy(
    sourceReference: string,
    digest: string,
    destinationReference: string,
  ): void {
    const sourceRepository = referenceRepository(sourceReference);
    runCommand('docker', [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      destinationReference,
      `${sourceRepository}@${digest}`,
    ]);
  }
}

export function reconcilePublication(
  input: ReconcilePublicationInput,
  adapter: PublicationAdapter,
): PublicationResult {
  const references = imageReferences(
    input.identity,
    input.repositories,
  ).immutable;
  const labels = releaseLabels(input.identity, input.repository);
  const observations = references.map((reference) =>
    adapter.inspect(reference),
  );
  const present = observations.filter(
    (item): item is ImageObservation => item !== null,
  );

  let state: PublicationResult['state'];
  let digest: string;
  let canonicalReference: string;

  if (present.length === 0) {
    digest = adapter.build({ identity: input.identity, references, labels });
    canonicalReference =
      references[0] ?? fail('No immutable references generated');
    state = 'built';
  } else {
    assertObservationsMatch(present, input.identity, labels);
    digest = present[0]?.digest ?? fail('Missing canonical digest');
    canonicalReference =
      present[0]?.reference ?? fail('Missing canonical reference');
    const missing = observations
      .map((observation, index) =>
        observation === null ? references[index] : null,
      )
      .filter(
        (reference): reference is string =>
          reference !== null && reference !== undefined,
      );
    for (const reference of missing) {
      adapter.copy(canonicalReference, digest, reference);
    }
    state = missing.length === 0 ? 'complete' : 'repaired';
  }

  const verified = references.map((reference) => adapter.inspect(reference));
  if (verified.some((observation) => observation === null)) {
    throw new Error(
      'Immutable publication remained incomplete after reconciliation',
    );
  }
  const complete = verified.filter(
    (item): item is ImageObservation => item !== null,
  );
  assertObservationsMatch(complete, input.identity, labels);
  if (complete.some((observation) => observation.digest !== digest)) {
    throw new Error(
      'Immutable references do not resolve to the canonical digest',
    );
  }

  return { state, digest, canonicalReference, references };
}

export function publicationComplete(
  input: ReconcilePublicationInput,
  adapter: PublicationAdapter,
): PublicationResult | null {
  const references = imageReferences(
    input.identity,
    input.repositories,
  ).immutable;
  const labels = releaseLabels(input.identity, input.repository);
  const observations = references.map((reference) =>
    adapter.inspect(reference),
  );
  if (observations.some((observation) => observation === null)) return null;
  const complete = observations.filter(
    (item): item is ImageObservation => item !== null,
  );
  assertObservationsMatch(complete, input.identity, labels);
  return {
    state: 'complete',
    digest: complete[0]?.digest ?? fail('Missing digest'),
    canonicalReference: complete[0]?.reference ?? fail('Missing reference'),
    references,
  };
}

export function promoteMovingAliases(
  input: ReconcilePublicationInput,
  publication: PublicationResult,
  adapter: PublicationAdapter,
): string[] {
  const moving = imageReferences(input.identity, input.repositories).moving;
  for (const reference of moving) {
    adapter.copy(publication.canonicalReference, publication.digest, reference);
  }
  return moving;
}

function assertObservationsMatch(
  observations: ImageObservation[],
  identity: ReleaseIdentity,
  expectedLabels: Record<string, string>,
): void {
  const digests = new Set(
    observations.map((observation) => observation.digest),
  );
  if (digests.size !== 1) {
    throw new Error(`Conflicting immutable digests for ${identity.version}`);
  }
  for (const observation of observations) {
    for (const [key, value] of Object.entries(expectedLabels)) {
      if (observation.labels[key] !== value) {
        throw new Error(
          `Conflicting ${key} label on ${observation.reference}: expected ${value}, got ${observation.labels[key] ?? 'missing'}`,
        );
      }
    }
  }
}

function extractLabels(
  value: unknown,
  reference: string,
): Record<string, string> {
  if (
    !isRecord(value) ||
    !isRecord(value.config) ||
    !isRecord(value.config.Labels)
  ) {
    throw new Error(`Image config labels missing for ${reference}`);
  }
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value.config.Labels)) {
    if (typeof label === 'string') labels[key] = label;
  }
  return labels;
}

function sortedRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function referenceRepository(reference: string): string {
  const slash = reference.lastIndexOf('/');
  const colon = reference.lastIndexOf(':');
  if (colon <= slash) throw new Error(`Reference has no tag: ${reference}`);
  return reference.slice(0, colon);
}

function writeGithubOutput(result: PublicationResult): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(
    output,
    `state=${result.state}\ndigest=${result.digest}\ncanonical-reference=${result.canonicalReference}\n`,
  );
}

function parseArguments(args: string[]): ReleaseIdentity {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error('Arguments must be --key value pairs');
    values.set(key.slice(2), value);
  }
  const channel = values.get('channel');
  const version = values.get('version');
  const ref = values.get('ref');
  if ((channel !== 'beta' && channel !== 'stable') || !version || !ref) {
    throw new Error(
      'Usage: containerPublication --channel beta|stable --version VERSION --ref FULL_SHA',
    );
  }
  return { channel, version, ref };
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function main(): Promise<void> {
  const identity = parseArguments(process.argv.slice(2));
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  const result = reconcilePublication(
    { identity, repositories: getRepositories(), repository },
    new DockerBuildxAdapter(),
  );
  writeGithubOutput(result);
  console.log('Immutable container publication reconciliation completed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Immutable container publication reconciliation failed.');
    process.exitCode = 1;
  });
}
