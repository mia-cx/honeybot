import { fileURLToPath } from 'node:url';

import {
  DockerBuildxAdapter,
  materializeReference,
  publicationComplete,
  type ImageObservation,
  type PublicationAdapter,
} from './containerPublication.js';
import {
  getRepositories,
  imageReferences,
  releaseLabels,
  type RegistryRepositories,
  type ReleaseIdentity,
} from './releaseMetadata.js';
import {
  createAnnotatedTag,
  fetchTag,
  packageVersionAt,
  pushTag,
  resolveTagCommit,
} from './releaseGit.js';

export interface LegacyAdoptionInput {
  version: string;
  ref: string;
  expectedLegacyDigest: string;
  expectedLegacyRevision: string;
  repositories: RegistryRepositories;
  repository: string;
  cwd?: string;
  remote?: string;
}

export interface LegacyAdoptionResult {
  version: string;
  ref: string;
  digest: string;
  tag: string;
}

export function adoptLegacyStableRelease(
  input: LegacyAdoptionInput,
  adapter: PublicationAdapter,
): LegacyAdoptionResult {
  const cwd = input.cwd ?? process.cwd();
  const remote = input.remote ?? 'origin';
  if (packageVersionAt(input.ref, cwd) !== input.version) {
    throw new Error(
      `package.json at ${input.ref} does not contain version ${input.version}`,
    );
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(input.expectedLegacyDigest)) {
    throw new Error('expectedLegacyDigest must be a sha256 digest');
  }
  if (!/^[0-9a-f]{40}$/.test(input.expectedLegacyRevision)) {
    throw new Error('expectedLegacyRevision must be a full commit SHA');
  }

  const identity: ReleaseIdentity = {
    channel: 'stable',
    version: input.version,
    ref: input.ref,
  };
  const references = imageReferences(identity, input.repositories);
  const expectedLabels = releaseLabels(identity, input.repository);
  const tag = `v${input.version}`;
  const remoteTagExists = fetchTag(tag, remote, cwd);
  const existingTag = resolveTagCommit(tag, cwd);
  if (existingTag !== null && existingTag !== input.ref) {
    throw new Error(
      `Existing tag ${tag} peels to ${existingTag}, expected ${input.ref}`,
    );
  }

  if (remoteTagExists && existingTag !== null) {
    const complete = publicationComplete(
      {
        identity,
        repositories: input.repositories,
        repository: input.repository,
      },
      adapter,
    );
    if (!complete) {
      throw new Error(
        `Tag ${tag} already exists but target registry state is incomplete`,
      );
    }
    return {
      version: input.version,
      ref: input.ref,
      digest: complete.digest,
      tag,
    };
  }

  const observations = new Map<string, ImageObservation | null>();
  for (const reference of references.immutable)
    observations.set(reference, adapter.inspect(reference));
  const targets = [...observations.values()].filter(
    (observation): observation is ImageObservation =>
      observation !== null && hasIdentity(observation, expectedLabels),
  );
  const targetDigests = new Set(
    targets.map((observation) => observation.digest),
  );
  if (targetDigests.size > 1) {
    throw new Error(
      'Target-identity references have conflicting immutable digests',
    );
  }
  let target = targets[0];

  for (const reference of references.exact) {
    const observation = observations.get(reference);
    if (!observation || hasIdentity(observation, expectedLabels)) continue;
    if (
      observation.digest !== input.expectedLegacyDigest ||
      observation.labels['org.opencontainers.image.version'] !==
        input.version ||
      observation.labels['org.opencontainers.image.revision'] !==
        input.expectedLegacyRevision
    ) {
      throw new Error(
        `Exact reference ${reference} is not the explicitly authorized legacy identity`,
      );
    }
  }
  for (const reference of references.sha) {
    const observation = observations.get(reference);
    if (observation && !hasIdentity(observation, expectedLabels)) {
      throw new Error(
        `Full-SHA reference ${reference} conflicts with the adoption target`,
      );
    }
  }

  if (!target) {
    const digest = adapter.build({
      identity,
      references: references.immutable,
      labels: expectedLabels,
    });
    target = {
      reference:
        references.immutable[0] ?? fail('No immutable references generated'),
      digest,
      labels: expectedLabels,
    };
  } else {
    for (const reference of references.immutable) {
      const observation = observations.get(reference);
      if (
        !observation ||
        !hasIdentity(observation, expectedLabels) ||
        observation.digest !== target.digest
      ) {
        materializeReference(
          adapter,
          target.reference,
          target.digest,
          reference,
        );
      }
    }
  }

  const publication = publicationComplete(
    {
      identity,
      repositories: input.repositories,
      repository: input.repository,
    },
    adapter,
  );
  if (!publication)
    throw new Error(
      'Legacy adoption did not establish complete immutable state',
    );

  if (existingTag === null) createAnnotatedTag(tag, input.ref, cwd);
  pushTag(tag, remote, cwd);
  if (resolveTagCommit(tag, cwd) !== input.ref)
    throw new Error(`Tag ${tag} failed final verification`);
  return {
    version: input.version,
    ref: input.ref,
    digest: publication.digest,
    tag,
  };
}

function hasIdentity(
  observation: ImageObservation,
  labels: Record<string, string>,
): boolean {
  return Object.entries(labels).every(
    ([key, value]) => observation.labels[key] === value,
  );
}

function parseArguments(
  args: string[],
): Omit<LegacyAdoptionInput, 'repositories' | 'repository'> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined)
      throw new Error('Arguments must be --key value pairs');
    values.set(key.slice(2), value);
  }
  const version = values.get('version');
  const ref = values.get('ref');
  const expectedLegacyDigest = values.get('expected-legacy-digest');
  const expectedLegacyRevision = values.get('expected-legacy-revision');
  if (!version || !ref || !expectedLegacyDigest || !expectedLegacyRevision) {
    throw new Error(
      'Usage: adoptLegacyStableRelease --version VERSION --ref FULL_SHA --expected-legacy-digest SHA256 --expected-legacy-revision FULL_SHA',
    );
  }
  return { version, ref, expectedLegacyDigest, expectedLegacyRevision };
}

function fail(message: string): never {
  throw new Error(message);
}

async function main(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  adoptLegacyStableRelease(
    {
      ...parseArguments(process.argv.slice(2)),
      repositories: getRepositories(),
      repository,
    },
    new DockerBuildxAdapter(),
  );
  console.log('Guarded legacy stable adoption completed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Guarded legacy stable adoption failed.');
    process.exitCode = 1;
  });
}
