/**
 * WordPress site-cockpit SHARED kit — the new reusable pieces the domain panels
 * and the media fusion build on, layered on top of the existing Manage kit
 * (`components/demo/manage/kit`). Import from here; do not re-implement selection,
 * bulk runs, or tier gating per panel.
 */

export { SelectableDataTable } from "./select-table";
export type { SelectableDataTableProps } from "./select-table";

export { BulkActionBar } from "./bulk-bar";
export type { BulkActionMeta, BulkActionBarProps } from "./bulk-bar";

export { RunLedger, StatusIcon } from "./run-ledger";
export type { RunLedgerProps } from "./run-ledger";

export { TierGate, FeatureChip } from "./tier-gate";
export type { TierGateProps, FeatureChipProps } from "./tier-gate";
