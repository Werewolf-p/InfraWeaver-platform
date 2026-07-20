/**
 * WordPress Manage console design-system kit — the shared, accessible building
 * blocks every panel draws from. Reuse these; do not re-implement tables, pills,
 * empty states, posture checklists, filter rails or danger zones per panel.
 *
 * Buttons / inputs / modals / confirm dialogs / fields live in `../manage-ui`.
 * Cards / stat tiles / gauges / tones live in `../../widgets`.
 */

export { DataTable } from "./data-table";
export type { Column, ColumnAlign, DataTableProps } from "./data-table";

export { Pill } from "./pill";
export type { PillTone, PillProps } from "./pill";

export { EmptyState } from "./empty-state";
export type { EmptyStateProps } from "./empty-state";

export { PostureCheck, PostureSummary } from "./posture";
export type { PostureState, PostureCheckProps, PostureSummaryProps } from "./posture";

export { FilterTabs } from "./filter-tabs";
export type { FilterTabsProps, FilterTabOption } from "./filter-tabs";

export { DangerZone } from "./danger-zone";
export type { DangerZoneProps } from "./danger-zone";
