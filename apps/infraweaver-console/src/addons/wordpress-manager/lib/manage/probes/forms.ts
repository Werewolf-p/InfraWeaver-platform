/**
 * Forms & Leads panel probe — detects which forms plugin is active on the site and
 * reports the forms it can actually see over the read-only `wp-cli` path. Contact
 * Form 7 and WPForms register a custom post type for their forms, so those forms
 * are countable/listable; Gravity, Formidable, Ninja Forms et al. keep both forms
 * AND entries in bespoke database tables that the read-only management channel
 * doesn't expose. Submission ENTRIES themselves are never available here (CF7
 * e-mails them, the others store them in private tables), so the panel is honest
 * about that rather than fabricating lead counts. Gated on the `forms` capability.
 * Read-only: no allow-listed forms mutation, so the panel renders no action buttons.
 */
import { WP, safeWpArg, parseJsonArray, fieldStr, activePluginSlugs } from "../wp-probe";
import { FORM_PLUGIN_SLUGS } from "../capabilities";
import type { PanelProbe, PanelProbeContext } from "./contract";

export interface FormRecord {
  readonly title: string;
  readonly date: string | null;
}

export interface FormsData {
  /** Human name of the detected forms plugin (e.g. "Contact Form 7"). */
  readonly plugin: string;
  /** The wp.org slug we matched. */
  readonly slug: string;
  /** Number of forms, or null when the plugin keeps forms in tables wp-cli can't read. */
  readonly formCount: number | null;
  readonly forms: readonly FormRecord[];
  /** Whether submission entries are reachable over the read-only channel (always false today). */
  readonly entriesReachable: boolean;
  /** Honest explanation of what is (and isn't) visible for this plugin. */
  readonly note: string;
}

/** Detected-plugin descriptor: its label and the custom post type its forms live in (null ⇒ custom tables). */
interface FormPluginInfo {
  readonly label: string;
  readonly cpt: string | null;
}

const FORM_PLUGINS: Readonly<Record<string, FormPluginInfo>> = {
  "contact-form-7": { label: "Contact Form 7", cpt: "wpcf7_contact_form" },
  "wpforms-lite": { label: "WPForms", cpt: "wpforms" },
  wpforms: { label: "WPForms", cpt: "wpforms" },
  gravityforms: { label: "Gravity Forms", cpt: null },
  formidable: { label: "Formidable Forms", cpt: null },
  "ninja-forms": { label: "Ninja Forms", cpt: null },
  forminator: { label: "Forminator", cpt: null },
  fluentform: { label: "Fluent Forms", cpt: null },
};

type FormRow = {
  post_title?: string;
  post_date?: string;
};

/** Pick the first active plugin (in FORM_PLUGIN_SLUGS priority order) we recognise. */
export function detectFormPlugin(activePluginsJson: string): { slug: string; info: FormPluginInfo } | null {
  const active = activePluginSlugs(activePluginsJson);
  for (const slug of FORM_PLUGIN_SLUGS) {
    if (active.has(slug) && FORM_PLUGINS[slug]) {
      return { slug, info: FORM_PLUGINS[slug] };
    }
  }
  return null;
}

function noteFor(info: FormPluginInfo): string {
  if (info.cpt) {
    return `${info.label} stores each submission outside the read-only management channel (e-mailed or in its own tables), so entry counts aren't shown here — only the forms themselves.`;
  }
  return `${info.label} keeps its forms and entries in custom database tables that the read-only management channel doesn't expose, so counts aren't available over wp-cli.`;
}

export function parseForms(input: {
  detected: { slug: string; info: FormPluginInfo } | null;
  count: string;
  list: string;
}): FormsData {
  if (!input.detected) {
    return {
      plugin: "a forms plugin",
      slug: "",
      formCount: null,
      forms: [],
      entriesReachable: false,
      note: "A forms plugin is active but wasn't recognised, so its forms can't be enumerated over the read-only channel.",
    };
  }

  const { slug, info } = input.detected;
  if (!info.cpt) {
    return { plugin: info.label, slug, formCount: null, forms: [], entriesReachable: false, note: noteFor(info) };
  }

  const forms: FormRecord[] = parseJsonArray<FormRow>(input.list).map((row) => ({
    title: fieldStr(row, "post_title") ?? "(untitled form)",
    date: fieldStr(row, "post_date"),
  }));
  const parsedCount = Number(input.count.trim());
  const formCount = Number.isFinite(parsedCount) ? Math.trunc(parsedCount) : forms.length;

  return { plugin: info.label, slug, formCount, forms, entriesReachable: false, note: noteFor(info) };
}

async function fetchForms(ctx: PanelProbeContext): Promise<FormsData> {
  const activePlugins = await ctx
    .exec(`${WP} plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");

  const detected = detectFormPlugin(activePlugins);
  const cpt = detected?.info.cpt;
  if (!cpt) return parseForms({ detected, count: "", list: "" });

  // `cpt` is one of our compile-time constants, but validate it anyway before it
  // reaches the command line — the Manage layer never interpolates un-vetted values.
  const safeCpt = safeWpArg(cpt);
  const [count, list] = await Promise.all([
    ctx.exec(`${WP} post list --post_type=${safeCpt} --format=count`).then((r) => r.stdout).catch(() => ""),
    ctx
      .exec(`${WP} post list --post_type=${safeCpt} --fields=post_title,post_date --format=json`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
  ]);

  return parseForms({ detected, count, list });
}

export const formsProbe: PanelProbe<FormsData> = {
  id: "forms",
  requiresCapability: "forms",
  fetch: fetchForms,
};
