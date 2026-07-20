"use client";

/**
 * Settings surface — a synthetic Manage section (no gated panel backs it). Writes
 * the allow-listed site options (blogname, blogdescription, admin_email,
 * timezone_string, date_format, start_of_week) via `update-site-option`, and flips
 * `set-maintenance-mode`. Every option value rides STDIN server-side, so the form
 * only enforces the shared client validators; the server re-validates.
 *
 * WordPress core exposes no read for these over the Manage snapshot, so each field
 * is an explicit "set to" control (dirty-tracked; nothing is sent until you save a
 * field). Changing the admin email requires a typed confirmation and, per WP core,
 * only takes effect after the new address confirms by email.
 */

import { useState } from "react";
import { Building2, Globe, Mail, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ManageAction } from "../../../lib/manage/actions";
import { SectionCard } from "../widgets";
import { Spinner } from "./panel-shell";
import { BTN_PRIMARY, ConfirmDialog, Field, INPUT, useActionRunner } from "./manage-ui";
import { isValidEmail, isValidOptionValue } from "./form-validation";

const DATE_FORMATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "F j, Y", label: "July 20, 2026" },
  { value: "Y-m-d", label: "2026-07-20" },
  { value: "m/d/Y", label: "07/20/2026" },
  { value: "d/m/Y", label: "20/07/2026" },
  { value: "d.m.Y", label: "20.07.2026" },
];

const WEEK_START: ReadonlyArray<{ value: string; label: string }> = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

const KEEP = "__keep__";

/** A single "set this option to" row: input + Save, dirty-tracked and validated. */
function OptionTextRow({
  site,
  optionKey,
  label,
  placeholder,
  hint,
  onSaved,
}: {
  site: string;
  optionKey: Extract<ManageAction, { type: "update-site-option" }>["key"];
  label: string;
  placeholder: string;
  hint?: string;
  onSaved: () => void;
}) {
  const { run, pending } = useActionRunner(site);
  const [value, setValue] = useState("");
  const id = `opt-${optionKey}`;
  const invalid = value.length > 0 && !isValidOptionValue(value);
  const canSave = value.trim().length > 0 && !invalid && !pending;

  async function save() {
    const result = await run({ type: "update-site-option", key: optionKey, value });
    if (result.ok) {
      setValue("");
      onSaved();
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <Field label={label} htmlFor={id} hint={hint} error={invalid ? "Max 500 characters, no line breaks." : undefined}>
          <input
            id={id}
            type="text"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            className={INPUT}
          />
        </Field>
      </div>
      <button type="button" className={cn(BTN_PRIMARY, "sm:mb-[1px]")} disabled={!canSave} onClick={save}>
        {pending ? <Spinner /> : null} Save
      </button>
    </div>
  );
}

/** A "set this option to" select row (localization) with a keep-current default. */
function OptionSelectRow({
  site,
  optionKey,
  label,
  options,
  onSaved,
}: {
  site: string;
  optionKey: Extract<ManageAction, { type: "update-site-option" }>["key"];
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onSaved: () => void;
}) {
  const { run, pending } = useActionRunner(site);
  const [value, setValue] = useState(KEEP);
  const id = `opt-${optionKey}`;
  const canSave = value !== KEEP && !pending;

  async function save() {
    const result = await run({ type: "update-site-option", key: optionKey, value });
    if (result.ok) {
      setValue(KEEP);
      onSaved();
    }
  }

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1">
        <Field label={label} htmlFor={id}>
          <select id={id} value={value} onChange={(e) => setValue(e.target.value)} className={INPUT}>
            <option value={KEEP}>— Keep current —</option>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <button type="button" className={cn(BTN_PRIMARY, "sm:mb-[1px]")} disabled={!canSave} onClick={save}>
        {pending ? <Spinner /> : null} Save
      </button>
    </div>
  );
}

