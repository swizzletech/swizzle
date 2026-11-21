export interface StoredEnvironment {
  readonly name: string;
  readonly displayName: string | null;
  readonly description: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly lastSeenAt: string | null;
  readonly registered: boolean;
  readonly hasData: boolean;
  readonly liveServices: readonly string[];
}
