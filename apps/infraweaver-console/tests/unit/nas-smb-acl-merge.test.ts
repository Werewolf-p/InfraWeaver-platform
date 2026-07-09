// Regression tests for NAS folder ACL merging.
//
// TrueNAS accepts an ACE addressed by account name (`who`) but always returns it
// resolved to a numeric uid, with `who: null`:
//
//   write: {tag: "USER", who: "iw-truenas-ro", perms: {BASIC: "READ"}}
//   read:  {tag: "USER", id: 3005, who: null,  perms: {BASIC: "READ"}}
//
// A merge keyed on `who` therefore never matches what `getacl` returned, so every
// folder-create appended one more duplicate ACE for the same account. Left
// unchecked, an ACL grows without bound and its evaluation order stops being
// something an operator can reason about.
//
// `mergeUserAce` must key on the uid, and must collapse duplicates left behind
// by the buggy version rather than adding to them.

import { mergeUserAce } from "@/lib/nas/smb-accounts";

const RO_UID = 3005;
const RO_NAME = "iw-truenas-ro";

const OWNER = { tag: "owner@", id: -1, who: null, type: "ALLOW", perms: { BASIC: "FULL_CONTROL" } };
const OPERATOR = { tag: "USER", id: 3003, who: null, type: "ALLOW", perms: { BASIC: "FULL_CONTROL" } };
const READ_ACE = { tag: "USER", id: RO_UID, type: "ALLOW", perms: { BASIC: "READ" }, flags: { BASIC: "INHERIT" } };

describe("mergeUserAce", () => {
  it("adds the ACE when the account has none", () => {
    const result = mergeUserAce([OWNER, OPERATOR], READ_ACE, RO_UID, RO_NAME);
    expect(result).toEqual([OWNER, OPERATOR, READ_ACE]);
  });

  it("replaces an existing ACE addressed by uid, rather than duplicating it", () => {
    const stale = { tag: "USER", id: RO_UID, who: null, type: "ALLOW", perms: { BASIC: "MODIFY" } };
    const result = mergeUserAce([OWNER, stale], READ_ACE, RO_UID, RO_NAME);
    expect(result).toEqual([OWNER, READ_ACE]);
    expect(result.filter((ace) => ace.id === RO_UID)).toHaveLength(1);
  });

  it("also matches an ACE addressed by account name, as we write it", () => {
    const byName = { tag: "USER", who: RO_NAME, type: "ALLOW", perms: { BASIC: "READ" } };
    const result = mergeUserAce([OWNER, byName], READ_ACE, RO_UID, RO_NAME);
    expect(result).toEqual([OWNER, READ_ACE]);
  });

  it("collapses duplicates left by the buggy who-keyed merge", () => {
    const duplicated = [
      OWNER,
      { tag: "USER", id: RO_UID, who: null, type: "ALLOW", perms: { BASIC: "READ" } },
      { tag: "USER", id: RO_UID, who: null, type: "ALLOW", perms: { BASIC: "READ" } },
      { tag: "USER", id: RO_UID, who: null, type: "ALLOW", perms: { BASIC: "READ" } },
      OPERATOR,
    ];
    const result = mergeUserAce(duplicated, READ_ACE, RO_UID, RO_NAME);
    expect(result.filter((ace) => ace.id === RO_UID)).toHaveLength(1);
    // Applying it twice is a fixed point: the grant is idempotent.
    expect(mergeUserAce(result, READ_ACE, RO_UID, RO_NAME)).toEqual(result);
  });

  it("never strips another principal's access", () => {
    const result = mergeUserAce([OWNER, OPERATOR], READ_ACE, RO_UID, RO_NAME);
    expect(result).toContain(OWNER);
    expect(result).toContain(OPERATOR);
    // The operator's own FULL_CONTROL ACE survives a grant to a service account.
    expect(result.find((ace) => ace.id === 3003)?.perms).toEqual({ BASIC: "FULL_CONTROL" });
  });

  it("leaves a different service account's ACE alone", () => {
    const rwAce = { tag: "USER", id: 3007, who: null, type: "ALLOW", perms: { BASIC: "MODIFY" } };
    const result = mergeUserAce([rwAce], READ_ACE, RO_UID, RO_NAME);
    expect(result).toEqual([rwAce, READ_ACE]);
  });
});
