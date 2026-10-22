import { ApiError } from "../errors.mjs";

export function requireGuardianQuorumPolicy() {
  throw new ApiError(
    503,
    "Tide ORK guardian-quorum enforcement and end-to-end encryption are not configured. This operation is disabled rather than relying on SQLite approval counts.",
  );
}
