"use client";

/**
 * Brand Kit card (Epic A) — define ONE brand identity (logo, name, accent, footer)
 * and apply it across the login screen, admin chrome, outgoing email, and the
 * maintenance page together. A LIVE PREVIEW (a miniature login + email-header mock)
 * re-renders from the current form values as you type — advisory only; the plugin's
 * save-time gauntlet stays authoritative. Behind the `white_label` (Ultimate)
 * TierGate: a locked site sees the upsell, never fake data.
 */

import { useEffect, useState } from "react";
import { AtSign, ImageIcon, Palette, Sparkles } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Spinner } from "../../demo/manage/panel-shell";
import { ActionError, BTN_PRIMARY, Field, INPUT } from "../../demo/manage/manage-ui";
import { TierGate } from "../kit/tier-gate";
import { BRANDING_COLOR_RE, type BrandingSettings } from "../../../lib/manage/content-branding";
import { useBranding, useBrandingWriter } from "./use-content-branding";

/** The editable slice of the brand kit — the fields this card surfaces. */
interface BrandKitForm {
  brand_name: string;
  accent_color: string;
  login_logo_url: string;
  email_logo_url: string;
  admin_footer_text: string;
  hide_wp_logo: boolean;
  apply_to_email: boolean;
  apply_to_maintenance: boolean;
}

const EMPTY_FORM: BrandKitForm = {
  brand_name: "",
  accent_color: "",
  login_logo_url: "",
  email_logo_url: "",
  admin_footer_text: "",
  hide_wp_logo: false,
  apply_to_email: false,
  apply_to_maintenance: false,
};

function toForm(settings: BrandingSettings): BrandKitForm {
  return {
    brand_name: settings.brand_name,
    accent_color: settings.accent_color,
    login_logo_url: settings.login_logo_url,
    email_logo_url: settings.email_logo_url,
    admin_footer_text: settings.admin_footer_text,
    hide_wp_logo: settings.hide_wp_logo,
    apply_to_email: settings.apply_to_email,
    apply_to_maintenance: settings.apply_to_maintenance,
  };
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
        <span className="block text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>
      </span>
    </label>
  );
}

/** Advisory client preview — mirrors the surfaces the brand kit feeds. */
function BrandPreview({ form }: { form: BrandKitForm }) {
  const accent = BRANDING_COLOR_RE.test(form.accent_color) ? form.accent_color : "#2563eb";
  const name = form.brand_name.trim() || "Your brand";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {/* Login mock */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-zinc-400">Login screen</p>
        <div className="flex flex-col items-center gap-2 rounded-lg border border-zinc-100 p-4 dark:border-zinc-900">
          {form.login_logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={form.login_logo_url} alt="" className="h-8 max-w-[140px] object-contain" />
          ) : (
            <span className="text-sm font-semibold" style={{ color: accent }}>
              {name}
            </span>
          )}
          <div className="mt-1 h-6 w-full rounded bg-zinc-100 dark:bg-zinc-900" />
          <div className="h-6 w-full rounded bg-zinc-100 dark:bg-zinc-900" />
          <div className="mt-1 h-7 w-full rounded text-center text-xs font-medium leading-7 text-white" style={{ backgroundColor: accent }}>
            Log In
          </div>
        </div>
      </div>
      {/* Email header mock */}
      <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-zinc-400">
          Email header {form.apply_to_email ? "" : "(off)"}
        </p>
        <div className={form.apply_to_email ? "" : "opacity-40"}>
          <div className="flex items-center gap-2 rounded-lg p-3" style={{ backgroundColor: `${accent}14` }}>
            {form.email_logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={form.email_logo_url} alt="" className="h-6 max-w-[90px] object-contain" />
            ) : null}
            <span className="text-sm font-semibold" style={{ color: accent }}>
              {name}
            </span>
          </div>
          <div className="mt-2 space-y-1.5">
            <div className="h-2.5 w-3/4 rounded bg-zinc-100 dark:bg-zinc-900" />
            <div className="h-2.5 w-1/2 rounded bg-zinc-100 dark:bg-zinc-900" />
          </div>
          <p className="mt-2 text-center text-[11px] text-zinc-400">{form.admin_footer_text.trim() || `© ${name}`}</p>
        </div>
      </div>
    </div>
  );
}

