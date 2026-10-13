import type { ArtifactDescriptor, ArtifactResolver } from './artifact.contract';

export interface RuntimeArtifactEntry {
  descriptor: ArtifactDescriptor;
  /** Scanner-internal only. This value is never copied into Agent input. */
  root: string;
}

/**
 * Resolver used by the real Tier 2 -> Tier 3 runtime. Artifact roots stay in
 * this resolver and are only used by the file-range tool and validator.
 */
export class RuntimeArtifactResolver implements ArtifactResolver {
  private readonly entries: ReadonlyMap<string, RuntimeArtifactEntry>;

  constructor(entries: readonly RuntimeArtifactEntry[]) {
    const map = new Map<string, RuntimeArtifactEntry>();
    for (const entry of entries) {
      if (map.has(entry.descriptor.artifactId)) throw new Error(`Duplicate artifact ID: ${entry.descriptor.artifactId}`);
      if (entry.root.trim() === '') throw new Error(`Artifact root is empty: ${entry.descriptor.artifactId}`);
      map.set(entry.descriptor.artifactId, entry);
    }
    this.entries = map;
  }

  describe(artifactId: string): ArtifactDescriptor | undefined {
    return this.entries.get(artifactId)?.descriptor;
  }

  list(): readonly ArtifactDescriptor[] {
    return [...this.entries.values()].map(({ descriptor }) => descriptor);
  }

  async resolveRoot(artifactId: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const entry = this.entries.get(artifactId);
    if (!entry) throw new Error(`Unknown artifact: ${artifactId}`);
    return entry.root;
  }
}

export function originalArtifactDescriptor(archiveSha256: string, contentSha256 = archiveSha256): ArtifactDescriptor {
  return {
    artifactId: `artifact:${archiveSha256}`,
    representation: 'ORIGINAL',
    analysisPass: 'TIER1',
    contentSha256,
    lineageStatus: 'DIRECT',
    producer: 'scanner-safe-extractor',
  };
}
