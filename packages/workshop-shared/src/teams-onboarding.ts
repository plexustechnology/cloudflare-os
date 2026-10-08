/** Deployment-owned destination for the shared Teams onboarding guide; conveys no access. */
export interface TeamsOnboardingTarget {
  /** Exact Workshop workspace identity. */
  readonly workspaceId: string;
  /** Accepted gadget to display within that workspace. */
  readonly gadgetId: number;
}

/** Rejects missing, malformed, or expanded destinations without affecting ordinary navigation. */
export function parseTeamsOnboardingTarget(value: unknown): TeamsOnboardingTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (Object.keys(target).length !== 2 ||
      Object.keys(target).some(key => key !== "workspaceId" && key !== "gadgetId") ||
      typeof target.workspaceId !== "string" || !/^[0-9a-f]{64}$/.test(target.workspaceId) ||
      typeof target.gadgetId !== "number" || !Number.isSafeInteger(target.gadgetId) || target.gadgetId <= 0) return null;
  return { workspaceId: target.workspaceId, gadgetId: target.gadgetId };
}

/** Parses a bounded deployment variable; invalid input disables onboarding only. */
export function parseTeamsOnboardingVariable(value: string | undefined): TeamsOnboardingTarget | null {
  if (!value || value.length > 256) return null;
  try { return parseTeamsOnboardingTarget(JSON.parse(value)); } catch { return null; }
}