function BrandKitEditor({ site }: { site: string }) {
  const state = useBranding(site);
  const writer = useBrandingWriter(site);
  const [form, setForm] = useState<BrandKitForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  // Seed the form once the current settings load (advisory preview + edit base).
  useEffect(() => {
    if (state.data) setForm(toForm(state.data.settings));
  }, [state.data]);

  const accentInvalid = form.accent_color.length > 0 && !BRANDING_COLOR_RE.test(form.accent_color);
  const canSave = !writer.pending && !accentInvalid;

  const set = <K extends keyof BrandKitForm>(key: K, value: BrandKitForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function save() {
    setError(null);
    try {
      const result = await writer.save(form);
      if (result.ok) {
        toast.success("Brand kit saved — it applies to every surface");
      } else {
        setError(result.reason === "entitlement-locked" ? "White-Label is not active on this site's plan." : result.reason);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  if (state.loading && !state.data) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        <Spinner /> Loading branding…
      </div>
    );
  }
  if (state.error && !state.data) return <ActionError message={state.error} />;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4">
        <Field label="Brand name" htmlFor="bk-name" hint="Shown on the login screen, email header, and maintenance page.">
          <input id="bk-name" className={INPUT} value={form.brand_name} onChange={(e) => set("brand_name", e.target.value)} placeholder="Acme Co." />
        </Field>
        <Field
          label="Accent colour"
          htmlFor="bk-accent"
          hint="A hex colour like #2563eb — used for buttons and highlights."
          error={accentInvalid ? "Enter a 6-digit hex colour, e.g. #2563eb." : undefined}
        >
          <div className="flex items-center gap-2">
            <input id="bk-accent" className={INPUT} value={form.accent_color} onChange={(e) => set("accent_color", e.target.value)} placeholder="#2563eb" />
            <span
              className="h-8 w-8 shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700"
              style={{ backgroundColor: BRANDING_COLOR_RE.test(form.accent_color) ? form.accent_color : "transparent" }}
              aria-hidden
            />
          </div>
        </Field>
        <Field label="Login logo URL" htmlFor="bk-logo" hint="The logo shown on the WordPress login screen.">
          <input id="bk-logo" className={INPUT} value={form.login_logo_url} onChange={(e) => set("login_logo_url", e.target.value)} placeholder="https://…/logo.png" />
        </Field>
        <Field label="Email logo URL" htmlFor="bk-email-logo" hint="The logo prepended to outgoing HTML email.">
          <input id="bk-email-logo" className={INPUT} value={form.email_logo_url} onChange={(e) => set("email_logo_url", e.target.value)} placeholder="https://…/email-logo.png" />
        </Field>
        <Field label="Footer credit" htmlFor="bk-footer" hint="Replaces the “Thank you for creating with WordPress” admin footer.">
          <input id="bk-footer" className={INPUT} value={form.admin_footer_text} onChange={(e) => set("admin_footer_text", e.target.value)} placeholder="© Acme Co." />
        </Field>

        <div className="grid gap-2">
          <ToggleRow label="Apply to email" hint="Prepend the brand header to outgoing HTML mail." checked={form.apply_to_email} onChange={(v) => set("apply_to_email", v)} />
          <ToggleRow label="Apply to maintenance page" hint="Brand the maintenance notice when it has no logo of its own." checked={form.apply_to_maintenance} onChange={(v) => set("apply_to_maintenance", v)} />
          <ToggleRow label="Hide the WordPress admin-bar logo" hint="Removes the W logo from the top admin bar." checked={form.hide_wp_logo} onChange={(v) => set("hide_wp_logo", v)} />
        </div>

        {error ? <ActionError message={error} onDismiss={() => setError(null)} /> : null}
        <button type="button" className={BTN_PRIMARY} disabled={!canSave} onClick={save}>
          {writer.pending ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />} Save brand kit
        </button>
      </div>

      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Live preview</p>
        <BrandPreview form={form} />
        <p className="text-[11px] text-zinc-400">
          Preview is advisory — the site re-validates every value on save. Empty fields keep the WordPress default.
        </p>
      </div>
    </div>
  );
}

/** The Brand Kit card, gated behind `white_label` (Ultimate). */
export function BrandKitCard({ site }: { site: string }) {
  return (
    <SectionCard
      className="lg:col-span-2"
      title="Brand kit"
      description="One brand identity — logo, name, accent, footer — across login, admin, email and maintenance."
      icon={Palette}
    >
      <TierGate site={site} flag="white_label">
        <BrandKitEditor site={site} />
      </TierGate>
    </SectionCard>
  );
}

/** A tiny standalone chip row summarising which surfaces are on (used by callers if needed). */
export function BrandSurfaceIcons() {
  return (
    <span className="inline-flex items-center gap-1 text-zinc-400">
      <ImageIcon className="h-3.5 w-3.5" aria-hidden />
      <AtSign className="h-3.5 w-3.5" aria-hidden />
    </span>
  );
}
