// IWSL v1 — InfraWeaver Site Link (docs/infraweaver-wp-remote-management-design.md).
// Build phase 1 (protocol core) + phase 2 (enrollment, IW side).

export * from "./types";
export { canonicalize } from "./jcs";
export {
  constantTimeEqual,
  domainMessage,
  dualSign,
  dualVerify,
  edSign,
  edVerify,
  enrollBinding,
  fromB64u,
  generateIwKeyPair,
  generateWpKeyPair,
  iwPublicKeys,
  randomBytes,
  toB64u,
} from "./crypto";
export {
  commandMessage,
  createSignedCommand,
  createSignedResponse,
  responseMessage,
  verifySignedResponse,
  type CreateCommandInput,
  type CreateResponseInput,
  type VerifyResponseExpectation,
} from "./envelope";
export {
  createEnrollmentBundle,
  parseEnrollProof,
  serializeBundleFile,
  verifyEnrollProof,
  type CreateBundleInput,
  type CreatedEnrollment,
  type EnrollProofResult,
  type PendingEnrollment,
} from "./enroll";
export {
  runScheduledRotation,
  type PendingRotation,
  type RotationOptions,
  type RotationOutcome,
  type RotationReply,
  type RotationRun,
  type RotationTransport,
  type SiteLinkState,
} from "./rotation";