/** Admin email — typed confirmation, and a note that WP confirms by email. */
function AdminEmailRow({ site, onSaved }: { site: string; onSaved: () => void }) {
  const { run, pending, error } = useActionRunner(site);
  const [value, setValue] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const invalid = value.length > 0 && !isValidEmail(value);
  const canSubmit = value.trim().length > 0 && !invalid;

  async function apply() {
    const result = await run({ type: "update-site-option", key: "admin_email", value });
    if (result.ok) {
      setValue("");
      setConfirmOpen(false);
      onSaved();
    }
  }

  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <Field
            label="Administration email"
            htmlFor="opt-admin_email"
            hint="WordPress emails the new address a confirmation link before the change applies."
            error={invalid ? "Enter a valid email address." : undefined}
          >
            <input
              id="opt-admin_email"
              type="email"
              value={value}
              placeholder="owner@example.com"
              onChange={(e) => setValue(e.target.value)}
              className={INPUT}
            />
          </Field>
        </div>
        <button
          type="button"
          className={cn(BTN_PRIMARY, "sm:mb-[1px]")}
          disabled={!canSubmit || pending}
          onClick={() => setConfirmOpen(true)}
        >
          Change
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={apply}
        title="Change administration email"
        description="This changes where WordPress sends admin notifications."
        tone="neutral"
        confirmLabel="Send confirmation"
        confirmPhrase={value.trim()}
        confirmPhraseLabel="Re-type the new email to confirm"
        pending={pending}
        error={error}
        body={
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            WordPress will email <span className="font-medium text-zinc-900 dark:text-zinc-100">{value}</span> a
            confirmation link. The address only becomes the admin email once that link is clicked.
          </p>
        }
      />
    </>
  );
}

function MaintenanceToggle({
  site,
  maintenanceOn,
  onChange,
}: {
  site: string;
  maintenanceOn: boolean | null;
  onChange: (on: boolean) => void;
}) {
  const { run, pending } = useActionRunner(site);
  const on = maintenanceOn === true;

  async function toggle() {
    const next = !on;
    const result = await run({ type: "set-maintenance-mode", enabled: next });
    if (result.ok) onChange(next);
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Maintenance mode</p>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {on
            ? "Visitors see a maintenance notice. Admins can still sign in."
            : "The site is live to visitors."}
          {maintenanceOn === null ? " Current state is applied on toggle." : ""}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Maintenance mode"
        disabled={pending}
        onClick={toggle}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 disabled:opacity-50",
          on ? "bg-amber-500" : "bg-zinc-300 dark:bg-zinc-700",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform",
            on ? "translate-x-6" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}

export function SettingsPanel({
  site,
  maintenanceOn,
  onMaintenanceChange,
  onSaved,
}: {
  site: string;
  maintenanceOn: boolean | null;
  onMaintenanceChange: (on: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="Site identity"
        description="The public name and tagline of your site."
        icon={Building2}
        className="lg:col-span-2"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <OptionTextRow
            site={site}
            optionKey="blogname"
            label="Site title"
            placeholder="My WordPress site"
            onSaved={onSaved}
          />
          <OptionTextRow
            site={site}
            optionKey="blogdescription"
            label="Tagline"
            placeholder="Just another site"
            onSaved={onSaved}
          />
        </div>
      </SectionCard>

      <SectionCard title="Localization" description="How dates and weeks are presented." icon={Globe}>
        <div className="space-y-4">
          <OptionTextRow
            site={site}
            optionKey="timezone_string"
            label="Timezone"
            placeholder="e.g. Europe/Amsterdam"
            hint="A named timezone (region/city)."
            onSaved={onSaved}
          />
          <OptionSelectRow
            site={site}
            optionKey="date_format"
            label="Date format"
            options={DATE_FORMATS}
            onSaved={onSaved}
          />
          <OptionSelectRow
            site={site}
            optionKey="start_of_week"
            label="Week starts on"
            options={WEEK_START}
            onSaved={onSaved}
          />
        </div>
      </SectionCard>

      <SectionCard title="Administration" description="Where WordPress sends admin notices." icon={Mail}>
        <AdminEmailRow site={site} onSaved={onSaved} />
      </SectionCard>

      <SectionCard
        title="Maintenance"
        description="Take the site offline for visitors while you work."
        icon={Wrench}
        className="lg:col-span-2"
      >
        <MaintenanceToggle site={site} maintenanceOn={maintenanceOn} onChange={onMaintenanceChange} />
      </SectionCard>
    </div>
  );
}
