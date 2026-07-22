<?php
/**
 * The plugin's wp-admin surface: a top-level "InfraWeaver Plus" menu whose main
 * page is a STATUS-ONLY landing dashboard (identity, connector version, current
 * tier, gate posture, the read-only Plus snapshot, and a grid of category cards),
 * with every feature living on its own category sub-page (Performance, Media,
 * SEO & Content, Analytics, Privacy & Site, System). It is the MANUAL TEST
 * SURFACE for the client-side feature gates. It reads only local plugin state
 * (IWSL_Entitlements::evaluate) — never a network call — and hosts these gated
 * sections, including:
 *
 *   1. Plus — Site Content & Health Snapshot (gate flag `plus`), read-only.
 *   2. Lossless Image Optimization (gate flag `image_optimization`), which runs
 *      a bounded, purely-local batch of PNG→WebP-lossless conversions via
 *      IWSL_Media_Optimizer. Originals are never modified.
 *
 * The image-optimization action is gated at THREE layers, innermost
 * authoritative: this page (UX), the admin-post handler (before doing work), and
 * IWSL_Media_Optimizer::run() itself (survives any future caller). The action is
 * POST → admin-post.php → redirect back (PRG). The inputs are the nonce, an
 * allow-listed converter id validated against the registry, and — when the
 * operator uses the media-library picker — a comma-separated list of attachment
 * ids. Any picked ids are treated as UNTRUSTED: they are re-validated
 * server-side (real `attachment` post + accepted MIME) before ever reaching
 * IWSL_Media_Optimizer::convert_one(), which resolves the file path itself and
 * still runs its full guard_source() gauntlet — no attachment path ever comes
 * from the request, picker or not.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Admin {

	/** admin-post action name for the image-optimization run. */
	const OPTIMIZE_ACTION = 'iwsl_media_optimize';
	/** Nonce action guarding the run form. */
	const OPTIMIZE_NONCE = 'iwsl_media_optimize';

	/** admin-post action + nonce for the SMTP settings save. */
	const EMAIL_SETTINGS_ACTION = 'iwsl_email_settings';
	const EMAIL_SETTINGS_NONCE  = 'iwsl_email_settings';
	/** admin-post action + nonce for the email-log clear. */
	const EMAIL_LOG_CLEAR_ACTION = 'iwsl_email_log_clear';
	const EMAIL_LOG_CLEAR_NONCE  = 'iwsl_email_log_clear';

	const EMAIL_TEST_ACTION = 'iwsl_email_test';
	const EMAIL_TEST_NONCE  = 'iwsl_email_test';

	/** admin-post actions + nonces for the 301 Redirect Manager. */
	const REDIRECT_ADD_ACTION    = 'iwsl_redirects_add';
	const REDIRECT_ADD_NONCE     = 'iwsl_redirects_add';
	const REDIRECT_DELETE_ACTION = 'iwsl_redirects_delete';
	const REDIRECT_DELETE_NONCE  = 'iwsl_redirects_delete';
	const REDIRECT_LOG_ACTION    = 'iwsl_redirects_log';
	const REDIRECT_LOG_NONCE     = 'iwsl_redirects_log';
	const REDIRECT_AUTO_ACTION   = 'iwsl_redirects_auto';
	const REDIRECT_AUTO_NONCE    = 'iwsl_redirects_auto';

	/** admin-post action + nonce for the white-label settings save. */
	const WHITE_LABEL_ACTION = 'iwsl_white_label_save';
	const WHITE_LABEL_NONCE  = 'iwsl_white_label_save';

	/** admin-post action + nonce for the database cleanup/optimize run (preview + clean). */
	const DB_OPTIMIZE_ACTION = 'iwsl_db_optimize';
	const DB_OPTIMIZE_NONCE  = 'iwsl_db_optimize';

	/** admin-post actions + nonces for the Page Cache enable/disable toggle + purge. */
	const PAGE_CACHE_TOGGLE_ACTION = 'iwsl_page_cache_toggle';
	const PAGE_CACHE_TOGGLE_NONCE  = 'iwsl_page_cache_toggle';
	const PAGE_CACHE_PURGE_ACTION  = 'iwsl_page_cache_purge';
	const PAGE_CACHE_PURGE_NONCE   = 'iwsl_page_cache_purge';

	/** admin-post action + nonce for the Configuration editor save (manage_options + nonce gated). */
	const CONFIG_SAVE_ACTION = 'iwsl_config_save';
	const CONFIG_SAVE_NONCE  = 'iwsl_config_save';

	/** admin-post action + nonce for the tier-aware per-feature enable/disable toggle. */
	const FEATURE_TOGGLE_ACTION = 'iwsl_feature_toggle';
	const FEATURE_TOGGLE_NONCE  = 'iwsl_feature_toggle';
	/** Per-user transient prefix for the toggle result toast. */
	const FEATURE_TOGGLE_RESULT = 'iwsl_feature_toggle_result_';

	/** One-click "guided setup" for Cookie Consent (applies GDPR-safe defaults). */
	const CONSENT_WIZARD_ACTION = 'iwsl_consent_wizard';
	const CONSENT_WIZARD_NONCE  = 'iwsl_consent_wizard';
	const CONSENT_WIZARD_RESULT = 'iwsl_consent_wizard_result_';

	/** @var IWSL_Plugin */
	private $plugin;

	/** @var IWSL_Media_Optimizer|null lazily built from the plugin's entitlements. */
	private $optimizer;

	/** @var IWSL_Email_Delivery|null lazily built from the plugin's entitlements + store. */
	private $email_delivery;

	/** @var IWSL_Redirects|null lazily built from the plugin's entitlements + store. */
	private $redirects;

	/** @var IWSL_White_Label|null lazily built from the plugin's entitlements + store. */
	private $white_label;

	/** @var IWSL_DB_Optimizer|null lazily built from the plugin's entitlements + global $wpdb. */
	private $db_optimizer;

	/** @var IWSL_Page_Cache|null lazily built from the plugin's entitlements. */
	private $page_cache;

	/** @var IWSL_Config_Editor|null lazily built; no entitlement — manage_options + nonce gated. */
	private $config_editor;

	/** @var IWSL_Feature_Switches|null the tier-aware operator on/off layer; lazily built from plugin state. */
	private $switches;

	/** @var string[] The hook suffixes returned by add_menu_page()/add_submenu_page(), used to scope wp_enqueue_media() to this plugin's own pages only. */
	private $page_hooks = array();

	public function __construct( IWSL_Plugin $plugin, ?IWSL_Media_Optimizer $optimizer = null, ?IWSL_Email_Delivery $email_delivery = null, ?IWSL_Redirects $redirects = null, ?IWSL_White_Label $white_label = null, ?IWSL_DB_Optimizer $db_optimizer = null, ?IWSL_Page_Cache $page_cache = null, ?IWSL_Config_Editor $config_editor = null, ?IWSL_Feature_Switches $switches = null ) {
		$this->plugin         = $plugin;
		$this->optimizer      = $optimizer;
		$this->email_delivery = $email_delivery;
		$this->redirects      = $redirects;
		$this->white_label    = $white_label;
		$this->db_optimizer   = $db_optimizer;
		$this->page_cache     = $page_cache;
		$this->config_editor  = $config_editor;
		$this->switches       = $switches;
	}

	/** The tier-aware operator on/off layer, built lazily from local plugin state. */
	private function switches(): IWSL_Feature_Switches {
		if ( null === $this->switches ) {
			$this->switches = new IWSL_Feature_Switches( $this->plugin->entitlements(), new IWSL_WP_Store() );
		}
		return $this->switches;
	}

	/**
	 * Canonical tab-id => FEATURE-flag map (the tier-gated engines). Ids absent
	 * here (overview, roadmap, config) carry no tier gate and are never switchable.
	 *
	 * @return array<string, string>
	 */
	private static function feature_flag_map(): array {
		return array(
			'images'            => IWSL_Media_Optimizer::FEATURE,
			'database'          => IWSL_DB_Optimizer::FEATURE,
			'email'             => IWSL_Email_Delivery::FEATURE,
			'redirects'         => IWSL_Redirects::FEATURE,
			'whitelabel'        => IWSL_White_Label::FEATURE,
			'cache'             => IWSL_Page_Cache::FEATURE,
			'lazy-load'         => IWSL_Lazy_Load::FEATURE,
			'media-protect'     => IWSL_Media_Protection::FEATURE,
			'cdn'               => IWSL_CDN_Rewrite::FEATURE,
			'duplicate'         => IWSL_Duplicate_Post::FEATURE,
			'seo-audit'         => IWSL_SEO_Audit::FEATURE,
			'svg'               => IWSL_SVG_Upload::FEATURE,
			'links'             => IWSL_Broken_Link_Scan::FEATURE,
			'maintenance'       => IWSL_Maintenance_Mode::FEATURE,
			'scheduled-cleanup' => IWSL_Scheduled_DB_Cleanup::FEATURE,
			'activity-log'      => IWSL_Activity_Log::FEATURE,
			'auto-convert'      => IWSL_Auto_Convert::FEATURE,
			'speed'             => IWSL_Speed_Pack::FEATURE,
			'response-scan'     => IWSL_Response_Scan::FEATURE,
			'statistics'        => IWSL_Statistics::FEATURE,
			'consent'           => IWSL_Cookie_Consent::FEATURE,
			'seo'               => IWSL_SEO_Suite::FEATURE,
		);
	}

	/** The FEATURE flag for a tab id, or null if the id has no tier gate. */
	private static function feature_flag_for( string $id ): ?string {
		$map = self::feature_flag_map();
		return $map[ $id ] ?? null;
	}

	/**
	 * Plain-English, one-line "what does this do" help per feature — no jargon,
	 * for the "?" bubble on each card. Kept deliberately short and concrete.
	 *
	 * @return array<string, string>
	 */
	private static function feature_help_map(): array {
		return array(
			'speed'             => __( 'Makes your pages load faster by trimming extra code and files.', 'infraweaver-connector' ),
			'cache'             => __( 'Keeps a ready-made copy of each page so visitors get it instantly.', 'infraweaver-connector' ),
			'cdn'               => __( 'Serves your images and files from servers closer to each visitor, so they load quicker.', 'infraweaver-connector' ),
			'lazy-load'         => __( 'Loads images only when a visitor scrolls to them, so the page opens sooner.', 'infraweaver-connector' ),
			'perf-audit'        => __( 'Times how long your server takes to build each page for visitors, so you can spot the slow ones. Free.', 'infraweaver-connector' ),
			'response-scan'     => __( 'Times the full round-trip to load each of your pages — connection, server and download — so you can compare before and after a change. Pro.', 'infraweaver-connector' ),
			'images'            => __( 'Shrinks image file sizes so pages load faster, without making pictures look worse.', 'infraweaver-connector' ),
			'auto-convert'      => __( 'Automatically turns your images into a smaller, faster format for you.', 'infraweaver-connector' ),
			'svg'               => __( 'Lets you safely upload logo and icon files that stay crisp at any size.', 'infraweaver-connector' ),
			'media-protect'     => __( 'Makes images you mark harder to right-click-save or drag-copy. A deterrent, not a lock.', 'infraweaver-connector' ),
			'seo'               => __( 'Helps Google understand your pages so more people can find your site.', 'infraweaver-connector' ),
			'seo-audit'         => __( 'Checks your pages for common Google mistakes and tells you what to fix.', 'infraweaver-connector' ),
			'duplicate'         => __( 'Copies a post or page in one click so you don’t start from scratch.', 'infraweaver-connector' ),
			'links'             => __( 'Finds links on your site that lead nowhere, so you can fix them.', 'infraweaver-connector' ),
			'redirects'         => __( 'Sends visitors from an old or changed web address to the right page.', 'infraweaver-connector' ),
			'statistics'        => __( 'Shows how many people visit your site — privately, with no outside trackers.', 'infraweaver-connector' ),
			'activity-log'      => __( 'Keeps a record of who changed what in your site’s admin.', 'infraweaver-connector' ),
			'consent'           => __( 'Shows visitors a cookie notice so you follow privacy rules.', 'infraweaver-connector' ),
			'maintenance'       => __( 'Shows a friendly “be right back” page to visitors while you work on the site.', 'infraweaver-connector' ),
			'whitelabel'        => __( 'Replaces WordPress branding with your own on the login and admin screens.', 'infraweaver-connector' ),
			'database'          => __( 'Clears out old clutter in your site’s database so it stays lean and quick.', 'infraweaver-connector' ),
			'scheduled-cleanup' => __( 'Tidies the database automatically on a schedule, so you don’t have to.', 'infraweaver-connector' ),
			'email'             => __( 'Helps your site’s emails — like password resets — actually reach inboxes.', 'infraweaver-connector' ),
			'config'            => __( 'Advanced settings for how WordPress runs. Best left to an expert.', 'infraweaver-connector' ),
		);
	}

	/** Plain-English help for a tab id, or '' if none. */
	private static function feature_help( string $id ): string {
		$map = self::feature_help_map();
		return isset( $map[ $id ] ) ? (string) $map[ $id ] : '';
	}

	/**
	 * The central, warm, jargon-free "explainer" for every feature — one entry per
	 * feature tab id (~24). Each entry is copy meant for a NON-TECHNICAL owner:
	 *   - what      : one plain sentence, benefit-first (what it does for them).
	 *   - why       : why a normal owner would want it (the payoff).
	 *   - should    : plain guidance on whether to turn it on.
	 *   - steps     : 1–3 tiny plain steps of what to actually DO.
	 *   - on_effect : (optional) "when you switch it on, this happens" consequence,
	 *                 shown on the OFF card so the owner can decide before flipping.
	 *   - active    : (optional) the "it’s working — here’s what it’s doing" line,
	 *                 shown on a toggle feature’s panel once it is on.
	 * This is copy only — it changes no gate, save, field, or toggle behavior.
	 *
	 * @return array<string, array<string, mixed>>
	 */
	private static function feature_explainer_map(): array {
		return array(
			// ── Performance ──────────────────────────────────────────────
			'speed' => array(
				'what'      => __( 'Trims the extra bits of code and files your pages send, so they open faster for visitors.', 'infraweaver-connector' ),
				'why'       => __( 'Faster pages keep people from leaving, and search engines like quick sites too.', 'infraweaver-connector' ),
				'should'    => __( 'Good for almost every site. Turn it on, then have a quick look that everything still looks right.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Look over your site on a phone and a computer to check nothing changed.', 'infraweaver-connector' ),
					__( 'That’s it — it keeps working on its own.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Your pages start sending less code, so they load a little quicker straight away.', 'infraweaver-connector' ),
				'active'    => __( 'it’s tidying up the code on every page as it loads, so visitors get a lighter, faster page.', 'infraweaver-connector' ),
			),
			'cache' => array(
				'what'      => __( 'Saves a ready-made copy of each page so the next visitor gets it instantly.', 'infraweaver-connector' ),
				'why'       => __( 'Your site does the hard work once, then hands out the saved copy — so pages appear much faster.', 'infraweaver-connector' ),
				'should'    => __( 'Great for most sites, especially blogs and brochure sites. If you run a shop or members area, check that logged-in pages still update.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Open a few pages to make sure they look right.', 'infraweaver-connector' ),
					__( 'It refreshes the saved copies for you automatically.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Visitors start getting a saved copy of each page, which loads much faster than building it fresh every time.', 'infraweaver-connector' ),
				'active'    => __( 'it’s handing visitors a saved, ready-made copy of each page instead of rebuilding it on every visit.', 'infraweaver-connector' ),
			),
			'cdn' => array(
				'what'      => __( 'Serves your images and files from computers around the world, closer to each visitor.', 'infraweaver-connector' ),
				'why'       => __( 'Someone far away gets your pictures from a nearby computer instead of one across the globe, so they load quicker.', 'infraweaver-connector' ),
				'should'    => __( 'Worth it if you have visitors in many countries, or lots of images. You’ll need a delivery-network account first (a service that stores copies of your files worldwide).', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Sign up with a delivery network and copy the web address it gives you.', 'infraweaver-connector' ),
					__( 'Use the short guided setup above to paste that address in.', 'infraweaver-connector' ),
					__( 'Save — your files start loading from the nearest computer.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Your images, styles and scripts start loading from a nearby delivery computer instead of only your own.', 'infraweaver-connector' ),
			),
			'lazy-load' => array(
				'what'      => __( 'Waits to load each image until a visitor scrolls down to it.', 'infraweaver-connector' ),
				'why'       => __( 'The top of your page appears sooner, because the browser isn’t loading pictures nobody has looked at yet.', 'infraweaver-connector' ),
				'should'    => __( 'Good for almost every site, especially long pages with lots of images.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Scroll one of your image-heavy pages to see pictures appear as you go.', 'infraweaver-connector' ),
					__( 'It works automatically from then on.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Off-screen images wait to load until a visitor scrolls to them, so the page opens sooner.', 'infraweaver-connector' ),
				'active'    => __( 'it’s holding back off-screen images and loading each one only as visitors scroll to it.', 'infraweaver-connector' ),
			),
			'perf-audit' => array(
				'what'      => __( 'Times how long your site takes to build each page, so you can spot the slow ones.', 'infraweaver-connector' ),
				'why'       => __( 'You see which pages are dragging, so you know where to focus before visitors notice.', 'infraweaver-connector' ),
				'should'    => __( 'Handy for everyone — it only measures, it never changes your site. Free.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Leave it on and browse your own site normally.', 'infraweaver-connector' ),
					__( 'Come back here to see which pages took the longest to build.', 'infraweaver-connector' ),
					__( 'Nothing else to do — it just watches quietly.', 'infraweaver-connector' ),
				),
				'active'    => __( 'it’s quietly timing each page as it loads and keeping a list of the slowest ones for you.', 'infraweaver-connector' ),
			),
			'response-scan' => array(
				'what'      => __( 'Loads your pages a few times and measures the full trip, so you can compare speed before and after a change.', 'infraweaver-connector' ),
				'why'       => __( 'You get real numbers that prove a change actually made your site faster — not just a feeling.', 'infraweaver-connector' ),
				'should'    => __( 'Useful when you’re tuning speed and want proof. Otherwise you can leave it for later. Pro.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Use the short setup above to pick which pages to time.', 'infraweaver-connector' ),
					__( 'Run your first check to record a starting point.', 'infraweaver-connector' ),
					__( 'Make a change, then run it again to compare.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'You’ll be able to pick pages, time them, and keep before-and-after speed results here.', 'infraweaver-connector' ),
			),

			// ── Media ────────────────────────────────────────────────────
			'images' => array(
				'what'      => __( 'Shrinks the file size of your pictures without making them look any worse.', 'infraweaver-connector' ),
				'why'       => __( 'Smaller pictures mean faster pages and less storage used — and no one can tell the difference.', 'infraweaver-connector' ),
				'should'    => __( 'Good for almost every site. It keeps your original pictures untouched, so it’s safe to try.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Choose the pictures to shrink, or let it work through your whole library.', 'infraweaver-connector' ),
					__( 'Start the run and let it work through them.', 'infraweaver-connector' ),
					__( 'Done — your pages now use the lighter versions.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'You can pick pictures and it will make lighter copies of them, leaving your originals safe.', 'infraweaver-connector' ),
			),
			'auto-convert' => array(
				'what'      => __( 'Automatically turns new pictures you upload into a smaller, faster format for you.', 'infraweaver-connector' ),
				'why'       => __( 'You never have to remember to shrink pictures — it happens quietly every time you add one.', 'infraweaver-connector' ),
				'should'    => __( 'Great if you add pictures often. If you rarely upload, you may not need it.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Upload a picture as usual.', 'infraweaver-connector' ),
					__( 'It quietly makes a lighter version behind the scenes.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'From now on, pictures you upload get a smaller, faster version made automatically.', 'infraweaver-connector' ),
				'active'    => __( 'it’s watching for new uploads and quietly making a lighter version of each one.', 'infraweaver-connector' ),
			),
			'svg' => array(
				'what'      => __( 'Lets you safely upload logo and icon files (a type called SVG) that stay sharp at any size.', 'infraweaver-connector' ),
				'why'       => __( 'Your logo looks crisp on every screen, big or small, and the file stays tiny.', 'infraweaver-connector' ),
				'should'    => __( 'Turn it on if you want to upload a logo or icons that never look blurry. Each file is checked for safety first.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Upload your logo or icon like any other picture.', 'infraweaver-connector' ),
					__( 'It’s cleaned and added safely to your library.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'You’ll be able to upload sharp logo and icon files, and each one is safety-checked before it’s saved.', 'infraweaver-connector' ),
				'active'    => __( 'it’s letting you upload crisp logo and icon files, cleaning each one for safety first.', 'infraweaver-connector' ),
			),
			'media-protect' => array(
				'what'      => __( 'Makes the pictures you choose harder for visitors to right-click, save, or drag away.', 'infraweaver-connector' ),
				'why'       => __( 'It discourages casual copying of your photos — a gentle deterrent, not a lock.', 'infraweaver-connector' ),
				'should'    => __( 'Nice if you show original photos or artwork. Remember: nothing online can be made truly impossible to copy.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Try right-clicking one of your pictures to see the difference.', 'infraweaver-connector' ),
					__( 'That’s it — it protects them from then on.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Right-click and drag-to-save get discouraged on your pictures, making casual copying harder.', 'infraweaver-connector' ),
				'active'    => __( 'it’s making your pictures harder to right-click or drag away, as a gentle deterrent.', 'infraweaver-connector' ),
			),

			// ── SEO & Content ────────────────────────────────────────────
			'seo' => array(
				'what'      => __( 'Helps search engines and social networks understand your pages, so more people can find you.', 'infraweaver-connector' ),
				'why'       => __( 'Better-described pages can show up higher in search and look nicer when shared, bringing more visitors.', 'infraweaver-connector' ),
				'should'    => __( 'Recommended for almost every site that wants to be found. A short setup gets the basics right.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Use the guided setup above to add your site name and a sharing picture.', 'infraweaver-connector' ),
					__( 'Turn on the site map so search engines can find every page (a site map is a list of all your pages).', 'infraweaver-connector' ),
					__( 'Fine-tune the rest later if you like.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Your pages start sending clear titles and descriptions to search engines and social networks.', 'infraweaver-connector' ),
			),
			'seo-audit' => array(
				'what'      => __( 'Checks your pages for common search-engine mistakes and tells you exactly what to fix.', 'infraweaver-connector' ),
				'why'       => __( 'You get a plain to-do list instead of guessing what’s holding your pages back.', 'infraweaver-connector' ),
				'should'    => __( 'Helpful for anyone who wants more visitors from search. It only checks — it changes nothing.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Look through the list of pages and suggestions.', 'infraweaver-connector' ),
					__( 'Fix the ones you can — small changes add up.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'It starts checking your pages and building a plain list of things you could improve for search.', 'infraweaver-connector' ),
				'active'    => __( 'it’s reviewing your pages and listing simple fixes that could help you show up in search.', 'infraweaver-connector' ),
			),
			'duplicate' => array(
				'what'      => __( 'Copies any post or page in one click, so you don’t have to rebuild it from scratch.', 'infraweaver-connector' ),
				'why'       => __( 'Reuse a page you already like as a starting point and just change what’s different.', 'infraweaver-connector' ),
				'should'    => __( 'Handy if you make similar pages often. There’s no downside to leaving it on.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Find a post or page in your list and click “Duplicate”.', 'infraweaver-connector' ),
					__( 'Edit the fresh copy however you like.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'A “Duplicate” link appears on your posts and pages so you can copy any one in a click.', 'infraweaver-connector' ),
				'active'    => __( 'it’s adding a one-click “Duplicate” option to your posts and pages.', 'infraweaver-connector' ),
			),
			'links' => array(
				'what'      => __( 'Finds links on your site that lead nowhere, so you can fix them.', 'infraweaver-connector' ),
				'why'       => __( 'Dead links frustrate visitors and can hurt how search engines see your site — this catches them for you.', 'infraweaver-connector' ),
				'should'    => __( 'Good for most sites, especially older ones with lots of pages. It only looks — it won’t change your content.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Let it scan, then review the broken links it found.', 'infraweaver-connector' ),
					__( 'Update or remove them so every link works.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'It starts checking your links and lists any that lead to a missing page.', 'infraweaver-connector' ),
				'active'    => __( 'it’s scanning your pages for links that lead nowhere and listing them for you to fix.', 'infraweaver-connector' ),
			),
			'redirects' => array(
				'what'      => __( 'Sends visitors from an old web address to the right page, instead of a “not found” error.', 'infraweaver-connector' ),
				'why'       => __( 'When you rename or move a page, people (and search engines) still land in the right place.', 'infraweaver-connector' ),
				'should'    => __( 'Turn it on when you change a page’s web address, or reorganise your site.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Add the old web address and the new one you want it to go to.', 'infraweaver-connector' ),
					__( 'Save — anyone visiting the old link now arrives at the new page.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'You’ll be able to point old or changed web addresses at the right page, so visitors never hit a dead end.', 'infraweaver-connector' ),
			),

			// ── Analytics ────────────────────────────────────────────────
			'statistics' => array(
				'what'      => __( 'Shows how many people visit your site, kept private with no outside trackers.', 'infraweaver-connector' ),
				'why'       => __( 'You see what’s popular and how you’re growing, without handing your visitors’ data to anyone else.', 'infraweaver-connector' ),
				'should'    => __( 'Great for almost any owner who’s curious about their traffic. It respects visitor privacy.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Let a little time pass so visits are recorded.', 'infraweaver-connector' ),
					__( 'Come back here to see your visitor numbers.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'It starts counting visits privately on your own site, with no third-party trackers.', 'infraweaver-connector' ),
				'active'    => __( 'it’s privately counting your visitors right here, without sharing anything with outside companies.', 'infraweaver-connector' ),
			),
			'activity-log' => array(
				'what'      => __( 'Keeps a record of who changed what in your site’s admin area.', 'infraweaver-connector' ),
				'why'       => __( 'If something changes unexpectedly, you can see who did it and when — great when more than one person helps.', 'infraweaver-connector' ),
				'should'    => __( 'Useful if several people manage the site, or you just like a paper trail. It runs quietly in the background.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Carry on managing your site as normal.', 'infraweaver-connector' ),
					__( 'Check the log any time to see recent changes.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'It starts noting each important change in your admin, with who did it and when.', 'infraweaver-connector' ),
				'active'    => __( 'it’s quietly recording who changes what in your admin, so you always have a history.', 'infraweaver-connector' ),
			),

			// ── Privacy & Site ───────────────────────────────────────────
			'consent' => array(
				'what'      => __( 'Shows visitors a friendly cookie notice, so you follow privacy rules.', 'infraweaver-connector' ),
				'why'       => __( 'Many privacy laws require it, and it shows visitors you handle their data respectfully.', 'infraweaver-connector' ),
				'should'    => __( 'Recommended if you have visitors in Europe, or just want to be careful with privacy. One click applies safe defaults.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Use the guided setup above to apply the recommended settings.', 'infraweaver-connector' ),
					__( 'Adjust the wording or colour if you like.', 'infraweaver-connector' ),
					__( 'Save — visitors now see your cookie notice.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Visitors start seeing a cookie notice, and their choice is remembered.', 'infraweaver-connector' ),
			),
			'maintenance' => array(
				'what'      => __( 'Shows visitors a friendly “be right back” page while you work on the site.', 'infraweaver-connector' ),
				'why'       => __( 'People see a tidy message instead of a half-finished or broken-looking site during changes.', 'infraweaver-connector' ),
				'should'    => __( 'Turn it on only while you’re making big changes, then turn it off when you’re done. You can still see the real site while signed in.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above when you start working.', 'infraweaver-connector' ),
					__( 'Make your changes — visitors see the “be right back” page.', 'infraweaver-connector' ),
					__( 'Switch it off to open the site to everyone again.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Visitors see a friendly “be right back” page, while you (signed in) still see the real site.', 'infraweaver-connector' ),
				'active'    => __( 'it’s showing visitors a friendly “be right back” page — remember to switch it off when you’re done.', 'infraweaver-connector' ),
			),
			'whitelabel' => array(
				'what'      => __( 'Replaces the WordPress name and logo on the login and admin screens with your own.', 'infraweaver-connector' ),
				'why'       => __( 'The dashboard feels like your brand — nice for clients, or just a tidier look for you.', 'infraweaver-connector' ),
				'should'    => __( 'A finishing touch, mainly if you hand the site to clients. It’s purely for looks and changes nothing about how the site works.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Add your own logo and name in the settings.', 'infraweaver-connector' ),
					__( 'Save — the login and admin now wear your brand.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Your own logo and name replace the WordPress branding on the login and admin screens.', 'infraweaver-connector' ),
			),

			// ── System ───────────────────────────────────────────────────
			'database' => array(
				'what'      => __( 'Clears out old clutter in your site’s behind-the-scenes storage, so it stays lean and quick.', 'infraweaver-connector' ),
				'why'       => __( 'Over time your site piles up leftovers (old drafts, spam, junk) — tidying them keeps it nimble.', 'infraweaver-connector' ),
				'should'    => __( 'Good for most sites now and then. It shows you a preview first and never touches your real content.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Review the preview of what it would clean.', 'infraweaver-connector' ),
					__( 'Run the cleanup when you’re happy — your posts and pages stay safe.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'You’ll be able to preview and clear out old clutter, while your posts and pages stay untouched.', 'infraweaver-connector' ),
				'active'    => __( 'it’s ready to preview and tidy old clutter from your storage, always leaving your real content alone.', 'infraweaver-connector' ),
			),
			'scheduled-cleanup' => array(
				'what'      => __( 'Tidies that behind-the-scenes clutter automatically on a schedule, so you don’t have to remember.', 'infraweaver-connector' ),
				'why'       => __( 'Your site stays lean by itself — set it once and forget it.', 'infraweaver-connector' ),
				'should'    => __( 'Nice if you’d rather not do the tidy-up by hand. It sticks to safe limits and never removes your content.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Switch it on with the control above.', 'infraweaver-connector' ),
					__( 'Pick how often it should tidy up.', 'infraweaver-connector' ),
					__( 'Save — it takes care of the rest on its own.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'It starts tidying old clutter on a repeating schedule, within safe limits, on its own.', 'infraweaver-connector' ),
			),
			'email' => array(
				'what'      => __( 'Helps your site’s emails — like password resets and contact forms — actually reach people’s inboxes.', 'infraweaver-connector' ),
				'why'       => __( 'By default many hosts send email that lands in spam or vanishes; this makes it far more reliable.', 'infraweaver-connector' ),
				'should'    => __( 'Recommended if your site sends any email at all. You’ll need the sending details from your email provider.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Enter your email provider’s sending details below.', 'infraweaver-connector' ),
					__( 'Send a test email to check it arrives.', 'infraweaver-connector' ),
					__( 'Save — your site’s emails now go out reliably.', 'infraweaver-connector' ),
				),
				'on_effect' => __( 'Your site’s emails start going out through your chosen provider, so they’re far more likely to arrive.', 'infraweaver-connector' ),
			),
			'config' => array(
				'what'      => __( 'Advanced switches for how WordPress runs behind the scenes.', 'infraweaver-connector' ),
				'why'       => __( 'Lets an experienced person tune technical limits — most owners never need to touch this.', 'infraweaver-connector' ),
				'should'    => __( 'Best left alone unless someone technical is helping you. Changing the wrong thing here can affect the site.', 'infraweaver-connector' ),
				'steps'     => array(
					__( 'Only change something here if you know exactly what it does.', 'infraweaver-connector' ),
					__( 'When unsure, leave the defaults as they are.', 'infraweaver-connector' ),
					__( 'Save only after double-checking the value.', 'infraweaver-connector' ),
				),
			),
		);
	}

	/** The explainer entry for a tab id, or an empty array if none. */
	private static function feature_explainer( string $id ): array {
		$map = self::feature_explainer_map();
		return isset( $map[ $id ] ) && is_array( $map[ $id ] ) ? $map[ $id ] : array();
	}

	/**
	 * The toggle-only features (no guided wizard of their own) that become a fully
	 * GUIDED card: they show the "it’s working — here’s what it’s doing" confirmation
	 * line once switched on. The list mirrors the simple on/off engines.
	 *
	 * @return string[]
	 */
	private static function toggle_guided_ids(): array {
		return array(
			'cache', 'lazy-load', 'statistics', 'media-protect', 'maintenance', 'svg',
			'duplicate', 'auto-convert', 'database', 'activity-log', 'speed',
			'perf-audit', 'links', 'seo-audit',
		);
	}

	/**
	 * The calm, reusable "explainer" card drawn at the TOP of every feature panel —
	 * an icon plus "What this does", the payoff, a "Should I turn this on?" line and
	 * 1–3 tiny steps, all in plain, warm, jargon-free language for a non-technical
	 * owner. Styled with the existing .iwsl-* / --iw-* tokens and reads cleanly on
	 * mobile. Pure output — reads no request input, changes no state.
	 *
	 * $context tunes the closing line only:
	 *   - 'active' : (feature is on) a green confirmation for toggle-only features.
	 *   - 'off'    : (granted but off) a "when you switch it on…" consequence.
	 *   - 'locked' : (higher plan) explainer only; the card’s upgrade note follows.
	 * Renders nothing when the id has no explainer entry.
	 */
	private static function render_feature_intro( string $id, string $context = 'active' ): void {
		$x = self::feature_explainer( $id );
		if ( array() === $x ) {
			return;
		}
		$tab_icons = array();
		foreach ( self::tab_defs() as $tab ) {
			if ( isset( $tab['id'] ) ) {
				$tab_icons[ (string) $tab['id'] ] = (string) ( $tab['icon'] ?? 'lightbulb' );
			}
		}
		$icon = $tab_icons[ $id ] ?? 'lightbulb';

		echo '<div class="iwsl-intro">';
		echo '<span class="iwsl-intro__icon" aria-hidden="true"><span class="dashicons dashicons-' . esc_attr( $icon ) . '"></span></span>';
		echo '<div class="iwsl-intro__body">';

		if ( ! empty( $x['what'] ) ) {
			echo '<p class="iwsl-intro__what"><span class="iwsl-intro__lead">' . esc_html__( 'What this does', 'infraweaver-connector' ) . '</span>' . esc_html( (string) $x['what'] ) . '</p>';
		}
		if ( ! empty( $x['why'] ) ) {
			echo '<p class="iwsl-intro__why">' . esc_html( (string) $x['why'] ) . '</p>';
		}
		if ( ! empty( $x['should'] ) ) {
			echo '<p class="iwsl-intro__should"><span class="iwsl-intro__lead">' . esc_html__( 'Should I turn this on?', 'infraweaver-connector' ) . '</span>' . esc_html( (string) $x['should'] ) . '</p>';
		}
		if ( ! empty( $x['steps'] ) && is_array( $x['steps'] ) ) {
			echo '<p class="iwsl-intro__lead iwsl-intro__lead--steps">' . esc_html__( 'What to do', 'infraweaver-connector' ) . '</p>';
			echo '<ol class="iwsl-intro__steps">';
			foreach ( $x['steps'] as $step ) {
				echo '<li>' . esc_html( (string) $step ) . '</li>';
			}
			echo '</ol>';
		}

		if ( 'active' === $context && ! empty( $x['active'] ) && in_array( $id, self::toggle_guided_ids(), true ) ) {
			echo '<p class="iwsl-intro__state iwsl-intro__state--on"><span class="dashicons dashicons-yes-alt" aria-hidden="true"></span><span>'
				. '<strong>' . esc_html__( 'It’s working —', 'infraweaver-connector' ) . '</strong> '
				. esc_html( (string) $x['active'] ) . '</span></p>';
		} elseif ( 'off' === $context && ! empty( $x['on_effect'] ) ) {
			echo '<p class="iwsl-intro__state iwsl-intro__state--off"><span class="dashicons dashicons-arrow-up-alt" aria-hidden="true"></span><span>'
				. '<strong>' . esc_html__( 'When you switch it on:', 'infraweaver-connector' ) . '</strong> '
				. esc_html( (string) $x['on_effect'] ) . '</span></p>';
		}

		echo '</div>'; // .iwsl-intro__body
		echo '</div>'; // .iwsl-intro
	}

	/** Hook the admin menu + the image-optimization + email-delivery + redirect + db-optimize admin-post handlers. */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'admin_post_' . self::OPTIMIZE_ACTION, array( $this, 'handle_media_optimize' ) );
		add_action( 'admin_post_' . self::EMAIL_SETTINGS_ACTION, array( $this, 'handle_email_settings_save' ) );
		add_action( 'admin_post_' . self::EMAIL_LOG_CLEAR_ACTION, array( $this, 'handle_email_log_clear' ) );
		add_action( 'admin_post_' . self::EMAIL_TEST_ACTION, array( $this, 'handle_email_test' ) );
		add_action( 'admin_post_' . self::REDIRECT_ADD_ACTION, array( $this, 'handle_redirects_add' ) );
		add_action( 'admin_post_' . self::REDIRECT_DELETE_ACTION, array( $this, 'handle_redirects_delete' ) );
		add_action( 'admin_post_' . self::REDIRECT_LOG_ACTION, array( $this, 'handle_redirects_log' ) );
		add_action( 'admin_post_' . self::REDIRECT_AUTO_ACTION, array( $this, 'handle_redirects_auto' ) );
		add_action( 'admin_post_' . self::WHITE_LABEL_ACTION, array( $this, 'handle_white_label_save' ) );
		add_action( 'admin_post_' . self::DB_OPTIMIZE_ACTION, array( $this, 'handle_db_optimize' ) );
		add_action( 'admin_post_' . self::PAGE_CACHE_TOGGLE_ACTION, array( $this, 'handle_page_cache_toggle' ) );
		add_action( 'admin_post_' . self::PAGE_CACHE_PURGE_ACTION, array( $this, 'handle_page_cache_purge' ) );
		add_action( 'admin_post_' . self::CONFIG_SAVE_ACTION, array( $this, 'handle_config_save' ) );
		add_action( 'admin_post_' . self::FEATURE_TOGGLE_ACTION, array( $this, 'handle_feature_toggle' ) );
		add_action( 'admin_post_' . self::CONSENT_WIZARD_ACTION, array( $this, 'handle_cookie_wizard' ) );
	}

	/**
	 * Flip a feature's operator switch. cap + nonce + tier-gate (the switch itself
	 * refuses to enable a feature the tier doesn't grant). Redirects back to the
	 * originating category page with a per-user result toast. Never widens the
	 * signed entitlement — this only turns a granted feature off, or back on.
	 */
	public function handle_feature_toggle(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::FEATURE_TOGGLE_NONCE );

		$feature = isset( $_POST['feature'] ) ? sanitize_key( wp_unslash( (string) $_POST['feature'] ) ) : '';
		$on      = isset( $_POST['enable'] ) && '1' === (string) $_POST['enable'];
		$result  = $this->switches()->set( $feature, $on );

		// A deliberate disable purges the feature's footprint immediately (rather
		// than waiting for the next admin init sweep). `$feature` is already the
		// entitlement/FEATURE flag the switch keys on, so it maps straight to an
		// engine. Only on a successful OFF flip; the purge is isolation-safe.
		if ( ! $on && ! empty( $result['ok'] ) ) {
			IWSL_Teardown::purge( $feature, $this->plugin->entitlements(), new IWSL_WP_Store() );
		}

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::FEATURE_TOGGLE_RESULT . get_current_user_id(), $result, 60 );
		}

		$back = wp_get_referer();
		if ( ! is_string( $back ) || '' === $back ) {
			$back = admin_url( 'admin.php?page=infraweaver-plus' );
		}
		wp_safe_redirect( $back );
		exit;
	}

	/**
	 * One-click Cookie Consent guided setup: applies the GDPR-safe recommended
	 * defaults (turning the banner ON) plus any optional look-and-feel overrides
	 * the operator picked in the wizard. cap + nonce; the entitlement gate is
	 * re-checked inside apply_recommended_defaults() (STATEMENT 1 of save), so a
	 * locked site writes nothing. PRG back to the section the wizard was run from.
	 */
	public function handle_cookie_wizard(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::CONSENT_WIZARD_NONCE );

		$overrides = array();
		foreach ( array( 'accent', 'banner_layout', 'policy_url', 'title' ) as $key ) {
			if ( isset( $_POST[ $key ] ) && '' !== (string) $_POST[ $key ] ) {
				$overrides[ $key ] = sanitize_text_field( wp_unslash( (string) $_POST[ $key ] ) );
			}
		}
		if ( isset( $_POST['message'] ) && '' !== (string) $_POST['message'] ) {
			$overrides['message'] = sanitize_textarea_field( wp_unslash( (string) $_POST['message'] ) );
		}

		$cc     = new IWSL_Cookie_Consent( $this->plugin->entitlements(), new IWSL_WP_Store() );
		$result = $cc->apply_recommended_defaults( $overrides ); // gate is STATEMENT 1 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( self::CONSENT_WIZARD_RESULT . get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( iwsl_plus_redirect_base() );
		exit;
	}

	public function add_menu(): void {
		// Top-level sidebar entry → the status-only LANDING dashboard. Operators
		// land on a posture/overview page; every actual feature lives on its own
		// category sub-page (registered below), never on this main page.
		$this->page_hooks[] = (string) add_menu_page(
			'InfraWeaver Plus',
			'InfraWeaver Plus',
			'manage_options',
			'infraweaver-plus',
			array( $this, 'render_landing' ),
			'dashicons-shield',
			81
		);

		// Category sub-pages in the sidebar. Each is a REAL admin page with its own
		// slug + render callback that shows ONLY that group's feature tabs — not a
		// hash-link into one opaque page. The first item reuses the main slug so the
		// auto-duplicated "InfraWeaver Plus" row relabels to "Dashboard".
		if ( ! function_exists( 'add_submenu_page' ) ) {
			return;
		}
		$this->page_hooks[] = (string) add_submenu_page(
			'infraweaver-plus',
			'InfraWeaver Plus — Dashboard',
			'Dashboard',
			'manage_options',
			'infraweaver-plus',
			array( $this, 'render_landing' )
		);
		foreach ( self::group_meta() as $label => $meta ) {
			$group             = (string) $label;
			$this->page_hooks[] = (string) add_submenu_page(
				'infraweaver-plus',
				'InfraWeaver Plus — ' . $group,
				$group,
				'manage_options',
				'infraweaver-plus-' . $meta['slug'],
				function () use ( $group ) {
					$this->render_group_page( $group );
				}
			);
		}
	}

	/**
	 * Enqueue the WordPress media library JS ONLY on this plugin's own admin
	 * pages — never globally — so the image-optimizer / speed-pack "Choose
	 * images…" pickers can open `wp.media()`. Every Plus page hook (landing +
	 * the six category sub-pages) is captured in {@see add_menu()}; the picker
	 * lives on Media + Performance but enqueueing across all Plus pages is
	 * cheap, uniform, and future-proof.
	 */
	public function enqueue_assets( $hook ): void {
		if ( ! in_array( (string) $hook, $this->page_hooks, true ) ) {
			return;
		}
		if ( function_exists( 'wp_enqueue_media' ) ) {
			wp_enqueue_media();
		}
	}

	/** The optimizer, built once from the plugin's entitlement gate. */
	private function optimizer(): IWSL_Media_Optimizer {
		if ( null === $this->optimizer ) {
			$this->optimizer = new IWSL_Media_Optimizer( $this->plugin->entitlements() );
		}
		return $this->optimizer;
	}

	/** The email-delivery engine, built once from the plugin's entitlement gate + store. */
	private function email_delivery(): IWSL_Email_Delivery {
		if ( null === $this->email_delivery ) {
			$this->email_delivery = new IWSL_Email_Delivery( $this->plugin->entitlements(), $this->plugin->store() );
		}
		return $this->email_delivery;
	}

	/** The redirect manager, built once from the plugin's entitlement gate + store. */
	private function redirects(): IWSL_Redirects {
		if ( null === $this->redirects ) {
			$this->redirects = new IWSL_Redirects( $this->plugin->entitlements(), new IWSL_WP_Store() );
		}
		return $this->redirects;
	}

	/** The white-label engine, built once from the plugin's entitlement gate + store. */
	private function white_label(): IWSL_White_Label {
		if ( null === $this->white_label ) {
			$this->white_label = new IWSL_White_Label( $this->plugin->entitlements(), new IWSL_WP_Store() );
		}
		return $this->white_label;
	}

	/** The database optimizer, built once from the plugin's entitlement gate + global $wpdb. */
	private function db_optimizer(): IWSL_DB_Optimizer {
		if ( null === $this->db_optimizer ) {
			$this->db_optimizer = new IWSL_DB_Optimizer( $this->plugin->entitlements() );
		}
		return $this->db_optimizer;
	}

	/** The page-cache controller, built once from the plugin's entitlement gate. */
	private function page_cache(): IWSL_Page_Cache {
		if ( null === $this->page_cache ) {
			$this->page_cache = new IWSL_Page_Cache( $this->plugin->entitlements() );
		}
		return $this->page_cache;
	}

	/** The config editor, built once. No entitlement — the site's own admin edits their own config. */
	private function config_editor(): IWSL_Config_Editor {
		if ( null === $this->config_editor ) {
			$this->config_editor = new IWSL_Config_Editor();
		}
		return $this->config_editor;
	}

	/**
	 * Canonical category groups. Single source of truth for the sidebar sub-pages,
	 * the landing cards, and the group headers: display label → { slug, icon,
	 * blurb }. The slug forms the sub-page slug `infraweaver-plus-<slug>`. Order
	 * here is the order the groups appear everywhere.
	 */
	private static function group_meta(): array {
		return array(
			'Performance'    => array( 'slug' => 'performance', 'icon' => 'superhero', 'blurb' => 'Speed, caching, and delivery — make every page load fast.' ),
			'Media'          => array( 'slug' => 'media', 'icon' => 'format-image', 'blurb' => 'Compress, convert, and safely serve images and SVG.' ),
			'SEO & Content'  => array( 'slug' => 'seo', 'icon' => 'chart-area', 'blurb' => 'Metadata, audits, duplicates, links, and redirects.' ),
			'Analytics'      => array( 'slug' => 'analytics', 'icon' => 'chart-bar', 'blurb' => 'Private, first-party traffic and activity insight.' ),
			'Privacy & Site' => array( 'slug' => 'privacy', 'icon' => 'privacy', 'blurb' => 'Consent, maintenance, and white-label presentation.' ),
			'System'         => array( 'slug' => 'system', 'icon' => 'admin-generic', 'blurb' => 'Database hygiene, email delivery, and configuration.' ),
		);
	}

	/** The feature tabs (from {@see tab_defs()}) that belong to one category group, in order. */
	private static function group_tabs( string $group ): array {
		$out = array();
		foreach ( self::tab_defs() as $tab ) {
			if ( isset( $tab['group'] ) && (string) $tab['group'] === $group ) {
				$out[] = $tab;
			}
		}
		return $out;
	}

	/**
	 * The single most useful feature to try first in each category, with a plain
	 * one-line reason — the target of the "New here? Start with…" nudge at the top
	 * of every category page. Keyed by the group display label.
	 *
	 * @return array<string, array<string, string>>
	 */
	private static function group_starthere(): array {
		return array(
			'Performance'    => array( 'id' => 'cache', 'why' => __( 'it’s the biggest, safest speed boost for most sites.', 'infraweaver-connector' ) ),
			'Media'          => array( 'id' => 'images', 'why' => __( 'it shrinks your pictures so pages load faster, and your originals stay safe.', 'infraweaver-connector' ) ),
			'SEO & Content'  => array( 'id' => 'seo', 'why' => __( 'a quick setup helps search engines find and show your pages.', 'infraweaver-connector' ) ),
			'Analytics'      => array( 'id' => 'statistics', 'why' => __( 'it shows who visits your site, kept completely private.', 'infraweaver-connector' ) ),
			'Privacy & Site' => array( 'id' => 'consent', 'why' => __( 'one click applies privacy-friendly cookie settings.', 'infraweaver-connector' ) ),
			'System'         => array( 'id' => 'email', 'why' => __( 'it makes sure your site’s emails actually reach people.', 'infraweaver-connector' ) ),
		);
	}

	/**
	 * A calm "New here? Start with <feature> — <reason>" line at the top of a
	 * category page, linking to that feature's card on the same page. Renders
	 * nothing if the group has no recommendation or the feature isn't present.
	 */
	private static function render_group_starthere( string $group, array $tabs ): void {
		$map = self::group_starthere();
		if ( ! isset( $map[ $group ] ) ) {
			return;
		}
		$rec   = $map[ $group ];
		$rid   = (string) ( $rec['id'] ?? '' );
		$label = '';
		foreach ( $tabs as $tab ) {
			if ( isset( $tab['id'] ) && (string) $tab['id'] === $rid ) {
				$label = (string) $tab['label'];
				break;
			}
		}
		if ( '' === $label ) {
			return;
		}
		$link = '<a href="' . esc_attr( '#iwsl-card-' . $rid ) . '">' . esc_html( $label ) . '</a>';
		echo '<p class="iwsl-starthere">';
		echo '<span class="dashicons dashicons-lightbulb" aria-hidden="true"></span>';
		echo '<span>' . sprintf(
			/* translators: 1: linked feature name (HTML), 2: plain-language reason to start there. */
			esc_html__( 'New here? Start with %1$s — %2$s', 'infraweaver-connector' ),
			$link,
			esc_html( (string) ( $rec['why'] ?? '' ) )
		) . '</span>';
		echo '</p>';
	}

	/**
	 * Per-feature unlock state, keyed by tab id. Drives the live status dot on
	 * each tab, the landing cards' lock glyphs, and the tier inference. Reads only
	 * local plugin state via IWSL_Entitlements::evaluate — never a network call.
	 */
	private function unlocked_map(): array {
		$ent      = $this->plugin->entitlements();
		$unlocked = array();
		foreach ( self::feature_flag_map() as $key => $feature ) {
			$fg               = $ent->evaluate( $feature );
			$unlocked[ $key ] = ! empty( $fg['unlocked'] );
		}
		return $unlocked;
	}

	/**
	 * The data-driven "new engine" panels: tab id → [ display label, render
	 * closure ]. A LOCKED feature shows one quiet, uniform placeholder instead of
	 * a loud per-engine "🔒 … requires a plan" block — the tab lock already
	 * communicates it; the panel behind it stays calm.
	 */
	private function new_engine_panels(): array {
		$ent = $this->plugin->entitlements();
		return array(
			'speed'             => array( 'Speed Pack', function () use ( $ent ) { ( new IWSL_Speed_Pack( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'response-scan'     => array( 'Response Time Scanner', function () use ( $ent ) { ( new IWSL_Response_Scan( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'cdn'               => array( 'CDN URL Rewrite', function () use ( $ent ) { ( new IWSL_CDN_Rewrite( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'lazy-load'         => array( 'Lazy-Load Media', function () use ( $ent ) { ( new IWSL_Lazy_Load( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'media-protect'     => array( 'Media Protection', function () use ( $ent ) { ( new IWSL_Media_Protection( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'auto-convert'      => array( 'Scheduled Auto-Convert', function () use ( $ent ) { ( new IWSL_Auto_Convert( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'svg'               => array( 'SVG Uploads', function () use ( $ent ) { ( new IWSL_SVG_Upload( $ent ) )->render_section(); } ),
			'seo-audit'         => array( 'SEO Meta Audit', function () use ( $ent ) { ( new IWSL_SEO_Audit( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'duplicate'         => array( 'One-Click Duplicate', function () use ( $ent ) { ( new IWSL_Duplicate_Post( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'links'             => array( 'Broken Link Scanner', function () use ( $ent ) { ( new IWSL_Broken_Link_Scan( $ent ) )->render_section(); } ),
			'seo'               => array( 'SEO Suite', function () use ( $ent ) { ( new IWSL_SEO_Suite( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'statistics'        => array( 'Site Statistics', function () use ( $ent ) { ( new IWSL_Statistics( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'activity-log'      => array( 'Activity Log', function () use ( $ent ) { ( new IWSL_Activity_Log( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'consent'           => array( 'Cookie Consent', function () use ( $ent ) { ( new IWSL_Cookie_Consent( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'maintenance'       => array( 'Maintenance Mode', function () use ( $ent ) { ( new IWSL_Maintenance_Mode( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
			'scheduled-cleanup' => array( 'Scheduled Database Cleanup', function () use ( $ent ) { ( new IWSL_Scheduled_DB_Cleanup( $ent, new IWSL_WP_Store() ) )->render_section(); } ),
		);
	}

	/**
	 * Render the BODY of one tab panel by id — the same guarded machinery the
	 * single page used, factored so each category sub-page can render just its own
	 * tabs. Legacy engines self-handle their own locked/unlocked notice; the
	 * data-driven engines use the `$unlocked ? render_section() : locked_panel`
	 * pattern. Gating/nonce/entitlement logic is untouched — this only routes.
	 */
	private function render_panel_for( string $id, array $unlocked ): void {
		// A calm, plain-English explainer at the TOP of every feature panel, so a
		// non-technical owner always sees what the feature does, why it helps, and
		// what to do — before any controls. This is the ON context (the card only
		// renders this body when the feature is granted and switched on).
		self::render_feature_intro( $id, 'active' );

		switch ( $id ) {
			case 'images':
				$this->render_image_optimization_section();
				return;
			case 'database':
				$this->render_db_optimizer_section();
				return;
			case 'email':
				$this->render_email_delivery_section();
				return;
			case 'redirects':
				$this->render_redirects_section();
				return;
			case 'whitelabel':
				$this->render_white_label_section();
				return;
			case 'cache':
				$this->render_page_cache_section();
				return;
			case 'config':
				$this->render_config_section();
				return;
			case 'perf-audit':
				$this->render_perf_audit_section();
				return;
			case 'consent':
				$this->render_consent_section( ! empty( $unlocked['consent'] ) );
				return;
		}
		$new = $this->new_engine_panels();
		if ( isset( $new[ $id ] ) ) {
			if ( ! empty( $unlocked[ $id ] ) ) {
				// A guided-setup wizard sits ABOVE the engine's own form when the
				// feature is unconfigured; the engine's full form always renders below.
				$this->maybe_render_engine_wizard( $id );
				( $new[ $id ][1] )();
			} else {
				self::render_locked_panel( (string) $new[ $id ][0] );
			}
		}
	}

	/**
	 * Render a guided-setup wizard for an engine-owned panel (CDN, Response Time
	 * Scanner, SEO Suite) when that feature is unconfigured. Each wizard submits to
	 * the ENGINE'S EXISTING admin-post save action + nonce, reusing its exact field
	 * names — no new save endpoint is introduced. The engine's own render_section()
	 * still draws the full form beneath, so the page works with JavaScript disabled.
	 */
	private function maybe_render_engine_wizard( string $id ): void {
		$ent = $this->plugin->entitlements();
		switch ( $id ) {
			case 'cdn':
				$this->maybe_render_cdn_wizard( new IWSL_CDN_Rewrite( $ent, new IWSL_WP_Store() ) );
				return;
			case 'response-scan':
				$this->maybe_render_response_scan_wizard( new IWSL_Response_Scan( $ent, new IWSL_WP_Store() ) );
				return;
			case 'seo':
				$this->maybe_render_seo_wizard( new IWSL_SEO_Suite( $ent, new IWSL_WP_Store() ) );
				return;
		}
	}

	/**
	 * CDN URL Rewrite wizard — shown only when no CDN host is configured. Submits to
	 * IWSL_CDN_Rewrite::SETTINGS_ACTION with the engine's own `host` + `enabled`
	 * fields; the engine's full form still renders below.
	 */
	private function maybe_render_cdn_wizard( IWSL_CDN_Rewrite $cdn ): void {
		$settings = $cdn->settings();
		if ( '' !== (string) ( $settings['host'] ?? '' ) ) {
			return; // a host is set — already configured.
		}
		$this->wizard_open(
			'cdn',
			__( 'Point your CDN at this site — guided setup', 'infraweaver-connector' ),
			array(
				'action' => IWSL_CDN_Rewrite::SETTINGS_ACTION,
				'nonce'  => IWSL_CDN_Rewrite::SETTINGS_NONCE,
				'icon'   => 'cloud',
				'submit' => __( 'Save changes', 'infraweaver-connector' ),
				'launch' => array(
					'heading' => __( 'Serve images & files from your CDN', 'infraweaver-connector' ),
					'body'    => __( 'A CDN serves your static files from servers closer to each visitor, so pages load quicker. A short walk-through connects yours.', 'infraweaver-connector' ),
					'button'  => __( 'Connect a CDN in 2 steps', 'infraweaver-connector' ),
				),
				'steps'  => array(
					array(
						'title' => __( 'Before you start', 'infraweaver-connector' ),
						'body'  => static function (): void {
							echo '<p>' . esc_html__( 'This rewrites the address of your images, CSS, JavaScript and fonts to your CDN host. Your pages, admin and login always stay on this site.', 'infraweaver-connector' ) . '</p>';
							echo '<p class="iwsl-wz__note">' . esc_html__( 'Your delivery network needs to be set up to fetch files from this site first (this is often called a “pull zone”). If it can’t reach your site, your images and files won’t show up — so set that up before turning this on.', 'infraweaver-connector' ) . '</p>';
						},
					),
					array(
						'title' => __( 'Your CDN host', 'infraweaver-connector' ),
						'body'  => static function (): void {
							echo '<p>' . esc_html__( 'Enter the hostname your CDN gave you — just the host, no https:// and no trailing path.', 'infraweaver-connector' ) . '</p>';
							echo '<div class="iwsl-wz__fields">';
							self::wizard_field( 'text', 'host', __( 'CDN host', 'infraweaver-connector' ), '', 'cdn.example.com' );
							echo '</div>';
							self::wizard_checkbox( 'enabled', __( 'Start serving static assets from the CDN now', 'infraweaver-connector' ), true );
						},
					),
				),
			)
		);
	}

	/**
	 * Response Time Scanner wizard — shown only when no URLs are configured and no
	 * scan has ever run. Submits to IWSL_Response_Scan::SCAN_ACTION with the
	 * engine's own `iwsl_rs_*` fields, which both saves the URL list and runs the
	 * first scan; the engine's full form still renders below.
	 */
	private function maybe_render_response_scan_wizard( IWSL_Response_Scan $scan ): void {
		$settings = $scan->settings();
		$has_urls = '' !== trim( (string) ( $settings['urls'] ?? '' ) );
		if ( $has_urls || array() !== $scan->snapshots() ) {
			return; // URLs chosen, or at least one scan already taken.
		}
		$runs = isset( $settings['runs'] ) ? (int) $settings['runs'] : IWSL_Response_Scan::RUNS_DEFAULT;
		$this->wizard_open(
			'response-scan',
			__( 'Choose which pages to time — guided setup', 'infraweaver-connector' ),
			array(
				'action' => IWSL_Response_Scan::SCAN_ACTION,
				'nonce'  => IWSL_Response_Scan::SCAN_NONCE,
				'icon'   => 'chart-line',
				'submit' => __( 'Run my first scan', 'infraweaver-connector' ),
				'launch' => array(
					'heading' => __( 'Measure how fast your pages load', 'infraweaver-connector' ),
					'body'    => __( 'Times the full round-trip to load your pages so you can compare before and after a change. Pick which pages to time and run the first scan.', 'infraweaver-connector' ),
					'button'  => __( 'Set up in 2 steps', 'infraweaver-connector' ),
				),
				'steps'  => array(
					array(
						'title' => __( 'What this does', 'infraweaver-connector' ),
						'body'  => static function (): void {
							echo '<p>' . esc_html__( 'It loads each page a few times and keeps the middle result, so one slow blip doesn’t throw off the number. It counts the whole trip — connecting, your site building the page, and downloading it.', 'infraweaver-connector' ) . '</p>';
							echo '<p>' . esc_html__( 'Your home page is always included. Add any other important pages below.', 'infraweaver-connector' ) . '</p>';
						},
					),
					array(
						'title' => __( 'Which pages to time', 'infraweaver-connector' ),
						'body'  => static function () use ( $runs ): void {
							echo '<div class="iwsl-wz__fields">';
							self::wizard_textarea( 'iwsl_rs_urls', __( 'Extra URLs (one per line)', 'infraweaver-connector' ), '', rtrim( (string) home_url(), '/' ) . "/shop/\n" . rtrim( (string) home_url(), '/' ) . '/about/', 4 );
							self::wizard_field( 'number', 'iwsl_rs_runs', __( 'Loads per page (we keep the middle result)', 'infraweaver-connector' ), (string) $runs, '', array( 'min' => (string) IWSL_Response_Scan::RUNS_MIN, 'max' => (string) IWSL_Response_Scan::RUNS_MAX ) );
							self::wizard_field( 'text', 'iwsl_rs_label', __( 'Label for this baseline (optional)', 'infraweaver-connector' ), '', __( 'e.g. before lossless images', 'infraweaver-connector' ) );
							echo '</div>';
							self::wizard_checkbox( 'iwsl_rs_include_sitemap', __( 'Also time a few top pages from my sitemap', 'infraweaver-connector' ), false );
						},
					),
				),
			)
		);
	}

	/**
	 * SEO Suite quick-setup wizard — shown only when the SEO settings have never
	 * been saved (settings()['saved_at'] === 0). Submits to
	 * IWSL_SEO_Suite::SAVE_ACTION with the engine's own `iwseo_*` fields; the
	 * engine's full Search Appearance form still renders below.
	 */
	private function maybe_render_seo_wizard( IWSL_SEO_Suite $seo ): void {
		$settings = $seo->settings();
		if ( ! empty( $settings['saved_at'] ) ) {
			return; // already configured.
		}
		$this->wizard_open(
			'seo',
			__( 'SEO basics — guided setup', 'infraweaver-connector' ),
			array(
				'action' => IWSL_SEO_Suite::SAVE_ACTION,
				'nonce'  => IWSL_SEO_Suite::SAVE_NONCE,
				'icon'   => 'search',
				'submit' => __( 'Save SEO settings', 'infraweaver-connector' ),
				'launch' => array(
					'heading' => __( 'Help Google understand your site', 'infraweaver-connector' ),
					'body'    => __( 'Set your brand name, a default sharing picture and turn on a site map (a list of all your pages) so search engines can find every page. Fine-tune everything afterwards.', 'infraweaver-connector' ),
					'button'  => __( 'Set up SEO basics', 'infraweaver-connector' ),
				),
				'steps'  => array(
					array(
						'title' => __( 'What this does', 'infraweaver-connector' ),
						'body'  => static function (): void {
							echo '<p>' . esc_html__( 'These three basics cover most of what search engines and social networks look for. You can fine-tune your page titles, wording and more on the full form afterwards.', 'infraweaver-connector' ) . '</p>';
						},
					),
					array(
						'title' => __( 'Your brand & sitemap', 'infraweaver-connector' ),
						'body'  => static function (): void {
							echo '<div class="iwsl-wz__fields">';
							self::wizard_field( 'text', 'iwseo_org_name', __( 'Site / brand name', 'infraweaver-connector' ), (string) get_bloginfo( 'name' ), get_bloginfo( 'name' ) );
							self::wizard_field( 'text', 'iwseo_default_social_image', __( 'Default share image URL', 'infraweaver-connector' ), '', '/wp-content/uploads/brand/social.png' );
							echo '</div>';
							echo '<p class="description">' . esc_html__( 'The share image is used when a page is posted to social media and has no image of its own.', 'infraweaver-connector' ) . '</p>';
							self::wizard_checkbox( 'iwseo_sitemap_enabled', __( 'Turn on the site map (recommended)', 'infraweaver-connector' ), true, __( 'Creates a tidy list of all your pages and points search engines to it, so every page gets found.', 'infraweaver-connector' ) );
						},
					),
				),
			)
		);
	}

	/**
	 * Infer a DISPLAY tier from the locally-unlocked flags — the plugin holds the
	 * entitlement FLAG map, not a tier name. white_label ⇒ Ultimate; any other
	 * granted tool flag ⇒ Pro; else `plus` only ⇒ Basic; else Free.
	 */
	private static function infer_tier( array $unlocked, bool $plus_unlocked ): string {
		if ( ! empty( $unlocked['whitelabel'] ) ) {
			return 'Ultimate';
		}
		foreach ( $unlocked as $key => $on ) {
			if ( $on && 'whitelabel' !== $key ) {
				return 'Pro';
			}
		}
		return $plus_unlocked ? 'Basic' : 'Free';
	}

	/** A prominent, plan-colored tier badge (Free / Basic / Pro / Ultimate). */
	private static function render_tier_badge( string $tier ): void {
		$slug = strtolower( $tier );
		echo '<span class="iwsl-tier iwsl-tier--' . esc_attr( $slug ) . '">';
		echo '<span class="iwsl-tier__gem" aria-hidden="true"></span>';
		echo '<span class="iwsl-tier__label">' . esc_html( $tier ) . '</span>';
		echo '<span class="screen-reader-text"> ' . esc_html__( 'plan tier', 'infraweaver-connector' ) . '</span>';
		echo '</span>';
	}

	/**
	 * The main "InfraWeaver Plus" page: a STATUS-ONLY landing dashboard. No forms,
	 * no feature control surface — identity, connector version, current tier, gate
	 * posture, the read-only Plus snapshot, and a grid of category cards that link
	 * to each feature sub-page. Every actual feature lives on its sub-page.
	 */
	public function render_landing(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'infraweaver-connector' ) );
		}
		$gate     = $this->plugin->entitlements()->evaluate( 'plus' );
		$unlocked = $this->unlocked_map();
		$tier     = self::infer_tier( $unlocked, ! empty( $gate['unlocked'] ) );

		// First-run "explain everything" guide: auto-opens once per user, then can be
		// reopened on demand from the "Show guide" button. Marking it seen at render
		// time (not on dismissal) means it pops up exactly once and never nags again.
		$seen            = ( function_exists( 'get_user_meta' ) && function_exists( 'get_current_user_id' ) )
			? get_user_meta( get_current_user_id(), 'iwsl_seen_welcome', true ) : '1';
		$auto_open_guide = empty( $seen );
		if ( $auto_open_guide && function_exists( 'update_user_meta' ) && function_exists( 'get_current_user_id' ) ) {
			update_user_meta( get_current_user_id(), 'iwsl_seen_welcome', 1 );
		}

		echo '<div class="wrap iwsl-shell iwsl-shell--landing" data-iwsl-scope="landing">';
		self::render_shell_styles();
		$this->render_hero( $gate );

		echo '<div class="iwsl-panels"><div class="iwsl-landing">';

		self::render_welcome_wizard( $auto_open_guide );

		$this->render_landing_status( $tier, $gate );
		self::render_landing_cards( $unlocked );

		// Read-only Plus snapshot — status content, not a control surface.
		echo '<section class="iwsl-landing__snapshot">';
		echo '<h2>' . esc_html__( 'Site Content & Health Snapshot', 'infraweaver-connector' ) . '</h2>';
		if ( ! empty( $gate['unlocked'] ) ) {
			IWSL_Plus_Feature::render();
		} else {
			self::render_locked_notice( $gate );
		}
		echo '</section>';

		// Roadmap — inert previews of what Pro and Ultimate will add.
		echo '<section class="iwsl-landing__roadmap">';
		echo '<h2>' . esc_html__( 'Roadmap', 'infraweaver-connector' ) . '</h2>';
		echo '<p class="iwsl-lede">' . esc_html__( 'Features on the way. Nothing here is active yet — these are inert previews of what Pro and Ultimate will add.', 'infraweaver-connector' ) . '</p>';
		self::render_coming_soon();
		echo '</section>';

		echo '</div></div>'; // .iwsl-landing .iwsl-panels

		self::render_shell_script();
		echo '</div>'; // .wrap.iwsl-shell
	}

	/** Landing status strip: tier badge + site identity, and the live gate posture table. */
	private function render_landing_status( string $tier, array $gate ): void {
		$name    = (string) get_bloginfo( 'name' );
		$url     = (string) home_url();
		$pretty  = preg_replace( '#^https?://#', '', $url );
		$version = defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : '';

		echo '<section class="iwsl-status">';

		echo '<div class="iwsl-status__id">';
		echo '<div class="iwsl-status__tier">';
		self::render_tier_badge( $tier );
		echo '<span class="iwsl-status__tierhint">' . esc_html__( 'Current plan', 'infraweaver-connector' ) . '</span>';
		echo '</div>';
		echo '<h2 class="iwsl-status__site">' . esc_html( '' !== $name ? $name : __( 'This site', 'infraweaver-connector' ) ) . '</h2>';
		echo '<a class="iwsl-status__url" href="' . esc_url( $url ) . '" target="_blank" rel="noopener noreferrer">' . esc_html( (string) $pretty ) . '</a>';
		if ( '' !== $version ) {
			echo '<p class="iwsl-status__ver"><span class="dashicons dashicons-shield" aria-hidden="true"></span> ' . esc_html( sprintf( /* translators: %s: version string. */ __( 'Connector v%s', 'infraweaver-connector' ), $version ) ) . '</p>';
		}
		echo '</div>';

		echo '<div class="iwsl-status__gate">';
		echo '<h3>' . esc_html__( 'Link posture', 'infraweaver-connector' ) . '</h3>';
		echo '<p class="iwsl-lede" style="margin-bottom:6px;">' . wp_kses(
			__( 'Every Plus feature runs only when this site is <strong>linked</strong>, shows a <strong>fresh signed heartbeat</strong>, and has the matching entitlement granted from the console.', 'infraweaver-connector' ),
			array( 'strong' => array() )
		) . '</p>';
		self::render_gate_table( $gate );
		echo '</div>';

		echo '</section>';
	}

	/**
	 * The category-card grid: one card per group linking to its sub-page, showing
	 * the group's feature list with a per-feature unlock/lock glyph and an
	 * active-count meter. Navigation only — no forms, no actions on the landing.
	 */
	private static function render_landing_cards( array $unlocked ): void {
		echo '<nav class="iwsl-cards" aria-label="' . esc_attr__( 'Feature categories', 'infraweaver-connector' ) . '">';
		foreach ( self::group_meta() as $group => $meta ) {
			$tabs  = self::group_tabs( (string) $group );
			$total = count( $tabs );
			$open  = 0;
			foreach ( $tabs as $tab ) {
				$tid = $tab['id'];
				if ( ! array_key_exists( $tid, $unlocked ) || ! empty( $unlocked[ $tid ] ) ) {
					++$open;
				}
			}
			$href = admin_url( 'admin.php?page=infraweaver-plus-' . $meta['slug'] );

			echo '<a class="iwsl-card" href="' . esc_url( $href ) . '">';
			echo '<span class="iwsl-card__go" aria-hidden="true"><span class="dashicons dashicons-arrow-right-alt"></span></span>';
			echo '<span class="iwsl-card__icon" aria-hidden="true"><span class="dashicons dashicons-' . esc_attr( $meta['icon'] ) . '"></span></span>';
			echo '<span class="iwsl-card__head">';
			echo '<span class="iwsl-card__title">' . esc_html( (string) $group ) . '</span>';
			echo '<span class="iwsl-card__count">' . esc_html( sprintf( /* translators: 1: active feature count, 2: total feature count. */ __( '%1$d of %2$d active', 'infraweaver-connector' ), $open, $total ) ) . '</span>';
			echo '</span>';
			echo '<span class="iwsl-card__blurb">' . esc_html( $meta['blurb'] ) . '</span>';
			echo '<span class="iwsl-card__list">';
			foreach ( $tabs as $tab ) {
				$tid    = $tab['id'];
				$locked = array_key_exists( $tid, $unlocked ) && empty( $unlocked[ $tid ] );
				echo '<span class="iwsl-card__feat' . ( $locked ? ' is-locked' : '' ) . '">';
				echo '<span class="dashicons dashicons-' . ( $locked ? 'lock' : 'yes' ) . '" aria-hidden="true"></span>';
				echo esc_html( $tab['label'] );
				echo '</span>';
			}
			echo '</span>';
			echo '</a>';
		}
		echo '</nav>';
	}

	/**
	 * The first-run "explain everything" guide: a dismissible <dialog> that greets
	 * the owner, says in one line what InfraWeaver Plus is, then walks the six
	 * feature categories (group_meta blurbs + each feature's plain-English help
	 * one-liner) and ends with links into every category page. Auto-opens once per
	 * user (see render_landing); a "Show guide" button reopens it any time.
	 * Self-contained inline CSS/JS under .iwsl-shell — no external asset.
	 */
	private static function render_welcome_wizard( bool $auto_open ): void {
		self::render_welcome_wizard_styles();

		// The reopen control — always present, so the guide is never a one-shot.
		echo '<div class="iwsl-welcome-bar">';
		echo '<button type="button" class="button button-secondary" data-ww-open="1"><span class="dashicons dashicons-book-alt" aria-hidden="true"></span>' . esc_html__( 'Show guide', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		$greeting = self::welcome_greeting();
		$auto     = $auto_open ? ' data-ww-auto="1"' : '';

		echo '<dialog class="iwsl-ww" id="iwsl-ww-dialog" aria-labelledby="iwsl-ww-title"' . $auto . '>';
		echo '<div class="iwsl-ww__inner">';

		echo '<div class="iwsl-ww__head">';
		echo '<span class="iwsl-ww__mark" aria-hidden="true"><span class="dashicons dashicons-shield"></span></span>';
		echo '<h2 class="iwsl-ww__title" id="iwsl-ww-title">' . esc_html( $greeting ) . '</h2>';
		echo '<button type="button" class="iwsl-ww__x" data-ww-close="1" aria-label="' . esc_attr__( 'Close', 'infraweaver-connector' ) . '">&times;</button>';
		echo '</div>';
		echo '<p class="iwsl-ww__progress" data-ww-tpl="' . esc_attr__( 'Step {n} of {t}', 'infraweaver-connector' ) . '" aria-hidden="true"></p>';

		echo '<div class="iwsl-ww__steps">';

		// Step 1 — Intro: one line on what InfraWeaver Plus is.
		echo '<section class="iwsl-ww__step" aria-label="' . esc_attr__( 'Welcome', 'infraweaver-connector' ) . '">';
		echo '<p class="iwsl-ww__lede">' . esc_html__( 'InfraWeaver Plus is a suite of console-granted power features for this site — speed, media, SEO, analytics, privacy and system tools, all managed from one place.', 'infraweaver-connector' ) . '</p>';
		echo '<p>' . esc_html__( 'This quick tour explains what each group of features does. It only pops up once — reopen it any time with “Show guide”.', 'infraweaver-connector' ) . '</p>';
		echo '</section>';

		// Steps 2..7 — one per category: the group blurb + per-feature help lines.
		foreach ( self::group_meta() as $label => $meta ) {
			$group = (string) $label;
			$tabs  = self::group_tabs( $group );
			echo '<section class="iwsl-ww__step" aria-label="' . esc_attr( $group ) . '">';
			echo '<div class="iwsl-ww__cat">';
			echo '<span class="iwsl-ww__cat-icon" aria-hidden="true"><span class="dashicons dashicons-' . esc_attr( $meta['icon'] ) . '"></span></span>';
			echo '<div><h3>' . esc_html( $group ) . '</h3><p>' . esc_html( $meta['blurb'] ) . '</p></div>';
			echo '</div>';
			echo '<ul class="iwsl-ww__feats">';
			foreach ( $tabs as $tab ) {
				$help = self::feature_help( (string) $tab['id'] );
				echo '<li><span class="iwsl-ww__feat-name">' . esc_html( (string) $tab['label'] ) . '</span>';
				if ( '' !== $help ) {
					echo '<span class="iwsl-ww__feat-help">' . esc_html( $help ) . '</span>';
				}
				echo '</li>';
			}
			echo '</ul>';
			echo '</section>';
		}

		// Final step — how to turn things on + links into every category page.
		echo '<section class="iwsl-ww__step" aria-label="' . esc_attr__( 'Next steps', 'infraweaver-connector' ) . '">';
		echo '<h3>' . esc_html__( 'That’s the tour', 'infraweaver-connector' ) . '</h3>';
		echo '<p>' . esc_html__( 'Every feature has its own page. Open a category, then flip a feature on with its switch — anything your plan includes turns on right away.', 'infraweaver-connector' ) . '</p>';
		echo '<div class="iwsl-ww__links">';
		foreach ( self::group_meta() as $label => $meta ) {
			$href = admin_url( 'admin.php?page=infraweaver-plus-' . $meta['slug'] );
			echo '<a class="button button-secondary" href="' . esc_url( $href ) . '"><span class="dashicons dashicons-' . esc_attr( $meta['icon'] ) . '" aria-hidden="true"></span>' . esc_html( (string) $label ) . '</a>';
		}
		echo '</div>';
		echo '</section>';

		echo '</div>'; // .iwsl-ww__steps

		echo '<div class="iwsl-ww__nav">';
		echo '<button type="button" class="button button-secondary" data-ww-back="1">' . esc_html__( 'Back', 'infraweaver-connector' ) . '</button>';
		echo '<button type="button" class="button button-primary" data-ww-next="1">' . esc_html__( 'Next', 'infraweaver-connector' ) . '</button>';
		echo '<button type="button" class="button button-primary" data-ww-done="1" hidden>' . esc_html__( 'Got it', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '</div>'; // .iwsl-ww__inner
		echo '</dialog>';

		self::render_welcome_wizard_script();
	}

	/** A friendly greeting using the current user's display name when available. */
	private static function welcome_greeting(): string {
		$who = '';
		if ( function_exists( 'wp_get_current_user' ) ) {
			$user = wp_get_current_user();
			if ( is_object( $user ) && ! empty( $user->display_name ) ) {
				$who = (string) $user->display_name;
			}
		}
		return '' !== $who
			/* translators: %s is the current user's display name. */
			? sprintf( __( 'Welcome, %s', 'infraweaver-connector' ), $who )
			: __( 'Welcome to InfraWeaver Plus', 'infraweaver-connector' );
	}

	/** Scoped styles for the first-run guide bar + <dialog>. Reuses the shell --iw-* tokens. */
	private static function render_welcome_wizard_styles(): void {
		echo "<style>\n";
		echo <<<'CSS'
.iwsl-shell .iwsl-welcome-bar{ display: flex; justify-content: flex-end; margin: 0 0 12px; }
.iwsl-shell .iwsl-ww{ width: min(600px, calc(100vw - 32px)); max-width: 600px; max-height: calc(100vh - 48px); padding: 0; color: var(--iw-ink); background: var(--iw-panel); border: 1px solid var(--iw-line-2); border-radius: 16px; box-shadow: 0 40px 90px -30px rgba(0,0,0,.85); }
.iwsl-shell .iwsl-ww::backdrop{ background: rgba(4,7,11,.62); backdrop-filter: blur(2px); }
.iwsl-shell .iwsl-ww__inner{ padding: 22px 24px 20px; }
.iwsl-shell .iwsl-ww__head{ display: flex; align-items: center; gap: 12px; }
.iwsl-shell .iwsl-ww__mark{ display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; color: var(--iw-signal-ink); background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal)); flex: 0 0 auto; }
.iwsl-shell .iwsl-ww__mark .dashicons{ font-size: 19px; width: 19px; height: 19px; }
.iwsl-shell .iwsl-ww__title{ margin: 0; font-size: 18px; }
.iwsl-shell .iwsl-ww__x{ margin-left: auto; padding: 2px 6px; background: none; border: 0; border-radius: 8px; color: var(--iw-faint); font-size: 24px; line-height: 1; cursor: pointer; }
.iwsl-shell .iwsl-ww__x:hover{ color: var(--iw-ink); background: color-mix(in oklch, white 8%, transparent); }
.iwsl-shell .iwsl-ww__progress{ margin: 6px 0 12px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--iw-faint); }
.iwsl-shell .iwsl-ww__steps{ min-height: 190px; max-height: 60vh; overflow-y: auto; }
.iwsl-shell .iwsl-ww__step{ display: none; }
.iwsl-shell .iwsl-ww__step.is-active{ display: block; }
@media (prefers-reduced-motion: no-preference){ .iwsl-shell .iwsl-ww__step.is-active{ animation: iwsl-rise .28s var(--iw-ease) both; } }
.iwsl-shell .iwsl-ww__step h3{ margin: 0 0 6px; font-size: 16px; text-transform: none; letter-spacing: 0; }
.iwsl-shell .iwsl-ww__step h3::before{ display: none; }
.iwsl-shell .iwsl-ww__lede{ font-size: 14px; color: var(--iw-muted); }
.iwsl-shell .iwsl-ww__cat{ display: flex; gap: 12px; align-items: flex-start; }
.iwsl-shell .iwsl-ww__cat-icon{ display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; background: var(--iw-panel-2); border: 1px solid var(--iw-line-2); flex: 0 0 auto; }
.iwsl-shell .iwsl-ww__cat-icon .dashicons{ font-size: 20px; width: 20px; height: 20px; color: var(--iw-signal-2); }
.iwsl-shell .iwsl-ww__cat h3{ margin: 0; }
.iwsl-shell .iwsl-ww__cat p{ margin: 2px 0 0; }
.iwsl-shell .iwsl-ww__feats{ list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.iwsl-shell .iwsl-ww__feats li{ display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border: 1px solid var(--iw-line); border-radius: 10px; background: var(--iw-panel-2); }
.iwsl-shell .iwsl-ww__feat-name{ font-size: 13px; font-weight: 600; color: var(--iw-ink); }
.iwsl-shell .iwsl-ww__feat-help{ font-size: 12.5px; color: var(--iw-muted); }
.iwsl-shell .iwsl-ww__links{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.iwsl-shell .iwsl-ww__nav{ display: flex; justify-content: space-between; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--iw-line); }
.iwsl-shell .iwsl-ww__nav [data-ww-back]{ margin-right: auto; }
CSS;
		echo "\n</style>\n";
	}

	/** The tiny scoped pager for the first-run guide dialog (auto-open once, Next/Back/Done, Esc/backdrop close). No external asset. */
	private static function render_welcome_wizard_script(): void {
		echo "<script>\n";
		echo <<<'JS'
(function(){
	var dlg = document.getElementById('iwsl-ww-dialog');
	if (!dlg) { return; }
	var steps = Array.prototype.slice.call(dlg.querySelectorAll('.iwsl-ww__step'));
	if (!steps.length) { return; }
	var nextBtn = dlg.querySelector('[data-ww-next]');
	var backBtn = dlg.querySelector('[data-ww-back]');
	var doneBtn = dlg.querySelector('[data-ww-done]');
	var prog = dlg.querySelector('.iwsl-ww__progress');
	var region = dlg.querySelector('.iwsl-ww__steps');
	var tpl = prog ? (prog.getAttribute('data-ww-tpl') || 'Step {n} of {t}') : '';
	var cur = 0;
	function render(){
		steps.forEach(function(s, i){ s.classList.toggle('is-active', i === cur); });
		var last = cur === steps.length - 1;
		if (backBtn) { backBtn.style.visibility = cur === 0 ? 'hidden' : 'visible'; }
		if (nextBtn) { nextBtn.hidden = last; }
		if (doneBtn) { doneBtn.hidden = !last; }
		if (prog) { prog.textContent = tpl.replace('{n}', String(cur + 1)).replace('{t}', String(steps.length)); }
		if (region) { region.scrollTop = 0; }
		if (cur !== 0) {
			var f = steps[cur].querySelector('a, button, input');
			if (f) { try { f.focus(); } catch (e) {} }
		}
	}
	function go(i){ cur = Math.max(0, Math.min(steps.length - 1, i)); render(); }
	function close(){ try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } }
	function open(){
		cur = 0;
		if (typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
		else { dlg.setAttribute('open', ''); }
		render();
	}
	Array.prototype.slice.call(document.querySelectorAll('[data-ww-open]')).forEach(function(b){
		b.addEventListener('click', function(e){ e.preventDefault(); open(); });
	});
	dlg.addEventListener('click', function(e){
		if (e.target.closest('[data-ww-next]')) { go(cur + 1); }
		else if (e.target.closest('[data-ww-back]')) { go(cur - 1); }
		else if (e.target.closest('[data-ww-done]') || e.target.closest('[data-ww-close]')) { close(); }
		else if (e.target === dlg) { close(); }
	});
	render();
	if (dlg.getAttribute('data-ww-auto') === '1') { open(); }
})();
JS;
		echo "\n</script>\n";
	}

	/**
	 * A category sub-page: the branded shell + a scoped tab rail of ONLY this
	 * group's feature tabs + those panels. Reuses the exact tab-nav / panel /
	 * feature-map / toast / locked-panel machinery — the tab JS treats a
	 * one-group tablist as a smaller tablist and needs no per-page change.
	 */
	private function render_group_page( string $group ): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'infraweaver-connector' ) );
		}
		$meta = self::group_meta();
		if ( ! isset( $meta[ $group ] ) ) {
			return;
		}
		$gate     = $this->plugin->entitlements()->evaluate( 'plus' );
		$unlocked = $this->unlocked_map();
		$tier     = self::infer_tier( $unlocked, ! empty( $gate['unlocked'] ) );
		$tabs     = self::group_tabs( $group );

		// Default the open tab to the first AVAILABLE (unlocked or always-on) tab so
		// the page never opens on a sealed placeholder when a usable one exists.
		$active_id = isset( $tabs[0] ) ? $tabs[0]['id'] : '';
		foreach ( $tabs as $tab ) {
			$tid = $tab['id'];
			if ( ! array_key_exists( $tid, $unlocked ) || ! empty( $unlocked[ $tid ] ) ) {
				$active_id = $tid;
				break;
			}
		}

		echo '<div class="wrap iwsl-shell" data-iwsl-scope="' . esc_attr( $meta[ $group ]['slug'] ) . '">';
		self::render_shell_styles();
		self::render_cards_styles();
		$this->render_group_hero( $group, $meta[ $group ], $tier, $gate );
		$this->render_toggle_toast();

		// A friendly "New here? Start with…" nudge that points a first-time owner at
		// the single most useful feature in this category before the full list.
		self::render_group_starthere( $group, $tabs );

		// One panel per area (no sub-tabs): a sticky jump-rail + every feature
		// stacked as a card. Each card carries a tier-aware enable/disable switch
		// and reveals its controls only when granted AND switched on.
		self::render_jump_rail( $tabs, $unlocked, $this->switches() );

		echo '<div class="iwsl-cards">';
		foreach ( $tabs as $tab ) {
			$this->render_feature_card( $tab, $unlocked );
		}
		echo '</div>'; // .iwsl-cards

		self::render_shell_script();
		echo '</div>'; // .wrap.iwsl-shell
	}

	/**
	 * The sticky in-page jump-rail: one anchor per feature card, each showing a
	 * live state marker — a green/grey dot (on/off) when granted, a lock glyph
	 * when the tier doesn't include it.
	 */
	private static function render_jump_rail( array $tabs, array $unlocked, IWSL_Feature_Switches $switches ): void {
		echo '<nav class="iwsl-jump" aria-label="' . esc_attr__( 'Jump to a feature', 'infraweaver-connector' ) . '">';
		foreach ( $tabs as $tab ) {
			$id      = (string) $tab['id'];
			$flag    = self::feature_flag_for( $id );
			$granted = null === $flag ? true : ! empty( $unlocked[ $id ] );
			$on      = null === $flag ? true : ( $granted && $switches->is_on( $flag ) );
			$state   = ! $granted ? 'locked' : ( $on ? 'on' : 'off' );
			echo '<a class="iwsl-jump__item iwsl-jump__item--' . esc_attr( $state ) . '" href="#iwsl-card-' . esc_attr( $id ) . '">';
			echo '<span class="dashicons dashicons-' . esc_attr( (string) $tab['icon'] ) . '" aria-hidden="true"></span>';
			echo '<span class="iwsl-jump__label">' . esc_html( (string) $tab['label'] ) . '</span>';
			if ( 'locked' === $state ) {
				echo '<span class="dashicons dashicons-lock iwsl-jump__lock" aria-hidden="true"></span>';
			} else {
				echo '<span class="iwsl-jump__dot iwsl-jump__dot--' . esc_attr( $state ) . '" aria-hidden="true"></span>';
			}
			echo '</a>';
		}
		echo '</nav>';
	}

	/**
	 * One feature card. Three states:
	 *   - locked  : the tier doesn't grant it → toggle is a disabled lock + upgrade note, no controls.
	 *   - off     : granted but switched off → an enable switch + "turn on to configure", no controls.
	 *   - on      : granted and switched on  → the enable switch + the feature's full section body.
	 * Ids with no tier gate (config) always render on with no switch.
	 */
	private function render_feature_card( array $tab, array $unlocked ): void {
		$id    = (string) $tab['id'];
		$label = (string) $tab['label'];
		$icon  = (string) $tab['icon'];
		$flag  = self::feature_flag_for( $id );

		$granted   = null === $flag ? true : ! empty( $unlocked[ $id ] );
		$switch_on = null === $flag ? true : $this->switches()->is_on( $flag );
		$state     = ! $granted ? 'locked' : ( $switch_on ? 'on' : 'off' );

		$state_label = array(
			'on'     => __( 'Active', 'infraweaver-connector' ),
			'off'    => __( 'Disabled', 'infraweaver-connector' ),
			'locked' => __( 'Locked', 'infraweaver-connector' ),
		);

		echo '<section class="iwsl-card iwsl-card--' . esc_attr( $state ) . '" id="iwsl-card-' . esc_attr( $id ) . '" tabindex="-1">';

		echo '<header class="iwsl-card__head">';
		echo '<span class="iwsl-card__mark" aria-hidden="true"><span class="dashicons dashicons-' . esc_attr( $icon ) . '"></span></span>';
		echo '<div class="iwsl-card__id">';
		echo '<div class="iwsl-card__titlerow">';
		echo '<h2 class="iwsl-card__title">' . esc_html( $label ) . '</h2>';
		$help = self::feature_help( $id );
		if ( '' !== $help ) {
			/* translators: 1: feature name, 2: plain-english explanation. */
			$help_label = sprintf( __( 'What is %1$s? %2$s', 'infraweaver-connector' ), $label, $help );
			echo '<span class="iwsl-help" tabindex="0" role="note" aria-label="' . esc_attr( $help_label ) . '">';
			echo '<span class="iwsl-help__q" aria-hidden="true">?</span>';
			echo '<span class="iwsl-help__tip" aria-hidden="true">' . esc_html( $help ) . '</span>';
			echo '</span>';
		}
		echo '</div>';
		echo '<span class="iwsl-card__state iwsl-card__state--' . esc_attr( $state ) . '">' . esc_html( $state_label[ $state ] ) . '</span>';
		echo '</div>';

		if ( null !== $flag ) {
			echo '<div class="iwsl-card__control">';
			if ( $granted ) {
				self::render_feature_switch( $flag, $label, $switch_on );
			} else {
				echo '<span class="iwsl-card__lock"><span class="dashicons dashicons-lock" aria-hidden="true"></span>' . esc_html__( 'Upgrade to unlock', 'infraweaver-connector' ) . '</span>';
			}
			echo '</div>';
		}
		echo '</header>';

		if ( 'on' === $state ) {
			echo '<div class="iwsl-card__body">';
			$this->render_panel_for( $id, $unlocked );
			echo '</div>';
		} elseif ( 'off' === $state ) {
			// A GUIDED card even when off: the same plain-English explainer (so the
			// owner can decide with confidence), a "what happens when you turn it on"
			// line, then a gentle pointer to the On switch above. The explainer is a
			// no-op for any id without copy, in which case the pointer stands alone.
			echo '<div class="iwsl-card__body">';
			self::render_feature_intro( $id, 'off' );
			echo '<p class="iwsl-card__hint"><span class="dashicons dashicons-arrow-up-alt2" aria-hidden="true"></span>' . esc_html__( 'Ready when you are — use the On switch above to turn it on.', 'infraweaver-connector' ) . '</p>';
			echo '</div>';
		} else {
			echo '<div class="iwsl-card__body">';
			self::render_feature_intro( $id, 'locked' );
			echo '<p class="iwsl-card__hint">' . esc_html__( 'Included in a higher plan. Upgrade this site from the InfraWeaver console to unlock it.', 'infraweaver-connector' ) . '</p>';
			echo '</div>';
		}

		echo '</section>';
	}

	/** The enable/disable switch itself: a real POST toggle (works without JS). */
	private static function render_feature_switch( string $flag, string $label, bool $on ): void {
		$next = $on ? '0' : '1';
		echo '<form class="iwsl-toggle" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( self::FEATURE_TOGGLE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::FEATURE_TOGGLE_ACTION ) . '">';
		echo '<input type="hidden" name="feature" value="' . esc_attr( $flag ) . '">';
		echo '<input type="hidden" name="enable" value="' . esc_attr( $next ) . '">';
		/* translators: %s: feature name. */
		$aria = sprintf( $on ? __( 'Disable %s', 'infraweaver-connector' ) : __( 'Enable %s', 'infraweaver-connector' ), $label );
		echo '<button type="submit" class="iwsl-switch' . ( $on ? ' is-on' : '' ) . '" role="switch" aria-checked="' . ( $on ? 'true' : 'false' ) . '" aria-label="' . esc_attr( $aria ) . '">';
		echo '<span class="iwsl-switch__track" aria-hidden="true"><span class="iwsl-switch__thumb"></span></span>';
		echo '<span class="iwsl-switch__text">' . ( $on ? esc_html__( 'On', 'infraweaver-connector' ) : esc_html__( 'Off', 'infraweaver-connector' ) ) . '</span>';
		echo '</button>';
		echo '</form>';
	}

	/** A one-shot toast after a switch flip (or a refusal), read from a per-user transient. */
	private function render_toggle_toast(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key = self::FEATURE_TOGGLE_RESULT . get_current_user_id();
		$r   = get_transient( $key );
		if ( ! is_array( $r ) ) {
			return;
		}
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		$ok      = ! empty( $r['ok'] );
		$feature = isset( $r['feature'] ) ? (string) $r['feature'] : '';
		if ( $ok ) {
			/* translators: 1: feature name, 2: on/off. */
			$msg = sprintf( __( '%1$s turned %2$s.', 'infraweaver-connector' ), $feature, ! empty( $r['on'] ) ? __( 'on', 'infraweaver-connector' ) : __( 'off', 'infraweaver-connector' ) );
		} elseif ( 'not-entitled' === ( $r['reason'] ?? '' ) ) {
			$msg = __( 'That feature is not included in this site’s plan — enable it from the InfraWeaver console first.', 'infraweaver-connector' );
		} else {
			$msg = __( 'Could not change that feature.', 'infraweaver-connector' );
		}
		echo '<div class="iwsl-toast iwsl-toast--' . ( $ok ? 'ok' : 'warn' ) . '" role="status">' . esc_html( $msg ) . '</div>';
	}

	/** Scoped styles for the consolidated card layout, jump-rail, switch + toast. Reuses the shell's --iw-* tokens. */
	private static function render_cards_styles(): void {
		echo '<style>
.iwsl-shell .iwsl-jump{ position: sticky; top: 46px; z-index: 20; display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 2px; margin: 6px 0 14px; background: color-mix(in oklch, var(--iw-panel) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--iw-line); }
.iwsl-shell .iwsl-jump__item{ display: inline-flex; align-items: center; gap: 7px; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--iw-line-2); background: var(--iw-panel-2); color: var(--iw-ink-2); text-decoration: none; font-size: 13px; line-height: 1; transition: color .15s, border-color .15s, background .15s; }
.iwsl-shell .iwsl-jump__item:hover{ color: var(--iw-ink); border-color: var(--iw-signal); }
.iwsl-shell .iwsl-jump__item .dashicons{ font-size: 16px; width: 16px; height: 16px; opacity: .85; }
.iwsl-shell .iwsl-jump__item--locked{ opacity: .6; }
.iwsl-shell .iwsl-jump__item--off .iwsl-jump__label{ opacity: .75; }
.iwsl-shell .iwsl-jump__dot{ width: 7px; height: 7px; border-radius: 50%; }
.iwsl-shell .iwsl-jump__dot--on{ background: var(--iw-good); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-good) 20%, transparent); }
.iwsl-shell .iwsl-jump__dot--off{ background: color-mix(in oklch, var(--iw-faint) 80%, transparent); }
.iwsl-shell .iwsl-jump__lock{ font-size: 13px !important; width: 13px !important; height: 13px !important; opacity: .7; }

.iwsl-shell .iwsl-cards{ display: flex; flex-direction: column; gap: 16px; }
.iwsl-shell .iwsl-card{ border: 1px solid var(--iw-line); border-radius: var(--iw-r-sm, 12px); background: var(--iw-panel); overflow: visible; scroll-margin-top: 96px; }
.iwsl-shell .iwsl-card__titlerow{ display: flex; align-items: center; gap: 7px; }
.iwsl-shell .iwsl-help{ position: relative; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; border-radius: 50%; border: 1px solid var(--iw-line-2); background: var(--iw-panel-2); color: var(--iw-ink-2); cursor: help; flex: 0 0 auto; }
.iwsl-shell .iwsl-help__q{ font-size: 11px; font-weight: 700; line-height: 1; }
.iwsl-shell .iwsl-help--field{ width: 15px; height: 15px; margin-left: 5px; vertical-align: middle; }
.iwsl-shell .iwsl-help--field .iwsl-help__q{ font-size: 10px; }
.iwsl-shell .iwsl-help:hover, .iwsl-shell .iwsl-help:focus-visible{ color: var(--iw-ink); border-color: var(--iw-signal); outline: none; }
.iwsl-shell .iwsl-help__tip{ position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%); width: max-content; max-width: 260px; padding: 9px 11px; border-radius: 8px; background: var(--iw-panel-2); border: 1px solid var(--iw-line-2); color: var(--iw-ink); font-size: 12.5px; font-weight: 400; line-height: 1.4; text-transform: none; letter-spacing: 0; box-shadow: 0 6px 20px rgba(0,0,0,.28); opacity: 0; visibility: hidden; transition: opacity .12s; z-index: 40; pointer-events: none; }
.iwsl-shell .iwsl-help__tip::before{ content: ""; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); border: 6px solid transparent; border-bottom-color: var(--iw-line-2); }
.iwsl-shell .iwsl-help:hover .iwsl-help__tip, .iwsl-shell .iwsl-help:focus-visible .iwsl-help__tip{ opacity: 1; visibility: visible; }
.iwsl-shell .iwsl-card--off{ opacity: .92; }
.iwsl-shell .iwsl-card--locked{ opacity: .7; }
.iwsl-shell .iwsl-card__head{ display: flex; align-items: center; gap: 13px; padding: 15px 18px; border-bottom: 1px solid transparent; }
.iwsl-shell .iwsl-card--on .iwsl-card__head{ border-bottom-color: var(--iw-line); }
.iwsl-shell .iwsl-card__mark{ display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; background: var(--iw-panel-2); border: 1px solid var(--iw-line-2); flex: 0 0 auto; }
.iwsl-shell .iwsl-card__mark .dashicons{ font-size: 20px; width: 20px; height: 20px; color: var(--iw-ink); }
.iwsl-shell .iwsl-card__id{ display: flex; flex-direction: column; gap: 3px; margin-right: auto; }
.iwsl-shell .iwsl-card__title{ margin: 0; font-size: 16px; line-height: 1.1; color: var(--iw-ink); }
.iwsl-shell .iwsl-card__state{ font-size: 11px; text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
.iwsl-shell .iwsl-card__state--on{ color: var(--iw-good); }
.iwsl-shell .iwsl-card__state--off{ color: var(--iw-faint); }
.iwsl-shell .iwsl-card__state--locked{ color: var(--iw-faint); }
.iwsl-shell .iwsl-card__control{ flex: 0 0 auto; }
.iwsl-shell .iwsl-card__lock{ display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--iw-faint); }
.iwsl-shell .iwsl-card__lock .dashicons{ font-size: 15px; width: 15px; height: 15px; }
.iwsl-shell .iwsl-card__body{ padding: 16px 18px 20px; }
.iwsl-shell .iwsl-card__body--muted{ color: var(--iw-ink-2); }
.iwsl-shell .iwsl-card__body--muted p{ margin: 4px 0; font-size: 13px; }

.iwsl-shell .iwsl-toggle{ margin: 0; }
.iwsl-shell .iwsl-switch{ display: inline-flex; align-items: center; gap: 9px; cursor: pointer; background: none; border: 0; padding: 4px; color: var(--iw-ink-2); font-size: 13px; }
.iwsl-shell .iwsl-switch__track{ position: relative; width: 40px; height: 22px; border-radius: 999px; background: color-mix(in oklch, var(--iw-faint) 55%, transparent); border: 1px solid var(--iw-line-2); transition: background .18s; flex: 0 0 auto; }
.iwsl-shell .iwsl-switch.is-on .iwsl-switch__track{ background: var(--iw-good); border-color: transparent; }
.iwsl-shell .iwsl-switch__thumb{ position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s; }
.iwsl-shell .iwsl-switch.is-on .iwsl-switch__thumb{ transform: translateX(18px); }
.iwsl-shell .iwsl-switch__text{ min-width: 22px; text-align: left; font-weight: 600; }
.iwsl-shell .iwsl-switch.is-on .iwsl-switch__text{ color: var(--iw-good); }
.iwsl-shell .iwsl-switch:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; border-radius: 6px; }

.iwsl-shell .iwsl-toast{ margin: 0 0 14px; padding: 12px 15px; border-radius: var(--iw-r-sm, 12px); border: 1px solid var(--iw-line-2); font-size: 13px; }
.iwsl-shell .iwsl-toast--ok{ background: color-mix(in oklch, var(--iw-good) 12%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-good) 40%, var(--iw-line-2)); color: var(--iw-ink); }
.iwsl-shell .iwsl-toast--warn{ background: color-mix(in oklch, var(--iw-bad, #d66) 12%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-bad, #d66) 40%, var(--iw-line-2)); color: var(--iw-ink); }

/* Primary one-click action row + progressive-disclosure "Advanced" block. */
.iwsl-shell .iwsl-primary{ display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 14px; }
.iwsl-shell .iwsl-primary__meta{ color: var(--iw-ink-2); font-size: 13px; margin-right: auto; }
.iwsl-shell .iwsl-primary .button-primary{ font-size: 14px; }
.iwsl-shell details.iwsl-adv{ margin-top: 12px; border-top: 1px solid var(--iw-line); padding-top: 4px; }
.iwsl-shell details.iwsl-adv > summary{ cursor: pointer; list-style: none; display: inline-flex; align-items: center; gap: 6px; padding: 9px 2px; font-size: 13px; font-weight: 600; color: var(--iw-ink-2); user-select: none; }
.iwsl-shell details.iwsl-adv > summary::-webkit-details-marker{ display: none; }
.iwsl-shell details.iwsl-adv > summary::before{ content: "\\203A"; display: inline-block; transition: transform .15s; font-size: 15px; }
.iwsl-shell details.iwsl-adv[open] > summary::before{ transform: rotate(90deg); }
.iwsl-shell details.iwsl-adv > summary:hover{ color: var(--iw-ink); }
.iwsl-shell details.iwsl-adv[open] > summary{ color: var(--iw-ink); }
.iwsl-shell details.iwsl-adv > .iwsl-adv__body{ padding: 6px 2px 4px; }
@media (max-width: 782px){
	.iwsl-shell .iwsl-jump{ top: 0; }
	/* Keep the feature title and its on/off toggle on ONE tidy row instead of
	   wrapping the toggle far below the name; the title shrinks/wraps in place. */
	.iwsl-shell .iwsl-card__head{ flex-wrap: nowrap; gap: 10px; padding: 13px 14px; }
	.iwsl-shell .iwsl-card__id{ min-width: 0; }
	.iwsl-shell .iwsl-card__title{ overflow-wrap: anywhere; }
	.iwsl-shell .iwsl-card__body{ padding: 14px 14px 16px; }
}

/* ── "Start here" helper line at the top of each category page ─────────── */
.iwsl-shell .iwsl-starthere{ display: flex; gap: 10px; align-items: center; margin: 0 0 14px; padding: 11px 15px; border-radius: var(--iw-r-sm, 12px); border: 1px solid color-mix(in oklch, var(--iw-signal) 24%, var(--iw-line-2)); background: color-mix(in oklch, var(--iw-signal) 7%, var(--iw-panel)); font-size: 13.5px; line-height: 1.5; color: var(--iw-muted); }
.iwsl-shell .iwsl-starthere .dashicons{ color: var(--iw-signal); flex: 0 0 auto; font-size: 18px; width: 18px; height: 18px; }
.iwsl-shell .iwsl-starthere a{ font-weight: 650; }

/* ── Per-feature "explainer" card at the top of every panel ───────────── */
.iwsl-shell .iwsl-intro{ display: flex; gap: 14px; align-items: flex-start; padding: 15px 17px; margin: 0 0 16px; border: 1px solid color-mix(in oklch, var(--iw-signal) 20%, var(--iw-line)); border-radius: var(--iw-r-sm, 12px); background: color-mix(in oklch, var(--iw-signal) 6%, var(--iw-panel-2)); }
.iwsl-shell .iwsl-intro__icon{ display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; flex: 0 0 auto; color: var(--iw-signal-ink); background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal)); }
.iwsl-shell .iwsl-intro__icon .dashicons{ font-size: 19px; width: 19px; height: 19px; }
.iwsl-shell .iwsl-intro__body{ flex: 1 1 auto; min-width: 0; }
.iwsl-shell .iwsl-intro__body > p{ margin: 0 0 8px; font-size: 13.5px; line-height: 1.5; color: var(--iw-muted); }
.iwsl-shell .iwsl-intro__what{ color: var(--iw-ink) !important; }
.iwsl-shell .iwsl-intro__lead{ display: block; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--iw-faint); margin-bottom: 2px; }
.iwsl-shell .iwsl-intro__lead--steps{ margin: 12px 0 4px; }
.iwsl-shell .iwsl-intro__steps{ margin: 4px 0 4px; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; list-style: decimal; }
.iwsl-shell .iwsl-intro__steps li{ font-size: 13px; line-height: 1.45; color: var(--iw-ink); }
.iwsl-shell .iwsl-intro__state{ display: flex; gap: 8px; align-items: flex-start; margin: 12px 0 0 !important; padding: 9px 11px; border-radius: 10px; font-size: 13px !important; line-height: 1.45; }
.iwsl-shell .iwsl-intro__state .dashicons{ flex: 0 0 auto; margin-top: 1px; font-size: 16px; width: 16px; height: 16px; }
.iwsl-shell .iwsl-intro__state strong{ font-weight: 700; }
.iwsl-shell .iwsl-intro__state--on{ background: color-mix(in oklch, var(--iw-good) 13%, transparent); border: 1px solid color-mix(in oklch, var(--iw-good) 34%, var(--iw-line)); color: var(--iw-ink) !important; }
.iwsl-shell .iwsl-intro__state--on .dashicons{ color: var(--iw-good); }
.iwsl-shell .iwsl-intro__state--off{ background: color-mix(in oklch, var(--iw-signal) 8%, transparent); border: 1px solid color-mix(in oklch, var(--iw-signal) 26%, var(--iw-line)); color: var(--iw-muted) !important; }
.iwsl-shell .iwsl-intro__state--off .dashicons{ color: var(--iw-signal); }
.iwsl-shell .iwsl-card__hint{ display: flex; gap: 7px; align-items: center; margin: 12px 0 0; font-size: 12.5px; color: var(--iw-faint); }
.iwsl-shell .iwsl-card__hint .dashicons{ font-size: 15px; width: 15px; height: 15px; flex: 0 0 auto; }
@media (max-width: 600px){
	.iwsl-shell .iwsl-intro{ flex-direction: column; gap: 11px; padding: 14px; }
	.iwsl-shell .iwsl-intro__icon{ width: 30px; height: 30px; }
}
</style>';
	}

	/** The category sub-page header: back-crumb, group identity, one compact connection pill + tier badge. */
	private function render_group_hero( string $group, array $meta, string $tier, array $gate ): void {
		// Category pages don't repeat the full Linked/Heartbeat/Plus gate table (that
		// lives on the landing). Here the posture collapses to ONE compact pill —
		// linked + fresh heartbeat = "Connected" — beside the plan tier badge.
		$connected = ! empty( $gate['linked'] ) && ! empty( $gate['heartbeat_fresh'] );
		$home      = admin_url( 'admin.php?page=infraweaver-plus' );

		echo '<header class="iwsl-hero iwsl-hero--group">';
		echo '<div class="iwsl-hero__glow" aria-hidden="true"></div>';
		echo '<div class="iwsl-hero__lead">';
		echo '<span class="iwsl-hero__mark" aria-hidden="true"><span class="dashicons dashicons-' . esc_attr( $meta['icon'] ) . '"></span></span>';
		echo '<div>';
		echo '<a class="iwsl-hero__crumb" href="' . esc_url( $home ) . '"><span class="dashicons dashicons-arrow-left-alt2" aria-hidden="true"></span>' . esc_html__( 'InfraWeaver Plus', 'infraweaver-connector' ) . '</a>';
		echo '<h1 class="iwsl-hero__title">' . esc_html( $group ) . '</h1>';
		echo '<p class="iwsl-hero__sub">' . esc_html( $meta['blurb'] ) . '</p>';
		echo '</div>';
		echo '</div>';

		echo '<div class="iwsl-hero__posture" role="group" aria-label="' . esc_attr__( 'Link posture', 'infraweaver-connector' ) . '">';
		self::render_tier_badge( $tier );
		$pill_cls = $connected ? 'is-ok' : 'is-off';
		echo '<span class="iwsl-chip ' . esc_attr( $pill_cls ) . '">';
		echo '<span class="iwsl-chip__dot" aria-hidden="true"></span>';
		echo esc_html( $connected ? __( 'Connected', 'infraweaver-connector' ) : __( 'Not connected', 'infraweaver-connector' ) );
		echo '<span class="screen-reader-text">: ' . ( $connected ? esc_html__( 'this site is linked with a fresh signed heartbeat', 'infraweaver-connector' ) : esc_html__( 'this site is not linked, or its heartbeat is stale — see the landing page for full detail', 'infraweaver-connector' ) ) . '</span>';
		echo '</span>';
		echo '</div>';
		echo '</header>';
	}

	/**
	 * A calm, uniform placeholder for a LOCKED feature's tab panel. The tab lock
	 * glyph already communicates the locked state and the tab cannot be opened, so
	 * this stays deliberately quiet — no loud per-feature "requires a plan" nag.
	 */
	private static function render_locked_panel( string $label ): void {
		echo '<div style="max-width:520px;margin:28px auto;padding:26px 24px;text-align:center;border:1px solid var(--iw-line);border-radius:14px;background:color-mix(in oklch, var(--iw-panel) 60%, transparent);">';
		echo '<span class="dashicons dashicons-lock" aria-hidden="true" style="font-size:26px;width:26px;height:26px;opacity:0.6;"></span>';
		echo '<p style="margin:10px 0 4px;font-size:15px;"><strong>' . esc_html( $label ) . '</strong> ' . esc_html__( 'is included in a higher plan.', 'infraweaver-connector' ) . '</p>';
		echo '<p class="description" style="margin:0;">' . esc_html__( 'Upgrade this site from the InfraWeaver console to unlock it.', 'infraweaver-connector' ) . '</p>';
		echo '</div>';
	}

	/**
	 * The tabs, in display order, clustered into labeled category groups so the
	 * ~20-tab rail stays legible. `group` drives the small non-interactive rail
	 * separators (Overview + Roadmap carry none → they stay pinned, first and
	 * last). Shared by the nav and the per-tab status dots.
	 */
	private static function tab_defs(): array {
		return array(
			array( 'id' => 'overview', 'label' => 'Overview', 'icon' => 'shield' ),

			// Performance
			array( 'id' => 'speed', 'label' => 'Speed', 'icon' => 'superhero', 'group' => 'Performance' ),
			array( 'id' => 'cache', 'label' => 'Cache', 'icon' => 'performance', 'group' => 'Performance' ),
			array( 'id' => 'cdn', 'label' => 'CDN', 'icon' => 'cloud', 'group' => 'Performance' ),
			array( 'id' => 'lazy-load', 'label' => 'Lazy Load', 'icon' => 'images-alt2', 'group' => 'Performance' ),
			array( 'id' => 'perf-audit', 'label' => 'Load Time', 'icon' => 'dashboard', 'group' => 'Performance' ),
			array( 'id' => 'response-scan', 'label' => 'Response Time', 'icon' => 'chart-line', 'group' => 'Performance' ),

			// Media
			array( 'id' => 'images', 'label' => 'Images', 'icon' => 'format-image', 'group' => 'Media' ),
			array( 'id' => 'auto-convert', 'label' => 'Auto-Convert', 'icon' => 'update', 'group' => 'Media' ),
			array( 'id' => 'svg', 'label' => 'SVG', 'icon' => 'media-code', 'group' => 'Media' ),
			array( 'id' => 'media-protect', 'label' => 'Media Protection', 'icon' => 'lock', 'group' => 'Media' ),

			// SEO & Content
			array( 'id' => 'seo', 'label' => 'SEO', 'icon' => 'chart-area', 'group' => 'SEO & Content' ),
			array( 'id' => 'seo-audit', 'label' => 'SEO Audit', 'icon' => 'search', 'group' => 'SEO & Content' ),
			array( 'id' => 'duplicate', 'label' => 'Duplicate', 'icon' => 'admin-page', 'group' => 'SEO & Content' ),
			array( 'id' => 'links', 'label' => 'Links', 'icon' => 'admin-links', 'group' => 'SEO & Content' ),
			array( 'id' => 'redirects', 'label' => 'Redirects', 'icon' => 'randomize', 'group' => 'SEO & Content' ),

			// Analytics
			array( 'id' => 'statistics', 'label' => 'Statistics', 'icon' => 'chart-bar', 'group' => 'Analytics' ),
			array( 'id' => 'activity-log', 'label' => 'Activity Log', 'icon' => 'list-view', 'group' => 'Analytics' ),

			// Privacy & Site
			array( 'id' => 'consent', 'label' => 'Cookie Consent', 'icon' => 'privacy', 'group' => 'Privacy & Site' ),
			array( 'id' => 'maintenance', 'label' => 'Maintenance', 'icon' => 'hammer', 'group' => 'Privacy & Site' ),
			array( 'id' => 'whitelabel', 'label' => 'White-Label', 'icon' => 'art', 'group' => 'Privacy & Site' ),

			// System
			array( 'id' => 'database', 'label' => 'Database', 'icon' => 'database', 'group' => 'System' ),
			array( 'id' => 'scheduled-cleanup', 'label' => 'Scheduled Cleanup', 'icon' => 'clock', 'group' => 'System' ),
			array( 'id' => 'email', 'label' => 'Email', 'icon' => 'email-alt', 'group' => 'System' ),
			array( 'id' => 'config', 'label' => 'Config', 'icon' => 'admin-generic', 'group' => 'System' ),

			array( 'id' => 'roadmap', 'label' => 'Roadmap', 'icon' => 'flag' ),
		);
	}

	/** The branded header: identity, connector version, and three live posture chips. */
	private function render_hero( array $gate ): void {
		$chips = array(
			array( 'label' => 'Linked', 'ok' => ! empty( $gate['linked'] ) ),
			array( 'label' => 'Heartbeat', 'ok' => ! empty( $gate['heartbeat_fresh'] ) ),
			array( 'label' => 'Plus', 'ok' => ! empty( $gate['plus'] ) ),
		);
		$version = defined( 'IWSL_CONNECTOR_VERSION' ) ? IWSL_CONNECTOR_VERSION : '';

		echo '<header class="iwsl-hero">';
		echo '<div class="iwsl-hero__glow" aria-hidden="true"></div>';
		echo '<div class="iwsl-hero__lead">';
		echo '<span class="iwsl-hero__mark" aria-hidden="true"><span class="dashicons dashicons-shield"></span></span>';
		echo '<div>';
		echo '<h1 class="iwsl-hero__title">InfraWeaver <span>Plus</span></h1>';
		echo '<p class="iwsl-hero__sub">' . esc_html__( 'Signed, console-granted power features for this site.', 'infraweaver-connector' );
		if ( '' !== $version ) {
			echo ' <span class="iwsl-hero__ver">Connector v' . esc_html( $version ) . '</span>';
		}
		echo '</p>';
		echo '</div>';
		echo '</div>';

		echo '<div class="iwsl-hero__posture" role="group" aria-label="' . esc_attr__( 'Link posture', 'infraweaver-connector' ) . '">';
		foreach ( $chips as $chip ) {
			$cls = $chip['ok'] ? 'is-ok' : 'is-off';
			echo '<span class="iwsl-chip ' . esc_attr( $cls ) . '">';
			echo '<span class="iwsl-chip__dot" aria-hidden="true"></span>';
			echo esc_html( $chip['label'] );
			echo '<span class="screen-reader-text">: ' . ( $chip['ok'] ? esc_html__( 'active', 'infraweaver-connector' ) : esc_html__( 'inactive', 'infraweaver-connector' ) ) . '</span>';
			echo '</span>';
		}
		echo '</div>';
		echo '</header>';
	}

	/**
	 * The horizontal tab rail. Each feature tab carries a live posture marker: a
	 * green dot when the feature is granted, or a LOCK glyph when it is not in the
	 * site's plan. A locked tab is marked `aria-disabled` + `data-locked` so the
	 * shell script refuses to open it (click / keyboard / deep-link all bounce) —
	 * the panel behind it stays sealed instead of showing an in-panel notice.
	 */
	private static function render_tab_nav( array $tabs, array $unlocked, string $active_id, bool $show_groups = true ): void {
		echo '<nav class="iwsl-tabnav" role="tablist" aria-label="' . esc_attr__( 'InfraWeaver Plus sections', 'infraweaver-connector' ) . '">';
		$last_group = '';
		foreach ( $tabs as $tab ) {
			$id        = $tab['id'];
			$is_active = ( $id === $active_id );

			// Cluster boundary: a small uppercase label that is NOT a tab. It is
			// role="presentation" + aria-hidden and carries no data-tab, so the
			// shell script's `.iwsl-tab` queries never see it — click, arrow-key,
			// Home/End, hash and restore all skip right over it. Suppressed on a
			// single-group sub-page (the header already names the group).
			$group = isset( $tab['group'] ) ? (string) $tab['group'] : '';
			if ( $show_groups && '' !== $group && $group !== $last_group ) {
				echo '<span class="iwsl-tabnav__group" role="presentation" aria-hidden="true">' . esc_html( $group ) . '</span>';
			}
			$last_group = $group;
			$state    = ( 'overview' === $id || ! array_key_exists( $id, $unlocked ) ) ? 'core' : ( ! empty( $unlocked[ $id ] ) ? 'on' : 'off' );
			$locked   = 'off' === $state;
			$classes  = 'iwsl-tab' . ( $is_active ? ' is-active' : '' ) . ( $locked ? ' iwsl-tab--locked' : '' );
			echo '<button type="button" class="' . esc_attr( $classes ) . '"'
				. ' id="iwsl-tabbtn-' . esc_attr( $id ) . '"'
				. ' role="tab" aria-controls="iwsl-tab-' . esc_attr( $id ) . '"'
				. ' aria-selected="' . ( $is_active ? 'true' : 'false' ) . '"'
				. ( $locked ? ' aria-disabled="true" data-locked="1"' : '' )
				. ' tabindex="' . ( $is_active ? '0' : '-1' ) . '"'
				. ' data-tab="' . esc_attr( $id ) . '">';
			echo '<span class="dashicons dashicons-' . esc_attr( $tab['icon'] ) . '" aria-hidden="true"></span>';
			echo '<span class="iwsl-tab__label">' . esc_html( $tab['label'] ) . '</span>';
			if ( $locked ) {
				echo '<span class="dashicons dashicons-lock iwsl-tab__lock" aria-hidden="true"></span>';
				echo '<span class="screen-reader-text"> ' . esc_html__( '(locked — not included in this plan)', 'infraweaver-connector' ) . '</span>';
			} elseif ( 'core' !== $state ) {
				echo '<span class="iwsl-tab__status iwsl-tab__status--' . esc_attr( $state ) . '" aria-hidden="true"></span>';
			}
			echo '</button>';
		}
		echo '</nav>';
	}

	/**
	 * The scoped design system for the whole page. Everything is namespaced
	 * under `.iwsl-shell` so it restyles the sections' native markup
	 * (.widefat, .form-table, .button*, .notice*, inputs) without leaking into
	 * the rest of wp-admin. Ships inline — no external asset, no CDN, no build.
	 */
	private static function render_shell_styles(): void {
		echo "<style id='iwsl-plus-css'>\n";
		echo <<<'CSS'
#wpcontent .iwsl-shell{
	--iw-bg: oklch(0.205 0.021 264);
	--iw-panel: oklch(0.248 0.023 264);
	--iw-panel-2: oklch(0.288 0.025 264);
	--iw-field: oklch(0.262 0.021 264);
	--iw-line: color-mix(in oklch, white 11%, transparent);
	--iw-line-2: color-mix(in oklch, white 20%, transparent);
	--iw-ink: oklch(0.965 0.004 264);
	--iw-muted: oklch(0.79 0.014 264);
	--iw-faint: oklch(0.66 0.015 264);
	--iw-signal: oklch(0.83 0.128 196);
	--iw-signal-2: oklch(0.9 0.09 196);
	--iw-signal-ink: oklch(0.24 0.03 220);
	--iw-violet: oklch(0.72 0.15 300);
	--iw-warn: oklch(0.84 0.13 85);
	--iw-bad: oklch(0.74 0.16 25);
	--iw-good: oklch(0.82 0.15 156);
	--iw-r: 16px;
	--iw-r-sm: 10px;
	--iw-ease: cubic-bezier(0.22, 1, 0.36, 1);
	--iw-z-rail: 20;
	--iw-z-toast: 60;
	margin: 0;
	max-width: none;
	width: 100%;
	min-height: calc(100vh - 32px);
	display: flex;
	flex-direction: column;
	color: var(--iw-ink);
	background: var(--iw-bg);
	border: 0;
	border-radius: 0;
	overflow: clip;
	box-shadow: none;
	color-scheme: dark;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", sans-serif;
	-webkit-font-smoothing: antialiased;
}
/* Full-bleed: eat the wp-admin content padding + drop the footer + the sample
   "Hello Dolly" lyric so the dark surface reaches every edge. Every rule here is
   safe globally because this whole sheet is printed ONLY on the Plus admin page. */
#wpcontent{ padding-left: 0 !important; }
#wpbody-content{ padding-bottom: 0 !important; }
#wpfooter{ display: none !important; }
#dolly{ display: none !important; }

#wpcontent .iwsl-shell *,
#wpcontent .iwsl-shell *::before,
#wpcontent .iwsl-shell *::after{ box-sizing: border-box; }
.iwsl-shell a{ color: var(--iw-signal-2); }
.iwsl-shell strong{ color: var(--iw-ink); font-weight: 650; }

/* ── Hero ─────────────────────────────────────────────────────────────── */
.iwsl-hero{
	position: relative;
	display: flex; flex-wrap: wrap; gap: 20px;
	align-items: center; justify-content: space-between;
	padding: 30px 32px;
	background:
		radial-gradient(120% 140% at 12% -10%, color-mix(in oklch, var(--iw-violet) 26%, transparent), transparent 55%),
		radial-gradient(120% 160% at 108% 130%, color-mix(in oklch, var(--iw-signal) 20%, transparent), transparent 52%),
		var(--iw-panel);
	border-bottom: 1px solid var(--iw-line);
	overflow: clip;
}
.iwsl-hero__glow{
	position: absolute; inset: auto -10% -60% 40%; height: 200px;
	background: radial-gradient(closest-side, color-mix(in oklch, var(--iw-signal) 34%, transparent), transparent);
	filter: blur(30px); opacity: 0.7; pointer-events: none;
}
.iwsl-hero__lead{ display: flex; align-items: center; gap: 18px; position: relative; z-index: 1; }
.iwsl-hero__mark{
	display: grid; place-items: center; width: 52px; height: 52px; flex: none;
	border-radius: 14px; color: var(--iw-signal-ink);
	background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal));
	box-shadow: 0 8px 22px -8px color-mix(in oklch, var(--iw-signal) 70%, transparent), 0 0 0 1px color-mix(in oklch, white 22%, transparent) inset;
}
.iwsl-hero__mark .dashicons{ font-size: 30px; width: 30px; height: 30px; }
.iwsl-hero__title{
	margin: 0; padding: 0; font-size: clamp(1.6rem, 1.1rem + 1.4vw, 2.1rem);
	font-weight: 750; letter-spacing: -0.02em; line-height: 1.05; color: var(--iw-ink);
}
.iwsl-hero__title span{ color: var(--iw-signal-2); font-weight: 750; }
.iwsl-hero__sub{ margin: 6px 0 0; color: var(--iw-muted); font-size: 13.5px; }
.iwsl-hero__ver{
	display: inline-block; margin-left: 4px; padding: 2px 8px; border-radius: 999px;
	font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em; color: var(--iw-signal-2);
	background: color-mix(in oklch, var(--iw-signal) 15%, transparent);
	border: 1px solid color-mix(in oklch, var(--iw-signal) 30%, transparent);
}
.iwsl-hero__posture{ position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; }
.iwsl-chip{
	display: inline-flex; align-items: center; gap: 8px;
	padding: 7px 13px 7px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
	border: 1px solid var(--iw-line-2); background: color-mix(in oklch, black 14%, transparent);
	color: var(--iw-muted);
}
.iwsl-chip__dot{ width: 8px; height: 8px; border-radius: 50%; background: var(--iw-faint); flex: none; }
.iwsl-chip.is-ok{ color: var(--iw-ink); border-color: color-mix(in oklch, var(--iw-good) 40%, transparent); }
.iwsl-chip.is-ok .iwsl-chip__dot{
	background: var(--iw-good);
	box-shadow: 0 0 0 4px color-mix(in oklch, var(--iw-good) 22%, transparent);
	animation: iwsl-pulse 2.4s var(--iw-ease) infinite;
}
.iwsl-chip.is-off{ opacity: 0.72; }
.iwsl-chip.is-off .iwsl-chip__dot{ background: var(--iw-bad); }

/* ── Tab rail ─────────────────────────────────────────────────────────── */
.iwsl-tabnav{
	position: sticky; top: 32px; z-index: var(--iw-z-rail);
	display: flex; gap: 4px; padding: 8px; overflow-x: auto; scrollbar-width: none;
	background: color-mix(in oklch, var(--iw-bg) 82%, transparent);
	backdrop-filter: blur(10px);
	border-bottom: 1px solid var(--iw-line);
	scroll-behavior: smooth;
	/* Soft edge fades signal "more tabs this way" as the rail scrolls — critical
	   once the rail holds ~20 tabs. Fades never widen the page; the rail scrolls
	   within itself (overflow-x:auto above, page-level overflow clipped by shell). */
	-webkit-mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
	mask-image: linear-gradient(90deg, transparent 0, #000 22px, #000 calc(100% - 22px), transparent 100%);
}
.iwsl-tabnav::-webkit-scrollbar{ display: none; }
/* No WordPress admin bar on the page → nothing to offset under; pin the rail to
   the very top so no empty band ever appears above it. */
body:not(.admin-bar) .iwsl-tabnav{ top: 0; }
.iwsl-tab{
	position: relative; display: inline-flex; align-items: center; gap: 8px; flex: none;
	padding: 10px 15px; border: 0; border-radius: var(--iw-r-sm); cursor: pointer;
	background: transparent; color: var(--iw-muted); font-size: 13.5px; font-weight: 600;
	font-family: inherit; white-space: nowrap;
	transition: color .18s var(--iw-ease), background .18s var(--iw-ease);
}
.iwsl-tab .dashicons{ font-size: 18px; width: 18px; height: 18px; opacity: 0.85; }
.iwsl-tab:hover{ color: var(--iw-ink); background: color-mix(in oklch, white 5%, transparent); }
.iwsl-tab.is-active{ color: var(--iw-ink); background: var(--iw-panel-2); box-shadow: 0 1px 0 var(--iw-line-2) inset; }
.iwsl-tab.is-active::after{
	content: ""; position: absolute; left: 14px; right: 14px; bottom: -8px; height: 2px;
	border-radius: 2px; background: var(--iw-signal);
	box-shadow: 0 0 10px color-mix(in oklch, var(--iw-signal) 70%, transparent);
}
.iwsl-tab:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; }
.iwsl-tab__status{ width: 7px; height: 7px; border-radius: 50%; margin-left: 1px; }
.iwsl-tab__status--on{ background: var(--iw-good); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-good) 20%, transparent); }
.iwsl-tab__status--off{ background: color-mix(in oklch, var(--iw-bad) 75%, var(--iw-faint)); }
/* Locked tab: dimmed, not-allowed, sealed. The lock glyph replaces the dot. */
.iwsl-tab--locked{ color: var(--iw-faint); cursor: not-allowed; }
.iwsl-tab--locked .dashicons{ opacity: 0.55; }
.iwsl-tab--locked:hover{ color: var(--iw-faint); background: transparent; }
.iwsl-tab--locked .iwsl-tab__label{ opacity: 0.85; }
.iwsl-tab__lock{ font-size: 14px !important; width: 14px !important; height: 14px !important; margin-left: 1px; opacity: 0.8 !important; }
/* Cluster separators: a faint full-height rule + micro uppercase label that
   turns the ~20-tab rail into legible groups. Presentational only — never a
   .iwsl-tab, never focusable, never a click/arrow-key target. The leading 1px
   rule is a divider (not a colored side-stripe), so clusters read as intentional
   without competing with the active-tab underline. */
.iwsl-tabnav__group{
	display: inline-flex; align-items: center; flex: none; align-self: stretch;
	margin-left: 7px; padding: 0 3px 0 14px;
	font-size: 10px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
	line-height: 1; color: var(--iw-faint); white-space: nowrap;
	border-left: 1px solid var(--iw-line);
	user-select: none; pointer-events: none;
}
.iwsl-tabnav__group:first-of-type{ margin-left: 2px; }

/* ── Panels ───────────────────────────────────────────────────────────── */
.iwsl-panels{ padding: 26px 32px 34px; flex: 1 1 auto; }
/* Result cards, tables and forms carry readable-width inline caps (640/720px)
   that stranded the right half of the panel empty on the full-bleed shell.
   Let them breathe up to a comfortable column so nothing "stops at the middle".
   (Inputs keep their own natural width via .regular-text max-width:100%.) */
.iwsl-tabpanel [style*="max-width:640px"],
.iwsl-tabpanel [style*="max-width: 640px"],
.iwsl-tabpanel [style*="max-width:720px"],
.iwsl-tabpanel [style*="max-width: 720px"]{ max-width: 1280px !important; }
.iwsl-tabpanel[hidden]{ display: none; }
.iwsl-tabpanel:focus{ outline: none; }
.iwsl-tabpanel > h2:first-child,
.iwsl-tabpanel > .iwsl-lede + h2{ margin-top: 0; }
.iwsl-lede{ max-width: 68ch; color: var(--iw-muted); font-size: 14px; line-height: 1.6; margin: 0 0 20px; }

/* Section chrome emitted by the renderers */
.iwsl-shell h2{ font-size: 19px; font-weight: 700; letter-spacing: -0.01em; color: var(--iw-ink); margin: 4px 0 14px; }
.iwsl-shell h3{ font-size: 14px; font-weight: 650; color: var(--iw-ink); margin: 26px 0 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.iwsl-shell h3::before{ content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 9px; border-radius: 2px; background: var(--iw-signal); transform: translateY(-1px); }
.iwsl-shell p{ color: var(--iw-muted); font-size: 13.5px; line-height: 1.6; }
.iwsl-shell hr{ display: none; }
.iwsl-shell .screen-reader-text{ position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

/* Tables — data (.widefat). Laid out as REAL tables that FILL their panel
   (width:100%) up to their inline cap (raised to 1280px above), so a preview or
   summary reads as intentional. A `display:block` table looks like it fills but
   its row-groups form an anonymous shrink-to-fit table that never stretches to
   the block — stranding the panel's right half (the "half-width" bug). Real
   table layout + wrapping cells (overflow-wrap below) means a table can never
   exceed its column, and the shell clips at the page edge, so no width from
   320px to ultrawide ever pushes the page sideways. `overflow` is a no-op on a
   table box, so the rounded corners are clipped per-cell instead. */
.iwsl-shell table.widefat{
	display: table; width: 100%; max-width: 100%; min-width: 0; table-layout: auto;
	background: var(--iw-panel); border: 1px solid var(--iw-line); border-radius: var(--iw-r);
	border-collapse: separate; border-spacing: 0; margin-top: 14px;
	box-shadow: 0 14px 36px -26px rgba(0,0,0,0.95);
}
/* Round the corner cells so the header fill and the last row honour the table's
   radius (a table box cannot clip its own overflow to round them). */
.iwsl-shell table.widefat thead th:first-child{ border-top-left-radius: var(--iw-r); }
.iwsl-shell table.widefat thead th:last-child{ border-top-right-radius: var(--iw-r); }
.iwsl-shell table.widefat tbody tr:last-child > :first-child{ border-bottom-left-radius: var(--iw-r); }
.iwsl-shell table.widefat tbody tr:last-child > :last-child{ border-bottom-right-radius: var(--iw-r); }
.iwsl-shell table.widefat thead th{
	background: color-mix(in oklch, var(--iw-panel-2) 70%, transparent); color: var(--iw-faint);
	font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
	padding: 11px 16px; border: 0; border-bottom: 1px solid var(--iw-line-2);
}
.iwsl-shell table.widefat td,
.iwsl-shell table.widefat tbody th{
	padding: 12px 16px; border: 0; border-top: 1px solid var(--iw-line);
	color: var(--iw-ink); font-size: 13.5px; background: transparent;
	overflow-wrap: anywhere;
}
.iwsl-shell table.widefat tbody th{ color: var(--iw-muted); font-weight: 600; }
.iwsl-shell table.widefat.striped > tbody > :nth-child(odd){ background: color-mix(in oklch, white 2.5%, transparent); }
.iwsl-shell table.widefat tbody tr:hover td,
.iwsl-shell table.widefat tbody tr:hover th{ background: color-mix(in oklch, var(--iw-signal) 7%, transparent); }
.iwsl-shell td span[style*="1a7f37"]{ color: var(--iw-good) !important; font-weight: 650 !important; }
.iwsl-shell td span[style*="b3261e"]{ color: var(--iw-bad) !important; font-weight: 650 !important; }

/* Tables — forms (.form-table) */
.iwsl-shell table.form-table{ margin-top: 8px; max-width: 640px; }
.iwsl-shell .form-table th{ color: var(--iw-muted); font-weight: 600; font-size: 13px; padding: 14px 16px 14px 0; width: 190px; vertical-align: top; }
.iwsl-shell .form-table td{ padding: 10px 0; }
.iwsl-shell .form-table td p.description,
.iwsl-shell .form-table td .description{ color: var(--iw-faint); font-size: 12.5px; }

/* Inputs */
.iwsl-shell input[type="text"],
.iwsl-shell input[type="number"],
.iwsl-shell input[type="password"],
.iwsl-shell input[type="url"],
.iwsl-shell input[type="email"],
.iwsl-shell select,
.iwsl-shell textarea{
	background: var(--iw-field); color: var(--iw-ink);
	border: 1px solid var(--iw-line-2); border-radius: var(--iw-r-sm);
	padding: 9px 12px; font-size: 13.5px; line-height: 1.4; min-height: 40px; box-shadow: none;
	transition: border-color .15s var(--iw-ease), box-shadow .15s var(--iw-ease);
}
.iwsl-shell textarea{ min-height: 72px; }
.iwsl-shell select{ padding-right: 30px; color-scheme: dark; }
.iwsl-shell select option,
.iwsl-shell select optgroup{ background: var(--iw-panel-2); color: var(--iw-ink); }
.iwsl-shell input::placeholder,
.iwsl-shell textarea::placeholder{ color: var(--iw-faint); }
.iwsl-shell input:focus,
.iwsl-shell select:focus,
.iwsl-shell textarea:focus{
	border-color: var(--iw-signal); outline: none;
	box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-signal) 26%, transparent);
}
.iwsl-shell label{ color: var(--iw-muted); font-size: 13px; }

/* Buttons */
.iwsl-shell .button,
.iwsl-shell .button-primary,
.iwsl-shell .button-secondary{
	display: inline-flex; align-items: center; gap: 7px; height: auto; min-height: 40px;
	padding: 9px 17px; border-radius: var(--iw-r-sm); font-size: 13.5px; font-weight: 600;
	line-height: 1.2; border: 1px solid var(--iw-line-2); background: var(--iw-panel-2);
	color: var(--iw-ink); text-shadow: none; box-shadow: none; cursor: pointer;
	transition: transform .12s var(--iw-ease), background .16s var(--iw-ease), border-color .16s var(--iw-ease), box-shadow .16s var(--iw-ease);
}
.iwsl-shell .button:hover{ background: color-mix(in oklch, white 9%, var(--iw-panel-2)); border-color: var(--iw-line-2); color: var(--iw-ink); transform: translateY(-1px); }
.iwsl-shell .button-primary{
	background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal));
	color: var(--iw-signal-ink); border-color: transparent;
	box-shadow: 0 8px 20px -10px color-mix(in oklch, var(--iw-signal) 80%, transparent);
}
.iwsl-shell .button-primary:hover{ color: var(--iw-signal-ink); transform: translateY(-1px); box-shadow: 0 12px 26px -10px color-mix(in oklch, var(--iw-signal) 90%, transparent); filter: brightness(1.04); }
.iwsl-shell .button:active,
.iwsl-shell .button-primary:active{ transform: translateY(0); }
.iwsl-shell .button:focus-visible,
.iwsl-shell .button-primary:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; box-shadow: none; }
.iwsl-shell .button-link-delete{
	background: transparent; border-color: transparent; color: var(--iw-bad); min-height: 0; padding: 4px 8px; box-shadow: none;
}
.iwsl-shell .button-link-delete:hover{ background: color-mix(in oklch, var(--iw-bad) 16%, transparent); color: var(--iw-bad); transform: none; }
.iwsl-shell .button.is-busy{ pointer-events: none; opacity: 0.75; }
.iwsl-shell .button.is-busy::after{
	content: ""; width: 14px; height: 14px; border-radius: 50%; margin-left: 2px;
	border: 2px solid color-mix(in oklch, currentColor 35%, transparent); border-top-color: currentColor;
	animation: iwsl-spin .7s linear infinite;
}

/* Notices */
.iwsl-shell .notice{
	border: 1px solid var(--iw-line-2); border-left-width: 1px; border-radius: var(--iw-r-sm);
	background: var(--iw-panel); color: var(--iw-ink);
	box-shadow: 0 10px 28px -22px rgba(0,0,0,0.9);
}
.iwsl-shell .notice p{ color: var(--iw-ink); }
.iwsl-shell .notice ul{ color: var(--iw-muted); }
.iwsl-shell .notice-success{ background: color-mix(in oklch, var(--iw-good) 12%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-good) 45%, transparent); }
.iwsl-shell .notice-warning{ background: color-mix(in oklch, var(--iw-warn) 11%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-warn) 42%, transparent); }
.iwsl-shell .notice-error{ background: color-mix(in oklch, var(--iw-bad) 12%, var(--iw-panel)); border-color: color-mix(in oklch, var(--iw-bad) 45%, transparent); }
.iwsl-shell .notice-warning ul{ margin-top: 6px; }

/* Checkboxes / labels inline */
.iwsl-shell input[type="checkbox"]{ accent-color: var(--iw-signal); width: 17px; height: 17px; }

/* ── Overflow containment & long-content (no element pushes the page sideways) ── */
/* Media and form controls never exceed their column, even .regular-text (25em)
   on a 320px screen or an oversized embedded image. */
.iwsl-shell img,
.iwsl-shell svg,
.iwsl-shell canvas,
.iwsl-shell video{ max-width: 100%; height: auto; }
.iwsl-shell input,
.iwsl-shell select,
.iwsl-shell textarea{ max-width: 100%; }
/* Long unbroken tokens (URLs, hashes, paths) wrap instead of stretching a row. */
.iwsl-shell p,
.iwsl-shell li,
.iwsl-shell dd,
.iwsl-shell .notice p,
.iwsl-shell .iwsl-lede{ overflow-wrap: anywhere; }
/* Monospace: legible on dark, and always breakable so a long hook name / URL in
   a <code> chip can never force horizontal scroll of the page. */
.iwsl-shell code,
.iwsl-shell kbd,
.iwsl-shell samp,
.iwsl-shell pre{
	font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
	font-size: 12.5px; overflow-wrap: anywhere; word-break: break-word;
}
.iwsl-shell code,
.iwsl-shell kbd,
.iwsl-shell samp{
	padding: 1.5px 6px; border-radius: 6px;
	background: color-mix(in oklch, var(--iw-signal) 9%, var(--iw-field));
	border: 1px solid var(--iw-line); color: var(--iw-signal-2);
}
.iwsl-shell pre{
	max-width: 100%; overflow-x: auto; margin: 12px 0; padding: 12px 14px;
	background: var(--iw-field); border: 1px solid var(--iw-line);
	border-radius: var(--iw-r-sm); color: var(--iw-ink); line-height: 1.5;
}
/* Reusable horizontal-scroll region for any future wide block (wide tables,
   diagrams, code): contained, themed, never widening the page. */
.iwsl-shell .iwsl-scroll-x{ max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }

/* Themed thin scrollbars for every in-shell scroll region. */
.iwsl-shell table.widefat,
.iwsl-shell pre,
.iwsl-shell .iwsl-scroll-x{ scrollbar-width: thin; scrollbar-color: var(--iw-line-2) transparent; }
.iwsl-shell table.widefat::-webkit-scrollbar,
.iwsl-shell pre::-webkit-scrollbar,
.iwsl-shell .iwsl-scroll-x::-webkit-scrollbar{ height: 8px; width: 8px; }
.iwsl-shell table.widefat::-webkit-scrollbar-thumb,
.iwsl-shell pre::-webkit-scrollbar-thumb,
.iwsl-shell .iwsl-scroll-x::-webkit-scrollbar-thumb{ background: var(--iw-line-2); border-radius: 999px; }
.iwsl-shell table.widefat::-webkit-scrollbar-track,
.iwsl-shell pre::-webkit-scrollbar-track,
.iwsl-shell .iwsl-scroll-x::-webkit-scrollbar-track{ background: transparent; }

/* ── Polish: depth, selection, micro-interaction ──────────────────────── */
/* Elevation on the run-summary cards (depth without a heavier border). */
.iwsl-shell .iwsl-panels div[style*="border-radius:12px"]{
	box-shadow: 0 18px 44px -30px rgba(0,0,0,0.95);
}
.iwsl-shell ::selection{ background: color-mix(in oklch, var(--iw-signal) 38%, transparent); color: var(--iw-ink); }
.iwsl-shell .iwsl-tabpanel{ scroll-margin-top: 84px; }
.iwsl-chip{ transition: border-color .18s var(--iw-ease), color .18s var(--iw-ease), background .18s var(--iw-ease); }
.iwsl-chip.is-ok:hover{ background: color-mix(in oklch, var(--iw-good) 10%, transparent); }

/* ── Motion ───────────────────────────────────────────────────────────── */
@keyframes iwsl-spin{ to{ transform: rotate(360deg); } }
@keyframes iwsl-pulse{ 0%,100%{ box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-good) 24%, transparent); } 50%{ box-shadow: 0 0 0 6px color-mix(in oklch, var(--iw-good) 6%, transparent); } }
@keyframes iwsl-rise{ from{ opacity: 0; transform: translateY(10px); } to{ opacity: 1; transform: translateY(0); } }
@keyframes iwsl-float{ from{ transform: translate3d(-5%, 4%, 0) scale(1); opacity: 0.55; } to{ transform: translate3d(5%, -4%, 0) scale(1.08); opacity: 0.82; } }
/* Entrance is opt-in (JS adds .is-entering on a user-initiated switch), so
   panel content is fully visible by default — never gated behind an animation
   that could stall on a headless/print render or with JS disabled. */
@media (prefers-reduced-motion: no-preference){
	.iwsl-hero__glow{ animation: iwsl-float 9s var(--iw-ease) infinite alternate; }
	.iwsl-tabpanel.is-entering > *{ animation: iwsl-rise .45s var(--iw-ease) both; }
	.iwsl-tabpanel.is-entering > *:nth-child(1){ animation-delay: .02s; }
	.iwsl-tabpanel.is-entering > *:nth-child(2){ animation-delay: .07s; }
	.iwsl-tabpanel.is-entering > *:nth-child(3){ animation-delay: .12s; }
	.iwsl-tabpanel.is-entering > *:nth-child(4){ animation-delay: .17s; }
	.iwsl-tabpanel.is-entering > *:nth-child(n+5){ animation-delay: .2s; }
}
@media (prefers-reduced-motion: reduce){
	.iwsl-shell *,
	.iwsl-shell *::before,
	.iwsl-shell *::after{ animation-duration: .001ms !important; transition-duration: .001ms !important; }
}

/* ── Toasts ───────────────────────────────────────────────────────────── */
/* PRG result notices render as inert, hidden ".iwsl-toast-seed" blocks that carry
   NO WordPress ".notice" class — so core never relocates them above the hero. The
   shell script lifts each seed into this fixed, animated, auto-dismissing stack.
   The stack sits ABOVE the sticky rail (z) and clear of it (offset), never widens
   the page (its own max-width + each toast scrolls its own overflow), and is
   pointer-transparent except on the toasts themselves. */
.iwsl-shell .iwsl-toast-seed{ display: none !important; }
.iwsl-toast-stack{
	position: fixed; top: 84px; right: 20px; z-index: var(--iw-z-toast, 60);
	display: flex; flex-direction: column; gap: 12px;
	width: min(24rem, calc(100vw - 32px));
	max-height: calc(100vh - 104px);
	pointer-events: none;
}
.iwsl-toast{
	pointer-events: auto; position: relative; isolation: isolate;
	display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 11px;
	padding: 13px 13px 15px 14px; border-radius: 14px;
	background: color-mix(in oklch, var(--iw-panel) 88%, black);
	border: 1px solid var(--iw-line-2); color: var(--iw-ink);
	box-shadow: 0 24px 54px -26px rgba(0,0,0,0.92), 0 1px 0 color-mix(in oklch, white 4%, transparent) inset;
	overflow: hidden;
	opacity: 0; transform: translateY(-9px) scale(0.985);
	transition: opacity .32s var(--iw-ease), transform .42s var(--iw-ease);
}
.iwsl-toast.is-in{ opacity: 1; transform: none; }
.iwsl-toast.is-out{ opacity: 0; transform: translateX(14px) scale(0.985); }
.iwsl-toast--success{ border-color: color-mix(in oklch, var(--iw-good) 46%, transparent); }
.iwsl-toast--error{ border-color: color-mix(in oklch, var(--iw-bad) 52%, transparent); }
.iwsl-toast--warning{ border-color: color-mix(in oklch, var(--iw-warn) 46%, transparent); }
.iwsl-toast--info{ border-color: color-mix(in oklch, var(--iw-signal) 42%, transparent); }
.iwsl-toast__icon{
	display: grid; place-items: center; width: 30px; height: 30px; flex: none;
	border-radius: 9px; font-size: 18px; line-height: 1;
}
.iwsl-toast__icon.dashicons{ width: 30px; height: 30px; }
.iwsl-toast--success .iwsl-toast__icon{ color: var(--iw-good); background: color-mix(in oklch, var(--iw-good) 16%, transparent); }
.iwsl-toast--error .iwsl-toast__icon{ color: var(--iw-bad); background: color-mix(in oklch, var(--iw-bad) 16%, transparent); }
.iwsl-toast--warning .iwsl-toast__icon{ color: var(--iw-warn); background: color-mix(in oklch, var(--iw-warn) 16%, transparent); }
.iwsl-toast--info .iwsl-toast__icon{ color: var(--iw-signal-2); background: color-mix(in oklch, var(--iw-signal) 15%, transparent); }
.iwsl-toast__content{ min-width: 0; max-height: min(52vh, 460px); overflow: auto; overscroll-behavior: contain; font-size: 13.5px; line-height: 1.5; }
.iwsl-toast__content p{ color: var(--iw-ink); margin: 0 0 6px; overflow-wrap: anywhere; }
.iwsl-toast__content p:last-child{ margin-bottom: 0; }
.iwsl-toast__content .iwsl-toast__sub{ color: var(--iw-muted); font-size: 12.5px; }
.iwsl-toast__content ul{ margin: 4px 0 2px; padding-left: 18px; list-style: disc; color: var(--iw-muted); font-size: 12.5px; }
.iwsl-toast__content li{ margin: 2px 0; overflow-wrap: anywhere; }
.iwsl-toast__content h3{ margin: 0 0 6px; font-size: 13px; font-weight: 650; text-transform: none; letter-spacing: 0; color: var(--iw-ink); }
.iwsl-toast__content h3::before{ display: none; }
.iwsl-toast__content table.widefat{ margin-top: 8px; font-size: 12px; }
.iwsl-toast__content .iwsl-toast__block{ margin-top: 6px; }
.iwsl-toast__close{
	flex: none; align-self: start; width: 26px; height: 26px; border-radius: 8px; padding: 0;
	display: grid; place-items: center; cursor: pointer; font-family: inherit;
	background: transparent; border: 1px solid transparent; color: var(--iw-faint);
	font-size: 18px; line-height: 1;
	transition: color .15s var(--iw-ease), background .15s var(--iw-ease);
}
.iwsl-toast__close:hover{ color: var(--iw-ink); background: color-mix(in oklch, white 8%, transparent); }
.iwsl-toast__close:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; }
.iwsl-toast__timer{
	position: absolute; left: 0; right: 0; bottom: 0; height: 2px; transform-origin: left center;
	background: color-mix(in oklch, var(--iw-faint) 50%, transparent);
}
.iwsl-toast--success .iwsl-toast__timer{ background: color-mix(in oklch, var(--iw-good) 60%, transparent); }
.iwsl-toast--error .iwsl-toast__timer{ background: color-mix(in oklch, var(--iw-bad) 60%, transparent); }
.iwsl-toast--warning .iwsl-toast__timer{ background: color-mix(in oklch, var(--iw-warn) 60%, transparent); }
.iwsl-toast--info .iwsl-toast__timer{ background: color-mix(in oklch, var(--iw-signal) 60%, transparent); }
.iwsl-toast.is-in .iwsl-toast__timer{ animation: iwsl-toast-timer var(--iwsl-toast-ttl, 6000ms) linear forwards; }
.iwsl-toast.is-paused .iwsl-toast__timer{ animation-play-state: paused; }
@keyframes iwsl-toast-timer{ from{ transform: scaleX(1); } to{ transform: scaleX(0); } }
@media (max-width: 782px){
	.iwsl-toast-stack{ top: 68px; right: 12px; left: 12px; width: auto; max-height: calc(100vh - 88px); }
}
@media (prefers-reduced-motion: reduce){
	.iwsl-toast{ opacity: 1; transform: none; }
	.iwsl-toast.is-out{ opacity: 0; }
	.iwsl-toast__timer{ display: none; }
}

/* ── Tier badge (Free / Basic / Pro / Ultimate) ───────────────────────── */
.iwsl-tier{
	display: inline-flex; align-items: center; gap: 8px; flex: none;
	padding: 6px 13px 6px 11px; border-radius: 999px;
	font-size: 12.5px; font-weight: 700; letter-spacing: 0.01em; line-height: 1;
	color: var(--iw-ink); border: 1px solid var(--iw-line-2);
	background: color-mix(in oklch, black 14%, transparent);
}
.iwsl-tier__gem{
	width: 9px; height: 9px; border-radius: 2px; transform: rotate(45deg); flex: none;
	background: var(--iw-faint); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-faint) 16%, transparent);
}
.iwsl-tier--free{ color: var(--iw-muted); }
.iwsl-tier--free .iwsl-tier__gem{ background: var(--iw-faint); }
.iwsl-tier--basic{ border-color: color-mix(in oklch, var(--iw-signal) 46%, transparent); }
.iwsl-tier--basic .iwsl-tier__gem{ background: var(--iw-signal); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-signal) 22%, transparent); }
.iwsl-tier--pro{ border-color: color-mix(in oklch, var(--iw-violet) 52%, transparent); }
.iwsl-tier--pro .iwsl-tier__gem{ background: var(--iw-violet); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-violet) 24%, transparent); }
.iwsl-tier--ultimate{
	border-color: color-mix(in oklch, var(--iw-warn) 55%, transparent);
	background: linear-gradient(150deg, color-mix(in oklch, var(--iw-warn) 22%, transparent), color-mix(in oklch, var(--iw-warn) 6%, transparent));
}
.iwsl-tier--ultimate .iwsl-tier__gem{ background: var(--iw-warn); box-shadow: 0 0 0 3px color-mix(in oklch, var(--iw-warn) 26%, transparent); }

/* ── Group sub-page hero (back-crumb + group identity) ────────────────── */
.iwsl-hero--group .iwsl-hero__posture{ align-items: center; }
.iwsl-hero__crumb{
	display: inline-flex; align-items: center; gap: 4px; margin: 0 0 7px;
	font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
	color: var(--iw-muted); text-decoration: none;
	transition: color .15s var(--iw-ease);
}
.iwsl-hero__crumb:hover{ color: var(--iw-signal-2); }
.iwsl-hero__crumb:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; border-radius: 4px; }
.iwsl-hero__crumb .dashicons{ font-size: 15px; width: 15px; height: 15px; }

/* ── Landing dashboard ────────────────────────────────────────────────── */
.iwsl-landing{ display: flex; flex-direction: column; gap: 30px; }

/* Status strip: site identity + live gate posture, side by side. */
.iwsl-status{ display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); gap: 18px; align-items: stretch; }
.iwsl-status__id,
.iwsl-status__gate{
	background: var(--iw-panel); border: 1px solid var(--iw-line);
	border-radius: var(--iw-r); padding: 20px 22px; min-width: 0;
	box-shadow: 0 14px 36px -30px rgba(0,0,0,0.9);
}
.iwsl-status__id{ display: flex; flex-direction: column; gap: 5px; }
.iwsl-status__tier{ display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.iwsl-status__tierhint{ font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.09em; color: var(--iw-faint); }
.iwsl-status__site{ margin: 0; font-size: 21px; font-weight: 750; letter-spacing: -0.015em; line-height: 1.15; color: var(--iw-ink); overflow-wrap: anywhere; }
.iwsl-status__url{ font-size: 13px; color: var(--iw-signal-2); text-decoration: none; overflow-wrap: anywhere; }
.iwsl-status__url:hover{ text-decoration: underline; }
.iwsl-status__ver{ display: inline-flex; align-items: center; gap: 6px; margin: 10px 0 0; font-size: 12px; color: var(--iw-faint); }
.iwsl-status__ver .dashicons{ font-size: 14px; width: 14px; height: 14px; color: var(--iw-signal); }
.iwsl-status__gate h3{ margin-top: 0; }
.iwsl-status__gate table.widefat{ max-width: 100% !important; }

/* Category cards: navigation launchers to each feature sub-page. */
.iwsl-cards{ display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.iwsl-card{
	position: relative; display: flex; flex-direction: column; gap: 12px;
	padding: 20px 20px 18px; border-radius: var(--iw-r); text-decoration: none;
	color: var(--iw-ink); overflow: hidden;
	border: 1px solid var(--iw-line);
	background: linear-gradient(180deg, var(--iw-panel), color-mix(in oklch, var(--iw-panel-2) 55%, var(--iw-panel)));
	transition: transform .2s var(--iw-ease), border-color .2s var(--iw-ease), box-shadow .2s var(--iw-ease);
}
.iwsl-card::before{
	content: ""; position: absolute; inset: 0 0 auto 0; height: 2px;
	background: linear-gradient(90deg, transparent, color-mix(in oklch, var(--iw-signal) 65%, transparent), transparent);
	opacity: 0; transition: opacity .2s var(--iw-ease);
}
.iwsl-card:hover{ transform: translateY(-3px); border-color: var(--iw-line-2); box-shadow: 0 24px 50px -30px rgba(0,0,0,0.95); }
.iwsl-card:hover::before{ opacity: 1; }
.iwsl-card:focus-visible{ outline: 2px solid var(--iw-signal); outline-offset: 2px; }
.iwsl-card__icon{
	display: grid; place-items: center; width: 44px; height: 44px; flex: none;
	border-radius: 12px; color: var(--iw-signal-2);
	background: color-mix(in oklch, var(--iw-signal) 12%, transparent);
	border: 1px solid color-mix(in oklch, var(--iw-signal) 22%, transparent);
}
.iwsl-card__icon .dashicons{ font-size: 24px; width: 24px; height: 24px; }
.iwsl-card__head{ display: flex; flex-direction: column; gap: 2px; }
.iwsl-card__title{ font-size: 16px; font-weight: 700; letter-spacing: -0.01em; color: var(--iw-ink); }
.iwsl-card__count{ font-size: 12px; font-weight: 600; color: var(--iw-faint); }
.iwsl-card__blurb{ font-size: 13px; line-height: 1.5; color: var(--iw-muted); }
.iwsl-card__list{ display: flex; flex-wrap: wrap; gap: 6px 7px; margin-top: 2px; }
.iwsl-card__feat{
	display: inline-flex; align-items: center; gap: 4px;
	padding: 3px 9px 3px 7px; border-radius: 999px;
	font-size: 11.5px; font-weight: 600; color: var(--iw-muted);
	background: color-mix(in oklch, white 4%, transparent); border: 1px solid var(--iw-line);
}
.iwsl-card__feat .dashicons{ font-size: 13px; width: 13px; height: 13px; color: var(--iw-good); }
.iwsl-card__feat.is-locked{ color: var(--iw-faint); }
.iwsl-card__feat.is-locked .dashicons{ color: var(--iw-faint); }
.iwsl-card__go{ position: absolute; top: 19px; right: 17px; color: var(--iw-faint); transition: transform .2s var(--iw-ease), color .2s var(--iw-ease); }
.iwsl-card__go .dashicons{ font-size: 20px; width: 20px; height: 20px; }
.iwsl-card:hover .iwsl-card__go{ color: var(--iw-signal-2); transform: translateX(3px); }
.iwsl-card__head{ padding-right: 26px; }

.iwsl-landing__snapshot,
.iwsl-landing__roadmap{ padding-top: 4px; border-top: 1px solid var(--iw-line); }
.iwsl-landing__snapshot > h2,
.iwsl-landing__roadmap > h2{ margin-top: 18px; }

/* ── Responsive ───────────────────────────────────────────────────────── */
@media (max-width: 900px){
	.iwsl-status{ grid-template-columns: 1fr; }
}
@media (max-width: 782px){
	#wpcontent .iwsl-shell{ margin: 0; min-height: calc(100vh - 46px); }
	.iwsl-hero{ padding: 22px 18px; }
	.iwsl-tabnav{ top: 46px; }
	.iwsl-panels{ padding: 20px 16px 28px; }
	.iwsl-shell table.form-table th{ width: auto; display: block; padding-bottom: 4px; }
	.iwsl-shell table.form-table td{ display: block; }
	.iwsl-cards{ grid-template-columns: 1fr; }
	/* Compact category cards on phones: icon sits BESIDE the title (not above
	   it, which left a big empty gap), and the blurb + feature chips flow full
	   width beneath. Tighter padding, smaller icon — cleaner on a narrow screen. */
	.iwsl-card{ display: grid; grid-template-columns: auto 1fr; column-gap: 13px; row-gap: 9px; align-items: center; padding: 16px 16px 15px; }
	.iwsl-card__icon{ width: 38px; height: 38px; }
	.iwsl-card__icon .dashicons{ font-size: 21px; width: 21px; height: 21px; }
	.iwsl-card__blurb, .iwsl-card__list{ grid-column: 1 / -1; }
	.iwsl-card__go{ top: 16px; right: 14px; }
}
/* Below 600px the WordPress admin bar stops being position:fixed and scrolls
   away with the page — so reserving its height as a sticky offset would leave an
   empty band above the rail. Pin the rail to the very top there instead. */
@media screen and (max-width: 600px){
	.iwsl-tabnav{ top: 0; }
}
CSS;
		echo "\n</style>\n";
	}

	/**
	 * Tab interaction: WAI-ARIA tablist keyboard model, hash deep-linking, and
	 * a lightweight busy state on form submit. Progressive enhancement — with
	 * JS off, a <noscript> rule reveals every panel and hides the rail.
	 */
	private static function render_shell_script(): void {
		echo "<noscript><style>.iwsl-shell .iwsl-tabpanel[hidden]{display:block!important}.iwsl-shell .iwsl-tabnav{display:none}.iwsl-shell .iwsl-toast-seed{display:block!important;margin-top:12px;padding:13px 15px;border:1px solid var(--iw-line-2);border-radius:var(--iw-r-sm);background:var(--iw-panel);}</style></noscript>\n";
		echo "<script>\n";
		echo <<<'JS'
(function(){
	var shell = document.querySelector('.iwsl-shell');
	if (!shell) { return; }
	var tabs = Array.prototype.slice.call(shell.querySelectorAll('.iwsl-tab'));
	var panels = Array.prototype.slice.call(shell.querySelectorAll('.iwsl-tabpanel'));
	if (!tabs.length) { return; }
	// Remembered-tab key is scoped PER PAGE (data-iwsl-scope) so each category
	// sub-page restores its own last tab and never clobbers another's.
	var scope = (shell.dataset && shell.dataset.iwslScope) ? shell.dataset.iwslScope : '';
	var STORE_KEY = 'iwsl_tab_' + scope;

	function enter(panel){
		panel.classList.remove('is-entering');
		void panel.offsetWidth; // restart the stagger
		panel.classList.add('is-entering');
		panel.addEventListener('animationend', function done(){
			panel.classList.remove('is-entering');
			panel.removeEventListener('animationend', done);
		});
	}

	function isLocked(tab){ return tab && tab.dataset.locked === '1'; }
	// Next selectable (non-locked) tab index in a direction, skipping locked tabs.
	function step(from, dir){
		var n = from;
		for (var k = 0; k < tabs.length; k++){
			n = (n + dir + tabs.length) % tabs.length;
			if (!isLocked(tabs[n])) { return n; }
		}
		return from;
	}

	function activate(id, focusTab, push, animate){
		// A locked section is sealed — never open it (click, key, hash, or restore).
		var target = tabs.filter(function(t){ return t.dataset.tab === id; })[0];
		if (isLocked(target)) { return; }
		var matched = false;
		tabs.forEach(function(tab){
			var on = tab.dataset.tab === id;
			tab.classList.toggle('is-active', on);
			tab.setAttribute('aria-selected', on ? 'true' : 'false');
			tab.tabIndex = on ? 0 : -1;
			if (on) {
				matched = true;
				if (focusTab) { tab.focus(); }
				tab.scrollIntoView({ block: 'nearest', inline: 'center' });
			}
		});
		if (!matched) { return; }
		panels.forEach(function(panel){
			var on = panel.id === 'iwsl-tab-' + id;
			panel.hidden = !on;
			panel.classList.toggle('is-active', on);
			if (on && animate) { enter(panel); }
		});
		if (push && history.replaceState) { history.replaceState(null, '', '#iwsl-' + id); }
		// Remember the tab so a full-page form POST + server redirect (which drops
		// the hash) returns the operator to the same section, not back to Overview.
		try { localStorage.setItem(STORE_KEY, id); } catch (e) {}
	}

	tabs.forEach(function(tab){
		tab.addEventListener('click', function(){
			if (isLocked(tab)) { return; } // sealed — a locked plan feature.
			activate(tab.dataset.tab, false, true, true);
		});
	});

	var rail = shell.querySelector('.iwsl-tabnav');
	if (rail) {
		rail.addEventListener('keydown', function(e){
			var i = tabs.indexOf(document.activeElement);
			if (i < 0) { return; }
			var n = null;
			if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { n = step(i, 1); }
			else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { n = step(i, -1); }
			else if (e.key === 'Home') { n = 0; }               // overview is never locked
			else if (e.key === 'End') { n = step(0, -1); }      // last selectable tab
			if (n === null) { return; }
			e.preventDefault();
			activate(tabs[n].dataset.tab, true, true, true);
		});
	}

	// Busy state on any submit inside a panel (visual only; never blocks POST).
	shell.addEventListener('submit', function(e){
		var btn = e.submitter || e.target.querySelector('[type="submit"]');
		if (btn && btn.classList && !btn.classList.contains('button-link-delete')) {
			btn.classList.add('is-busy');
		}
	});

	// Deep-link: open the tab named in the URL hash (#iwsl-images) without an
	// entrance animation, so the first paint is always the visible content.
	// No hash → the default Overview panel is already shown in the markup.
	var hash = (location.hash || '').replace(/^#iwsl-/, '');
	if (hash && shell.querySelector('#iwsl-tab-' + hash)) {
		activate(hash, false, false, false);
	} else {
		var saved = null;
		try { saved = localStorage.getItem(STORE_KEY); } catch (e) {}
		if (saved && saved !== 'overview' && shell.querySelector('#iwsl-tab-' + saved)) {
			activate(saved, false, false, false);
		}
	}
})();

// ── Result toasts ─────────────────────────────────────────────────────────
// Lift each inert "toast seed" (a PRG result rendered with NO WordPress .notice
// class, so core never hoists it above the hero) into a fixed, animated,
// auto-dismissing toast. Rich content — including tables — is moved intact, so
// only the PRESENTATION changes. Success → role=status/polite; error →
// role=alert/assertive. Auto-dismiss ~6s, paused on hover/focus, manual close,
// Escape-dismiss when focused. prefers-reduced-motion → instant show/hide.
(function(){
	var host = document.querySelector('.iwsl-shell');
	if (!host) { return; }
	var seeds = Array.prototype.slice.call(host.querySelectorAll('[data-iwsl-toast]'));
	if (!seeds.length) { return; }

	var reduce = false;
	try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
	var TTL = 6000, OUT = 440;

	var stack = document.createElement('div');
	stack.className = 'iwsl-toast-stack';
	host.appendChild(stack);

	function iconClass(v){
		if (v === 'success') { return 'dashicons-yes-alt'; }
		if (v === 'info') { return 'dashicons-info'; }
		return 'dashicons-warning'; // error + warning
	}

	function spawn(seed){
		var variant = seed.getAttribute('data-iwsl-toast') || 'info';
		var isError = (variant === 'error');

		var toast = document.createElement('div');
		toast.className = 'iwsl-toast iwsl-toast--' + variant;
		toast.setAttribute('role', isError ? 'alert' : 'status');
		toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
		toast.setAttribute('aria-atomic', 'true');
		toast.tabIndex = -1;

		var icon = document.createElement('span');
		icon.className = 'iwsl-toast__icon dashicons ' + iconClass(variant);
		icon.setAttribute('aria-hidden', 'true');

		var content = document.createElement('div');
		content.className = 'iwsl-toast__content';
		while (seed.firstChild) { content.appendChild(seed.firstChild); }

		var close = document.createElement('button');
		close.type = 'button';
		close.className = 'iwsl-toast__close';
		close.setAttribute('aria-label', 'Dismiss notification');
		close.innerHTML = '&times;';

		var timer = document.createElement('span');
		timer.className = 'iwsl-toast__timer';
		timer.setAttribute('aria-hidden', 'true');
		timer.style.setProperty('--iwsl-toast-ttl', TTL + 'ms');

		toast.appendChild(icon);
		toast.appendChild(content);
		toast.appendChild(close);
		toast.appendChild(timer);
		stack.appendChild(toast);
		if (seed.parentNode) { seed.parentNode.removeChild(seed); }

		var dead = false, tid = null, startedAt = 0, remaining = TTL;
		function clearTid(){ if (tid) { clearTimeout(tid); tid = null; } }
		function remove(){ if (toast.parentNode) { toast.parentNode.removeChild(toast); } }
		function dismiss(){
			if (dead) { return; }
			dead = true; clearTid();
			toast.classList.remove('is-in');
			toast.classList.add('is-out');
			if (reduce) { remove(); } else { setTimeout(remove, OUT); }
		}
		function startTimer(ms){ clearTid(); startedAt = Date.now(); remaining = ms; tid = setTimeout(dismiss, ms); }
		function pause(){
			if (dead || tid === null) { return; }
			clearTid();
			remaining -= (Date.now() - startedAt);
			if (remaining < 500) { remaining = 500; }
			toast.classList.add('is-paused');
		}
		function resume(){ if (dead) { return; } toast.classList.remove('is-paused'); startTimer(remaining); }

		close.addEventListener('click', dismiss);
		toast.addEventListener('mouseenter', pause);
		toast.addEventListener('mouseleave', resume);
		toast.addEventListener('focusin', pause);
		toast.addEventListener('focusout', function(e){
			if (!toast.contains(e.relatedTarget)) { resume(); }
		});
		toast.addEventListener('keydown', function(e){
			if (e.key === 'Escape' || e.key === 'Esc') { e.stopPropagation(); dismiss(); }
		});

		if (reduce) {
			toast.classList.add('is-in');
		} else {
			requestAnimationFrame(function(){ requestAnimationFrame(function(){ toast.classList.add('is-in'); }); });
		}
		startTimer(TTL);
	}

	seeds.forEach(spawn);
})();
JS;
		echo "\n</script>\n";
	}

	/**
	 * OPEN a result "toast seed": an inert, hidden container carrying NO WordPress
	 * `.notice` class (so core never relocates it above the hero). The shell script
	 * lifts it into a fixed, animated, auto-dismissing toast on load. Rich HTML —
	 * paragraphs, lists, the configured-vs-effective table — is allowed inside;
	 * ONLY the presentation changes, every message/table content is preserved.
	 *
	 * @param string $variant success|error|warning|info — drives accent, icon, and
	 *                         the live-region role (error → alert/assertive).
	 */
	private static function toast_open( string $variant ): void {
		if ( ! in_array( $variant, array( 'success', 'error', 'warning', 'info' ), true ) ) {
			$variant = 'info';
		}
		echo '<div class="iwsl-toast-seed" data-iwsl-toast="' . esc_attr( $variant ) . '" hidden>';
	}

	/** CLOSE a toast seed opened with {@see toast_open()}. */
	private static function toast_close(): void {
		echo '</div>';
	}

	/** One row per gate with a pass/fail marker and the live detail. */
	private static function render_gate_table( array $gate ): void {
		$heartbeat_detail = self::heartbeat_detail( $gate );
		$rows             = array(
			array(
				'label'  => 'Connected',
				'ok'     => ! empty( $gate['linked'] ),
				'detail' => 'Connection status: ' . (string) $gate['state'],
			),
			array(
				'label'  => 'Connection active',
				'ok'     => ! empty( $gate['heartbeat_fresh'] ),
				'detail' => $heartbeat_detail,
			),
			array(
				'label'  => 'Plan active',
				'ok'     => ! empty( $gate['plus'] ),
				'detail' => ! empty( $gate['plus'] ) ? 'Included in your plan' : 'Not included in your plan yet',
			),
		);

		echo '<table class="widefat striped" style="max-width:640px;margin-top:12px;"><thead><tr>';
		echo '<th>Gate</th><th>State</th><th>Detail</th></tr></thead><tbody>';
		foreach ( $rows as $row ) {
			$marker = $row['ok']
				? '<span style="color:#1a7f37;font-weight:600;">&#10004; pass</span>'
				: '<span style="color:#b3261e;font-weight:600;">&#10008; blocked</span>';
			echo '<tr><th scope="row">' . esc_html( $row['label'] ) . '</th><td>' . $marker . '</td><td>' . esc_html( $row['detail'] ) . '</td></tr>';
		}
		echo '</tbody></table>';
	}

	private static function heartbeat_detail( array $gate ): string {
		if ( null === $gate['last_verified_at'] ) {
			return 'No connection confirmed yet';
		}
		$age_ms    = (int) $gate['heartbeat_age_ms'];
		$age_min   = (int) floor( $age_ms / 60000 );
		$limit_min = (int) floor( (int) $gate['heartbeat_threshold_ms'] / 60000 );
		return sprintf( 'Last connected %d min ago (stays active for %d min)', max( 0, $age_min ), $limit_min );
	}

	/**
	 * Human, one-line-per-reason explanation of why a Plus feature is locked.
	 * @param array  $gate             Entitlement gate with a `reasons` array.
	 * @param string $feature_label    Feature name for the heading (blank = generic).
	 * @param string $requires_plus_msg Feature-specific "needs a plan" line (blank = generic).
	 */
	private static function render_locked_notice( array $gate, string $feature_label = '', string $requires_plus_msg = '' ): void {
		$requires = '' !== $requires_plus_msg
			? $requires_plus_msg
			: 'This is a Plus feature. Turn it on for this site from your InfraWeaver dashboard.';
		$messages = array(
			'not-linked'      => 'This site isn&#8217;t connected to your InfraWeaver account yet &mdash; connect it from your dashboard to turn this on.',
			'heartbeat-stale' => 'Your InfraWeaver connection needs to refresh &mdash; we haven&#8217;t heard from your account recently. It usually reconnects on its own; if it doesn&#8217;t, reconnect from your dashboard.',
			'requires-plus'   => $requires,
		);
		$heading = '' !== $feature_label ? esc_html( $feature_label ) . ' is locked.' : 'This feature is locked.';
		echo '<div class="notice notice-warning inline" style="margin-top:12px;padding:12px;"><p><strong>&#128274; ' . $heading . '</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}

	// ── Section 2: Lossless Image Optimization ─────────────────────────────────

	/**
	 * Render the image-optimization section, driven by the
	 * `image_optimization` gate. Locked → reasons only, no form. Unlocked →
	 * capability table + run form + last-run summary + the coming-soon roadmap.
	 */
	private function render_image_optimization_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Media_Optimizer::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>Image Optimization</h2>';
		echo '<p>Re-encode this site&#8217;s images to WebP — lossless for PNG, GIF, BMP and TIFF; near-lossless for JPEG. Smaller files, identical-looking pixels, run entirely on this server — no external service is called.</p>';

		// A redirect from the handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_mo_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			self::toast_open( 'error' );
			echo '<p><strong>' . esc_html__( 'The Image Optimization entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p>';
			self::toast_close();
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate, 'Image Optimization', 'Image Optimization is part of the Pro plan. Turn on Pro for this site from your InfraWeaver dashboard.' );
			return;
		}

		$this->render_capability_table();
		$this->render_optimization_form();
		$this->render_last_run_summary();

		echo '<p class="description" style="margin-top:8px;">' . esc_html__( 'Originals are never modified; derivatives are written alongside them.', 'infraweaver-connector' ) . '</p>';
	}

	/** Engine capability table — one row per registered converter. */
	private function render_capability_table(): void {
		$caps = $this->optimizer()->capabilities();
		echo '<table class="widefat striped" style="max-width:720px;margin-top:12px;"><thead><tr>';
		echo '<th>Converter</th><th>Accepts</th><th>Engine</th><th>Status</th></tr></thead><tbody>';
		foreach ( $caps as $cap ) {
			$avail  = is_array( $cap['availability'] ) ? $cap['availability'] : array();
			$ok     = ! empty( $avail['ok'] );
			$engine = isset( $avail['engine'] ) ? (string) $avail['engine'] : 'none';
			$marker = $ok
				? '<span style="color:#1a7f37;font-weight:600;">&#10004; ready</span>'
				: '<span style="color:#b3261e;font-weight:600;">&#10008; blocked</span>';
			$detail = $ok ? $engine : ( $engine . ' (' . (string) ( $avail['reason'] ?? 'unavailable' ) . ')' );
			echo '<tr>';
			echo '<th scope="row">' . esc_html( (string) $cap['label'] ) . '</th>';
			echo '<td>' . esc_html( implode( ', ', array_map( 'strval', (array) $cap['accepts'] ) ) ) . '</td>';
			echo '<td>' . esc_html( $detail ) . '</td>';
			echo '<td>' . $marker . '</td>';
			echo '</tr>';
		}
		echo '</tbody></table>';
	}

	/** The nonce-protected run form (POST → admin-post.php). */
	private function render_optimization_form(): void {
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" class="iwsl-mo-form" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::OPTIMIZE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::OPTIMIZE_ACTION ) . '">';

		// PRIMARY one-click action — safe defaults apply (Auto types, keep original +
		// add WebP, only smaller results kept). Open Advanced to tune before running.
		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html__( 'Re-encodes to WebP — originals kept, only smaller results are saved.', 'infraweaver-connector' ) . '</span>';
		echo '<button type="submit" name="op" value="run" class="button button-primary">' . esc_html__( 'Optimize all images', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';

		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-mo-types">' . esc_html__( 'Image types', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'Which picture kinds to shrink — Auto handles them all.' ) . '</th><td>';
		echo '<select id="iwsl-mo-types" name="types">';
		echo '<option value="auto">' . esc_html__( 'Auto — all types (PNG, JPEG, GIF, BMP, TIFF)', 'infraweaver-connector' ) . '</option>';
		foreach ( array( 'image/png' => 'PNG', 'image/jpeg' => 'JPEG', 'image/gif' => 'GIF', 'image/bmp' => 'BMP', 'image/tiff' => 'TIFF' ) as $iwsl_mime => $iwsl_lbl ) {
			echo '<option value="' . esc_attr( $iwsl_mime ) . '">' . esc_html( $iwsl_lbl ) . '</option>';
		}
		echo '</select><br><span class="description">' . esc_html__( 'Auto picks the best WebP mode per type — lossless for PNG/GIF/BMP/TIFF, near-lossless for JPEG. Only smaller results are kept.', 'infraweaver-connector' ) . '</span></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Pick images', 'infraweaver-connector' ) . iwsl_field_help( 'Optionally choose specific images instead of shrinking a batch.' ) . '</th><td>';
		echo '<input type="hidden" name="ids" id="iwsl-mo-ids" value="">';
		echo '<button type="button" class="button" id="iwsl-mo-pick">' . esc_html__( 'Choose images…', 'infraweaver-connector' ) . '</button> ';
		echo '<button type="button" class="button" id="iwsl-mo-clear">' . esc_html__( 'Clear', 'infraweaver-connector' ) . '</button><br>';
		echo '<span id="iwsl-mo-picked" class="description">' . esc_html__( 'No images selected — the count below is used instead.', 'infraweaver-connector' ) . '</span>';
		echo '</td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-mo-count">' . esc_html__( 'Images this run', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'How many images to shrink in one go.' ) . '</th><td>';
		echo '<input type="number" id="iwsl-mo-count" name="count" min="1" max="' . (int) IWSL_Media_Optimizer::MAX_REQUEST . '" value="25" style="width:100px;"> ';
		echo '<span class="description">' . esc_html( sprintf(
			/* translators: %d is the per-run image ceiling. */
			__( 'Up to %d. Used only when no images are picked above. Bigger requests self-queue across batches (each run is time-bounded — just run again to continue).', 'infraweaver-connector' ),
			IWSL_Media_Optimizer::MAX_REQUEST
		) ) . '</span></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Output', 'infraweaver-connector' ) . iwsl_field_help( 'Keep the original image too, or overwrite it with the smaller one.' ) . '</th><td>';
		echo '<label style="display:block;margin-bottom:8px;"><input type="radio" name="mode" value="copy" checked> <strong>' . esc_html__( 'Keep original + add WebP copy', 'infraweaver-connector' ) . '</strong><br><span class="description" style="margin-left:24px;">' . esc_html__( 'Safe. Nothing is deleted — the WebP sits beside the original.', 'infraweaver-connector' ) . '</span></label>';
		echo '<label style="display:block;"><input type="radio" name="mode" value="replace"> <strong>' . esc_html__( 'Replace original with WebP', 'infraweaver-connector' ) . '</strong><br><span class="description" style="margin-left:24px;">' . esc_html__( 'Smaller storage and faster pages. Deletes the original file — any hardcoded .png link in post content will break.', 'infraweaver-connector' ) . '</span></label>';
		echo '</td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'On your pages', 'infraweaver-connector' ) . iwsl_field_help( 'Swap the pictures shown on your pages to the smaller ones.' ) . '</th><td>';
		echo '<label style="display:block;"><input type="checkbox" name="rewrite" value="1"> <strong>' . esc_html__( 'Replace the images on my pages with the optimized WebP', 'infraweaver-connector' ) . '</strong><br><span class="description" style="margin-left:24px;">' . esc_html__( 'Rewrites the image URLs in post & page content (including srcset) to point at the new WebP — even when you keep the original copy. Applies to images optimized in this run.', 'infraweaver-connector' ) . '</span></label>';
		echo '</td></tr>';

		echo '</tbody></table>';

		echo '<p style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">';
		echo '<button type="submit" name="op" value="preview" class="button">' . esc_html__( 'Estimate savings', 'infraweaver-connector' ) . '</button>';
		echo '<span class="description">' . esc_html__( 'Estimate is a dry run — it changes nothing.', 'infraweaver-connector' ) . '</span>';
		echo '</p>';

		echo '<hr style="margin:18px 0;border-color:var(--iw-line);">';
		echo '<p style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">';
		$dedupe_confirm = esc_js( __( 'Delete every original image that already has an optimized WebP copy? Page references are repointed to the WebP first. This cannot be undone.', 'infraweaver-connector' ) );
		echo '<button type="submit" name="op" value="dedupe-preview" class="button">' . esc_html__( 'Find optimized duplicates', 'infraweaver-connector' ) . '</button>';
		echo '<button type="submit" name="op" value="dedupe" class="button button-link-delete" onclick="return confirm(\'' . $dedupe_confirm . '\');">' . esc_html__( 'Remove optimized duplicates', 'infraweaver-connector' ) . '</button>';
		echo '<span class="description">' . esc_html__( 'Removes originals that have already been optimized (keeps the WebP). Repoints your pages first. “Find” is a safe dry run.', 'infraweaver-connector' ) . '</span>';
		echo '</p>';
		echo '</div></details>';
		echo '</form>';
		self::render_media_picker_script();
	}

	/**
	 * Media-library picker JS for the "Choose images…" button. `wp.media` is
	 * only referenced inside the click handler (it is loaded by the time the
	 * user clicks, via wp_enqueue_media() on this page). No new external
	 * assets — this is the only script tied to the picker UI.
	 */
	private static function render_media_picker_script(): void {
		echo "<script>\n";
		echo <<<'JS'
(function(){
	var pickBtn = document.getElementById('iwsl-mo-pick');
	var clearBtn = document.getElementById('iwsl-mo-clear');
	var idsField = document.getElementById('iwsl-mo-ids');
	var label = document.getElementById('iwsl-mo-picked');
	if (!pickBtn || !clearBtn || !idsField || !label) { return; }

	var defaultLabel = label.textContent;
	var frame = null;

	function setPicked(ids){
		idsField.value = ids.join(',');
		if (ids.length > 0) {
			label.textContent = ids.length + ' image' + (ids.length === 1 ? '' : 's') + ' selected';
		} else {
			label.textContent = defaultLabel;
		}
	}

	pickBtn.addEventListener('click', function(e){
		e.preventDefault();
		if (typeof wp === 'undefined' || !wp.media) { return; }

		if (frame) {
			frame.open();
			return;
		}

		frame = wp.media({
			title: 'Select images to optimize',
			multiple: true,
			library: {
				type: ['image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff']
			},
			button: { text: 'Use these images' }
		});

		frame.on('select', function(){
			var selection = frame.state().get('selection');
			var ids = [];
			selection.each(function(attachment){
				ids.push(attachment.id);
			});
			setPicked(ids);
		});

		frame.open();
	});

	clearBtn.addEventListener('click', function(e){
		e.preventDefault();
		if (frame) {
			frame.state().get('selection').reset();
		}
		setPicked([]);
	});
})();
JS;
		echo "\n</script>\n";
	}

	/** Render (then clear) the current user's last-run summary transient. */
	private function render_last_run_summary(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key     = 'iwsl_mo_result_' . (int) get_current_user_id();
		$summary = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $summary ) ) {
			return;
		}

		if ( isset( $summary['kind'] ) && 'dedupe' === $summary['kind'] ) {
			$this->render_dedupe_summary( $summary );
			return;
		}

		$variant = empty( $summary['ok'] ) ? 'error' : 'success';
		self::toast_open( $variant );
		$dry = ! empty( $summary['dry'] );
		echo '<h3 style="margin-top:0;">' . esc_html( $dry ? __( 'Savings estimate', 'infraweaver-connector' ) : __( 'Last run', 'infraweaver-connector' ) ) . '</h3>';

		if ( empty( $summary['ok'] ) ) {
			echo '<p>' . esc_html( sprintf( 'Run refused: %s', (string) ( $summary['reason'] ?? 'unknown' ) ) ) . '</p>';
			self::toast_close();
			return;
		}

		$converted = (int) ( $summary['converted'] ?? 0 );
		$skipped   = (int) ( $summary['skipped'] ?? 0 );
		$refused   = (int) ( $summary['refused'] ?? 0 );
		$saved     = (int) ( $summary['saved_bytes'] ?? 0 );
		$bytes_in  = (int) ( $summary['bytes_in'] ?? 0 );
		$pct       = $bytes_in > 0 ? (int) round( $saved / $bytes_in * 100 ) : 0;

		$items    = isset( $summary['items'] ) && is_array( $summary['items'] ) ? $summary['items'] : array();
		$replaced = 0;
		foreach ( $items as $it ) {
			if ( ! empty( $it['replaced'] ) ) {
				++$replaced;
			}
		}

		if ( $dry ) {
			echo '<p style="font-size:15px;">' . esc_html( sprintf(
				/* translators: 1: image count, 2: human size, 3: percent. */
				__( 'Converting %1$d image(s) would save %2$s (~%3$d%% smaller). Nothing was changed.', 'infraweaver-connector' ),
				$converted,
				self::format_bytes( $saved ),
				$pct
			) ) . '</p>';
		} else {
			$msg = sprintf(
				/* translators: 1: converted, 2: skipped, 3: refused, 4: size, 5: percent. */
				__( 'Converted %1$d, skipped %2$d, refused %3$d. Saved %4$s (~%5$d%% smaller).', 'infraweaver-connector' ),
				$converted,
				$skipped,
				$refused,
				self::format_bytes( $saved ),
				$pct
			);
			if ( IWSL_Media_Optimizer::MODE_REPLACE === ( $summary['mode'] ?? '' ) ) {
				/* translators: %d is the number of originals replaced. */
				$msg .= ' ' . sprintf( __( '%d original(s) replaced.', 'infraweaver-connector' ), $replaced );
			}
			$rewrote = (int) ( $summary['rewrote_posts'] ?? 0 );
			if ( $rewrote > 0 ) {
				$msg .= ' ' . sprintf(
					/* translators: %d is the number of posts/pages whose image URLs were repointed to the WebP. */
					_n( '%d page repointed to the WebP.', '%d pages repointed to the WebP.', $rewrote, 'infraweaver-connector' ),
					$rewrote
				);
			}
			echo '<p style="font-size:15px;">' . esc_html( $msg ) . '</p>';
		}

		if ( ! empty( $summary['partial'] ) ) {
			echo '<p><strong>' . esc_html__( 'Time budget reached — more images remain. Run the same action again to continue the queue.', 'infraweaver-connector' ) . '</strong></p>';
		}

		if ( array() !== $items ) {
			echo '<table class="widefat striped" style="max-width:640px;"><thead><tr><th>File</th><th>Result</th></tr></thead><tbody>';
			foreach ( array_slice( $items, 0, 60 ) as $item ) {
				$basename = isset( $item['basename'] ) ? (string) $item['basename'] : '';
				$outcome  = isset( $item['outcome'] ) ? (string) $item['outcome'] : '';
				if ( 'converted' === $outcome && isset( $item['saving'] ) ) {
					$detail = ( $dry ? 'would save ' : 'saved ' ) . self::format_bytes( (int) $item['saving'] );
					if ( ! empty( $item['replaced'] ) ) {
						$detail .= ' · replaced';
					} elseif ( isset( $item['replace_reason'] ) ) {
						$detail .= ' · replace failed: ' . (string) $item['replace_reason'];
					}
				} elseif ( isset( $item['reason'] ) ) {
					$detail = $outcome . ' — ' . (string) $item['reason'];
				} else {
					$detail = $outcome;
				}
				echo '<tr><td>' . esc_html( $basename ) . '</td><td>' . esc_html( $detail ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		self::toast_close();
	}

	/** Render a de-duplicate (remove-optimized-originals) run/preview summary. */
	private function render_dedupe_summary( array $summary ): void {
		$variant = empty( $summary['ok'] ) ? 'error' : 'success';
		self::toast_open( $variant );
		$dry = ! empty( $summary['dry'] );
		echo '<h3 style="margin-top:0;">' . esc_html( $dry ? __( 'Duplicates found', 'infraweaver-connector' ) : __( 'Duplicates removed', 'infraweaver-connector' ) ) . '</h3>';

		if ( empty( $summary['ok'] ) ) {
			$reason = (string) ( $summary['reason'] ?? 'unknown' );
			$text   = 'entitlement-locked' === $reason
				? __( 'Image Optimization is not granted for this site.', 'infraweaver-connector' )
				: sprintf( 'Refused: %s', $reason );
			echo '<p>' . esc_html( $text ) . '</p>';
			self::toast_close();
			return;
		}

		$removed = (int) ( $summary['removed'] ?? 0 );
		$skipped = (int) ( $summary['skipped'] ?? 0 );
		$freed   = (int) ( $summary['freed_bytes'] ?? 0 );
		$rewrote = (int) ( $summary['rewrote_posts'] ?? 0 );

		if ( $dry ) {
			$msg = sprintf(
				/* translators: 1: count, 2: human size. */
				__( '%1$d original(s) have an optimized copy and can be removed, reclaiming ~%2$s. Nothing was deleted.', 'infraweaver-connector' ),
				$removed,
				self::format_bytes( $freed )
			);
		} else {
			$msg = sprintf(
				/* translators: 1: removed count, 2: skipped, 3: human size. */
				__( 'Removed %1$d original(s), skipped %2$d. Reclaimed ~%3$s.', 'infraweaver-connector' ),
				$removed,
				$skipped,
				self::format_bytes( $freed )
			);
			if ( $rewrote > 0 ) {
				$msg .= ' ' . sprintf(
					/* translators: %d is the number of posts/pages repointed to the WebP. */
					_n( '%d page repointed to the WebP.', '%d pages repointed to the WebP.', $rewrote, 'infraweaver-connector' ),
					$rewrote
				);
			}
		}
		echo '<p style="font-size:15px;">' . esc_html( $msg ) . '</p>';

		$items = isset( $summary['items'] ) && is_array( $summary['items'] ) ? $summary['items'] : array();
		if ( array() !== $items ) {
			echo '<table class="widefat striped" style="max-width:640px;"><thead><tr><th>File</th><th>Result</th></tr></thead><tbody>';
			foreach ( array_slice( $items, 0, 60 ) as $item ) {
				$basename = isset( $item['basename'] ) ? (string) $item['basename'] : '';
				$outcome  = isset( $item['outcome'] ) ? (string) $item['outcome'] : '';
				$detail   = isset( $item['reason'] ) && '' !== (string) $item['reason']
					? $outcome . ' — ' . (string) $item['reason']
					: $outcome;
				echo '<tr><td>' . esc_html( $basename ) . '</td><td>' . esc_html( $detail ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		self::toast_close();
	}

	/** Inert roadmap rows — greyed, "Coming soon" pill, NO form, NO handler. */
	private static function render_coming_soon(): void {
		// Premium-plugin-inspired features that are cheap to build on-server (no
		// external service): each mirrors a paid plugin people normally pay for.
		// Login/auth features are intentionally omitted — Authentik sits in front of
		// the site as the SSO/identity layer, so login hardening lives there.
		$rows = array(
			array( 'Related-Posts Engine', 'Surface relevant posts from your own content — computed on-server, no third-party widget.', 'Pro' ),
			array( 'Product Schema Generator', 'Emit valid Product / FAQ / Article JSON-LD so listings can earn rich results.', 'Pro' ),
			array( 'Newsletter Capture', 'Collect subscribers into a local list with a themed inline form — export any time.', 'Pro' ),
			array( 'Comment Spam Filter', 'Score and quarantine spam comments with on-server heuristics — no external API.', 'Pro' ),
			array( 'A/B Headline Testing', 'Rotate two titles for a post and keep the one that earns more clicks.', 'Ultimate' ),
			array( 'Uptime & Health Monitor', 'Watch core vitals — cron, disk, PHP errors — and flag regressions early.', 'Ultimate' ),
		);
		echo '<ul style="list-style:none;margin:8px 0 0;padding:0;max-width:720px;">';
		foreach ( $rows as $row ) {
			list( $title, $desc, $tier ) = $row;
			echo '<li style="opacity:0.7;border:1px solid var(--iw-line);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:color-mix(in oklch, var(--iw-panel) 60%, transparent);">';
			echo '<span style="display:inline-block;background:color-mix(in oklch, var(--iw-warn) 22%, transparent);color:var(--iw-warn);border-radius:10px;padding:1px 8px;font-size:11px;font-weight:600;margin-right:8px;">' . esc_html__( 'Coming soon', 'infraweaver-connector' ) . '</span>';
			echo '<strong>' . esc_html( $title ) . '</strong> ';
			echo '<span style="display:inline-block;background:color-mix(in oklch, var(--iw-signal) 16%, transparent);color:var(--iw-signal-2);border-radius:10px;padding:1px 8px;font-size:11px;margin-left:4px;">' . esc_html( $tier ) . '</span>';
			echo '<br><span class="description">' . esc_html( $desc ) . '</span>';
			echo '</li>';
		}
		echo '</ul>';
	}

	private static function format_bytes( int $bytes ): string {
		if ( $bytes < 1024 ) {
			return $bytes . ' B';
		}
		if ( $bytes < 1048576 ) {
			return round( $bytes / 1024, 1 ) . ' KB';
		}
		return round( $bytes / 1048576, 2 ) . ' MB';
	}

	/**
	 * admin-post handler for the image-optimization run. LAYER 2 of the gate:
	 * capability + nonce, then re-check the entitlement before doing any work,
	 * then run() (whose first statement is the authoritative LAYER 3 gate).
	 * POST-redirect-GET: stash the summary in a per-user transient and redirect.
	 */
	public function handle_media_optimize(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::OPTIMIZE_NONCE );

		$redirect = iwsl_plus_redirect_base();

		// LAYER 2: re-check the gate before touching any file.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Media_Optimizer::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_mo_locked', '1', $redirect ) );
			exit;
		}

		// Inputs that cross the boundary: nonce + an allow-listed converter id
		// validated against the registry keys, an integer count, two closed
		// enums (mode, op), and — optionally — a picker-supplied id list
		// (validated further below, never trusted as-is).
		$requested = isset( $_POST['converter'] ) ? sanitize_key( wp_unslash( $_POST['converter'] ) ) : 'webp_lossless';
		$optimizer = $this->optimizer();
		$converter = in_array( $requested, $optimizer->converter_ids(), true ) ? $requested : 'webp_lossless';

		$count = isset( $_POST['count'] ) ? (int) $_POST['count'] : IWSL_Media_Optimizer::MAX_BATCH;
		$count = max( 1, min( IWSL_Media_Optimizer::MAX_REQUEST, $count ) );
		$mode  = ( isset( $_POST['mode'] ) && IWSL_Media_Optimizer::MODE_REPLACE === $_POST['mode'] )
			? IWSL_Media_Optimizer::MODE_REPLACE
			: IWSL_Media_Optimizer::MODE_COPY;
		$op         = isset( $_POST['op'] ) ? sanitize_key( wp_unslash( $_POST['op'] ) ) : 'run';
		$is_preview = 'preview' === $op;
		// Opt-in: rewrite the image URLs on posts/pages to the WebP (copy mode too).
		$rewrite = isset( $_POST['rewrite'] ) && '1' === (string) $_POST['rewrite'];

		// De-duplicate branch: delete originals that already have an optimized copy.
		// `dedupe-preview` is a safe dry run; `dedupe` deletes (repointing pages first).
		if ( 'dedupe' === $op || 'dedupe-preview' === $op ) {
			$summary = $optimizer->remove_optimized_duplicates( 'dedupe-preview' === $op, true, $count );
			if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
				set_transient( 'iwsl_mo_result_' . (int) get_current_user_id(), $summary, 60 );
			}
			wp_safe_redirect( $redirect );
			exit;
		}

		// Source-type filter: 'auto' (every accepted type) or one exact MIME,
		// validated against a closed list before it reaches the engine.
		$allowed_types = array( 'auto', 'image/png', 'image/jpeg', 'image/gif', 'image/bmp', 'image/tiff' );
		$types         = isset( $_POST['types'] ) ? sanitize_text_field( wp_unslash( $_POST['types'] ) ) : 'auto';
		if ( ! in_array( $types, $allowed_types, true ) ) {
			$types = 'auto';
		}

		// Optional explicit selection from the media-library picker. This is the
		// ONLY place an attachment id crosses the request boundary, and it is
		// treated as UNTRUSTED: the optimizer re-validates every id server-side
		// (real attachment + accepted MIME) before it is ever handed to
		// convert_one(), which itself still runs the full guard_source() gauntlet.
		// An empty list falls back to the existing count-driven auto-selection.
		$ids_raw = isset( $_POST['ids'] ) ? sanitize_text_field( wp_unslash( $_POST['ids'] ) ) : '';
		$ids     = array();
		if ( '' !== $ids_raw ) {
			$ids = array_map( 'intval', explode( ',', $ids_raw ) );
			$ids = array_values( array_unique( array_filter( $ids, static function ( $id ) {
				return $id > 0;
			} ) ) );
			$ids = array_slice( $ids, 0, IWSL_Media_Optimizer::MAX_REQUEST );
		}

		// LAYER 3 (authoritative gate) is inside run()/preview().
		$summary = $is_preview
			? $optimizer->preview( $converter, $count, $types, $ids )
			: $optimizer->run( $converter, $count, $mode, false, $types, $ids, $rewrite );

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_mo_result_' . (int) get_current_user_id(), $summary, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 3: SMTP Email Delivery & Log ───────────────────────────────────

	/**
	 * Render the email-delivery section (LAYER 1 of the gate), driven by the
	 * `email_delivery` flag. Locked → reasons only, no form and no log. Unlocked →
	 * settings form + per-user PRG result notice + the bounded email log + a
	 * clear-log button.
	 */
	private function render_email_delivery_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'SMTP Email Delivery & Log', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( "Route this site's outgoing mail through an SMTP server and keep a bounded local log of what was sent. Runs entirely on this server; the message body is never stored — only recipients and subjects are recorded.", 'infraweaver-connector' ) . '</p>';

		// A redirect from a handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_ed_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			self::toast_open( 'error' );
			echo '<p><strong>' . esc_html__( 'The Email Delivery entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p>';
			self::toast_close();
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate, 'Email Delivery', 'Email Delivery is part of the Pro plan. Turn on Pro for this site from your InfraWeaver dashboard.' );
			return;
		}

		$this->render_email_result_notice();
		$this->maybe_render_email_wizard();
		$this->render_email_settings_form();
		$this->render_email_test_form();
		$this->render_email_log_table();
	}

	/**
	 * The SMTP "Set up email in 3 steps" wizard — shown only when SMTP is not yet
	 * configured (no host, or a host with no usable password). Submits to the
	 * EXISTING EMAIL_SETTINGS_ACTION handler with the EXISTING field names; the
	 * password-storage opt-in (allow_option_password) is surfaced in the final
	 * step, never bypassed. The full settings form still renders below (no-JS safe).
	 */
	private function maybe_render_email_wizard(): void {
		$s        = $this->email_delivery()->settings_for_render();
		$host     = isset( $s['host'] ) ? (string) $s['host'] : '';
		$port     = isset( $s['port'] ) ? (int) $s['port'] : 0;
		$username = isset( $s['username'] ) ? (string) $s['username'] : '';
		$from     = isset( $s['from_email'] ) ? (string) $s['from_email'] : '';
		$fname    = isset( $s['from_name'] ) ? (string) $s['from_name'] : '';
		$secure   = isset( $s['secure'] ) ? (string) $s['secure'] : '';
		$auth     = ! empty( $s['auth'] );
		$has_pw   = ! empty( $s['has_password'] );
		$pw_src   = isset( $s['password_source'] ) ? (string) $s['password_source'] : 'none';
		$constant = ( 'constant' === $pw_src );

		// Configured = a host is set AND a password is available (stored or constant).
		$configured = ( '' !== $host ) && ( $has_pw || $constant );
		if ( $configured ) {
			return;
		}

		$mode_labels = array( '' => __( 'None', 'infraweaver-connector' ), 'ssl' => 'SSL', 'tls' => 'TLS' );

		$this->wizard_open(
			'smtp',
			__( 'Set up email in 3 steps', 'infraweaver-connector' ),
			array(
				'action' => self::EMAIL_SETTINGS_ACTION,
				'nonce'  => self::EMAIL_SETTINGS_NONCE,
				'icon'   => 'email',
				'submit' => __( 'Save SMTP settings', 'infraweaver-connector' ),
				'launch' => array(
					'heading' => __( 'Set up email in 3 steps', 'infraweaver-connector' ),
					'body'    => __( 'Make sure this site’s emails — password resets, order receipts, contact forms — actually reach inboxes. A short guided walk-through connects your email provider.', 'infraweaver-connector' ),
					'button'  => __( 'Set up email in 3 steps', 'infraweaver-connector' ),
				),
				'steps'  => array(
					array(
						'title' => __( 'What this does', 'infraweaver-connector' ),
						'body'  => static function (): void {
							echo '<p>' . esc_html__( 'Right now WordPress hands mail straight to your server, where it often lands in spam or vanishes. Routing it through a real email provider (SMTP) fixes that.', 'infraweaver-connector' ) . '</p>';
							echo '<p>' . esc_html__( 'You’ll need a few details from your email provider — usually shown on a page called “SMTP”, “Sending” or “Mail settings”. Have them open in another tab, then continue.', 'infraweaver-connector' ) . '</p>';
						},
					),
					array(
						'title' => __( 'Your email server', 'infraweaver-connector' ),
						'body'  => static function () use ( $host, $port, $secure, $auth, $username, $mode_labels ): void {
							echo '<p>' . esc_html__( 'Copy these from your provider exactly as shown.', 'infraweaver-connector' ) . '</p>';
							echo '<div class="iwsl-wz__fields">';
							self::wizard_field( 'text', 'host', __( 'SMTP host', 'infraweaver-connector' ), $host, 'smtp.example.com' );
							self::wizard_field( 'number', 'port', __( 'Port', 'infraweaver-connector' ), $port > 0 ? (string) $port : '', '587', array( 'min' => '1', 'max' => '65535' ) );
							echo '<label class="iwsl-wz__field"><span>' . esc_html__( 'Encryption', 'infraweaver-connector' ) . '</span><select name="secure">';
							foreach ( IWSL_Email_Delivery::SECURE_MODES as $mode ) {
								$label = isset( $mode_labels[ $mode ] ) ? $mode_labels[ $mode ] : $mode;
								echo '<option value="' . esc_attr( $mode ) . '"' . selected( $secure, $mode, false ) . '>' . esc_html( $label ) . '</option>';
							}
							echo '</select></label>';
							self::wizard_field( 'text', 'username', __( 'Username', 'infraweaver-connector' ), $username, 'you@example.com' );
							echo '</div>';
							self::wizard_checkbox( 'auth', __( 'My email service needs a login (usual)', 'infraweaver-connector' ), $auth );
						},
					),
					array(
						'title' => __( 'Sender & password', 'infraweaver-connector' ),
						'body'  => static function () use ( $from, $fname, $has_pw, $constant ): void {
							echo '<p>' . esc_html__( 'Who your mail appears to come from, and the account password.', 'infraweaver-connector' ) . '</p>';
							echo '<div class="iwsl-wz__fields">';
							self::wizard_field( 'text', 'from_email', __( 'From email', 'infraweaver-connector' ), $from, 'noreply@yourdomain.com' );
							self::wizard_field( 'text', 'from_name', __( 'From name', 'infraweaver-connector' ), $fname, get_bloginfo( 'name' ) );
							echo '<label class="iwsl-wz__field"><span>' . esc_html__( 'Password', 'infraweaver-connector' ) . '</span><input type="password" name="password" value="" autocomplete="new-password"' . ( $has_pw ? ' placeholder="****"' : '' ) . '></label>';
							echo '</div>';
							if ( $constant ) {
								echo '<p class="iwsl-wz__note">' . esc_html__( 'IWSL_SMTP_PASS is already defined in wp-config.php — that value is used and no database password is stored. You can leave the password blank.', 'infraweaver-connector' ) . '</p>';
							} else {
								self::wizard_checkbox(
									'allow_option_password',
									__( 'Store this password in the database (I understand the risk)', 'infraweaver-connector' ),
									false,
									__( 'Required to save a password here. For better security, set IWSL_SMTP_PASS in wp-config.php instead and leave this off.', 'infraweaver-connector' )
								);
							}
							echo '<p class="iwsl-wz__note">' . esc_html__( 'After saving, use “Send a test email” below to confirm delivery end-to-end.', 'infraweaver-connector' ) . '</p>';
						},
					),
				),
			)
		);
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_email_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_ed_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			if ( ! empty( $result['tested'] ) ) {
				$msg = esc_html( sprintf(
					/* translators: %s is the recipient email address. */
					__( 'Test email sent to %s. Check the inbox (and spam) — the result is in the log below.', 'infraweaver-connector' ),
					(string) ( $result['to'] ?? '' )
				) );
			} elseif ( ! empty( $result['cleared'] ) ) {
				$msg = esc_html__( 'Email log cleared.', 'infraweaver-connector' );
			} else {
				$msg = esc_html__( 'SMTP settings saved.', 'infraweaver-connector' );
			}
			self::toast_open( 'success' );
			echo '<p>' . $msg . '</p>';
			self::toast_close();
		} else {
			$reason = (string) ( $result['reason'] ?? 'unknown' );
			if ( 'invalid-recipient' === $reason ) {
				$err = esc_html__( 'Enter a valid recipient email address.', 'infraweaver-connector' );
			} elseif ( 'send-failed' === $reason ) {
				$err = esc_html__( 'Test send failed — check the SMTP settings above and the log below.', 'infraweaver-connector' );
			} elseif ( 'password-storage-not-allowed' === $reason ) {
				// The commonest confusing failure: a password was typed but the
				// opt-in to store it lives in the collapsed "Advanced settings".
				$err = esc_html__( 'To save a password, first open “Advanced settings” below and tick “Store password in the database”. For better security, set IWSL_SMTP_PASS in wp-config.php instead — then you don’t need to store a password here at all.', 'infraweaver-connector' );
			} elseif ( 'password-encryption-unavailable' === $reason ) {
				$err = esc_html__( 'The password could not be encrypted for storage on this server, so it was not saved. Set IWSL_SMTP_PASS in wp-config.php instead.', 'infraweaver-connector' );
			} elseif ( 'bad-password' === $reason ) {
				$err = esc_html__( 'That password contains a line break, which SMTP does not allow. Re-enter it without newlines.', 'infraweaver-connector' );
			} elseif ( 'entitlement-locked' === $reason ) {
				$err = esc_html__( 'Email delivery is not unlocked on this site’s plan. Upgrade from the InfraWeaver console to use it.', 'infraweaver-connector' );
			} else {
				$err = esc_html( sprintf(
					/* translators: %s is a short machine reason code. */
					__( 'Could not save: %s', 'infraweaver-connector' ),
					$reason
				) );
			}
			self::toast_open( 'error' );
			echo '<p>' . $err . '</p>';
			self::toast_close();
		}
	}

	/** The nonce-protected SMTP settings form (POST → admin-post.php). */
	private function render_email_settings_form(): void {
		$settings         = $this->email_delivery()->settings_for_render();
		$host             = isset( $settings['host'] ) ? (string) $settings['host'] : '';
		$port             = isset( $settings['port'] ) ? (int) $settings['port'] : 0;
		$username         = isset( $settings['username'] ) ? (string) $settings['username'] : '';
		$from_email       = isset( $settings['from_email'] ) ? (string) $settings['from_email'] : '';
		$from_name        = isset( $settings['from_name'] ) ? (string) $settings['from_name'] : '';
		$secure           = isset( $settings['secure'] ) ? (string) $settings['secure'] : '';
		$auth             = ! empty( $settings['auth'] );
		$allow_password   = ! empty( $settings['allow_option_password'] );
		$has_password     = ! empty( $settings['has_password'] );
		$password_source  = isset( $settings['password_source'] ) ? (string) $settings['password_source'] : 'none';
		$constant_defined = ( 'constant' === $password_source );

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::EMAIL_SETTINGS_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::EMAIL_SETTINGS_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-ed-host">' . esc_html__( 'SMTP Host', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The address of your email-sending service (from your provider).' ) . '</th>';
		echo '<td><input type="text" id="iwsl-ed-host" name="host" class="regular-text" value="' . esc_attr( $host ) . '"></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-port">' . esc_html__( 'Port', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The connection number your email provider tells you to use.' ) . '</th>';
		echo '<td><input type="number" id="iwsl-ed-port" name="port" min="1" max="65535" value="' . esc_attr( $port > 0 ? (string) $port : '' ) . '"></td></tr>';

		$mode_labels = array(
			''    => esc_html__( 'None', 'infraweaver-connector' ),
			'ssl' => 'SSL',
			'tls' => 'TLS',
		);
		echo '<tr><th scope="row"><label for="iwsl-ed-secure">' . esc_html__( 'Encryption', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'How the connection is secured — use what your provider says.' ) . '</th><td>';
		echo '<select id="iwsl-ed-secure" name="secure">';
		foreach ( IWSL_Email_Delivery::SECURE_MODES as $mode ) {
			$label = isset( $mode_labels[ $mode ] ) ? $mode_labels[ $mode ] : $mode;
			echo '<option value="' . esc_attr( $mode ) . '"' . selected( $secure, $mode, false ) . '>' . esc_html( $label ) . '</option>';
		}
		echo '</select></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Authentication', 'infraweaver-connector' ) . iwsl_field_help( 'Turn on if your email service needs a login.' ) . '</th><td>';
		echo '<label><input type="checkbox" name="auth" value="1"' . checked( $auth, true, false ) . '> ' . esc_html__( 'Server requires authentication', 'infraweaver-connector' ) . '</label></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-username">' . esc_html__( 'Username', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The login name for your email-sending account.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-ed-username" name="username" class="regular-text" value="' . esc_attr( $username ) . '"></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-from-email">' . esc_html__( 'From email', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The email address your site’s messages appear to come from.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-ed-from-email" name="from_email" class="regular-text" value="' . esc_attr( $from_email ) . '">';
		echo '<p class="description">' . esc_html__( 'The address mail is sent AS. Leave blank to use the SMTP username. Strict providers (Office 365, Gmail) require this to be an address your account may send as — e.g. noreply@yourdomain.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-from-name">' . esc_html__( 'From name', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The sender name people see on your site’s emails.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-ed-from-name" name="from_name" class="regular-text" value="' . esc_attr( $from_name ) . '">';
		echo '<p class="description">' . esc_html__( 'Optional display name; defaults to the site name.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-ed-password">' . esc_html__( 'Password', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The password for your email-sending account.' ) . '</th><td>';
		$placeholder = $has_password ? '****' : '';
		echo '<input type="password" id="iwsl-ed-password" name="password" class="regular-text" value="" placeholder="' . esc_attr( $placeholder ) . '" autocomplete="new-password">';
		echo '<p class="description">' . esc_html__( 'Leave blank to keep the current password. Prefer defining IWSL_SMTP_PASS in wp-config.php to keep the secret out of the database.', 'infraweaver-connector' ) . '</p>';
		if ( $constant_defined ) {
			echo '<p class="description"><strong>' . esc_html__( 'IWSL_SMTP_PASS is defined in wp-config.php — that value is used and no database password is stored.', 'infraweaver-connector' ) . '</strong></p>';
		}
		echo '</td></tr>';

		echo '</tbody></table>';

		// Power-user knob only — all SMTP credentials above stay visible. Storing
		// the secret in the database is opt-in and risky, so it lives in Advanced.
		echo '<details class="iwsl-adv" id="iwsl-ed-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row">' . esc_html__( 'Password storage', 'infraweaver-connector' ) . iwsl_field_help( 'Save the email password in the database (less secure).' ) . '</th><td>';
		$disabled = $constant_defined ? ' disabled' : '';
		echo '<label><input type="checkbox" id="iwsl-ed-allow-password" name="allow_option_password" value="1"' . checked( $allow_password, true, false ) . $disabled . '> ' . esc_html__( 'Store password in the database (I understand the risk)', 'infraweaver-connector' ) . '</label>';
		echo '<p class="description iwsl-ed-pw-hint" id="iwsl-ed-pw-hint" hidden style="color:var(--iw-bad,#c0392b);">' . esc_html__( 'You entered a password above. To save it here, tick this box — or cancel and set IWSL_SMTP_PASS in wp-config.php for better security.', 'infraweaver-connector' ) . '</p>';
		if ( $constant_defined ) {
			echo '<p class="description">' . esc_html__( 'Disabled because IWSL_SMTP_PASS is defined in wp-config.php.', 'infraweaver-connector' ) . '</p>';
		}
		echo '</td></tr>';
		echo '</tbody></table>';
		echo '</div></details>';

		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Save SMTP settings', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';

		// Pre-submit nudge: if a password was typed but the "store in database"
		// opt-in (buried in Advanced) is unticked, the server would reject with an
		// opaque reason. Catch it in-context first — reveal Advanced, point at the
		// checkbox, and let the operator confirm or clear the field. No constant →
		// only fires when a real choice is needed. The server gate still enforces.
		if ( ! $constant_defined ) {
			echo '<script>(function(){'
				. 'var f=document.getElementById("iwsl-ed-adv");if(!f)return;'
				. 'var form=f.closest("form");if(!form)return;'
				. 'var pw=form.querySelector("#iwsl-ed-password"),ok=form.querySelector("#iwsl-ed-allow-password"),hint=form.querySelector("#iwsl-ed-pw-hint");'
				. 'if(!pw||!ok)return;'
				. 'form.addEventListener("submit",function(e){'
				. 'if(pw.value!==""&&!ok.checked){e.preventDefault();f.open=true;if(hint)hint.hidden=false;'
				. 'ok.focus();ok.scrollIntoView({block:"center"});}'
				. '});'
				. 'ok.addEventListener("change",function(){if(ok.checked&&hint)hint.hidden=true;});'
				. '})();</script>';
		}
	}

	/** A send-a-test-email form so the operator can verify SMTP end-to-end. */
	private function render_email_test_form(): void {
		$default = '';
		if ( function_exists( 'wp_get_current_user' ) ) {
			$user = wp_get_current_user();
			if ( $user && isset( $user->user_email ) ) {
				$default = (string) $user->user_email;
			}
		}
		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Send a test email', 'infraweaver-connector' ) . '</h3>';
		echo '<p class="description" style="margin-bottom:8px;">' . esc_html__( 'Sends a real message through the SMTP settings above so you can confirm delivery. The outcome is recorded in the log below.', 'infraweaver-connector' ) . '</p>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="max-width:640px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">';
		wp_nonce_field( self::EMAIL_TEST_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::EMAIL_TEST_ACTION ) . '">';
		echo '<input type="email" name="test_to" class="regular-text" value="' . esc_attr( $default ) . '" placeholder="you@example.com" required style="flex:1;min-width:220px;">';
		echo '<button type="submit" class="button">' . esc_html__( 'Send test email', 'infraweaver-connector' ) . '</button>';
		echo '</form>';
	}

	/**
	 * admin-post handler for the SMTP test send. Same gate discipline as the
	 * other email actions: capability + nonce + re-checked entitlement, then a
	 * validated recipient and a plain wp_mail() (routed through the configured
	 * SMTP by the registered phpmailer_init hook). PRG via the shared transient.
	 */
	public function handle_email_test(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::EMAIL_TEST_NONCE );
		$redirect = iwsl_plus_redirect_base();

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_ed_locked', '1', $redirect ) );
			exit;
		}

		$to = isset( $_POST['test_to'] ) ? sanitize_email( wp_unslash( $_POST['test_to'] ) ) : '';
		if ( '' === $to || ( function_exists( 'is_email' ) && ! is_email( $to ) ) ) {
			$this->stash_email_result( array( 'ok' => false, 'reason' => 'invalid-recipient' ) );
			wp_safe_redirect( $redirect );
			exit;
		}

		$subject = 'InfraWeaver SMTP test';
		$body    = "This is a test email from the InfraWeaver Connector, sent to verify your SMTP settings.\n\nIf you received it, outgoing mail is working.";
		$sent    = function_exists( 'wp_mail' ) ? (bool) wp_mail( $to, $subject, $body ) : false;

		$this->stash_email_result(
			$sent
				? array( 'ok' => true, 'tested' => true, 'to' => $to )
				: array( 'ok' => false, 'reason' => 'send-failed' )
		);
		wp_safe_redirect( $redirect );
		exit;
	}

	/** Stash a per-user PRG result for the email section's result notice. */
	private function stash_email_result( array $result ): void {
		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_ed_result_' . (int) get_current_user_id(), $result, 60 );
		}
	}

	/** The bounded email log table + the nonce-protected clear-log form. */
	private function render_email_log_table(): void {
		$log = $this->email_delivery()->log();

		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Email log', 'infraweaver-connector' ) . '</h3>';

		if ( array() === $log ) {
			echo '<p>' . esc_html__( 'No email activity recorded yet.', 'infraweaver-connector' ) . '</p>';
		} else {
			echo '<table class="widefat striped" style="max-width:900px;"><thead><tr>';
			echo '<th>' . esc_html__( 'Time', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'To', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Subject', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Status', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Detail', 'infraweaver-connector' ) . '</th>';
			echo '</tr></thead><tbody>';
			foreach ( array_reverse( $log ) as $entry ) {
				$at      = isset( $entry['at'] ) ? (int) $entry['at'] : 0;
				$time    = $at > 0 ? self::format_time( $at ) : '';
				$to      = ( isset( $entry['to'] ) && is_array( $entry['to'] ) ) ? implode( ', ', array_map( 'strval', $entry['to'] ) ) : '';
				$subject = isset( $entry['subject'] ) ? (string) $entry['subject'] : '';
				$type    = isset( $entry['type'] ) ? (string) $entry['type'] : '';
				$detail  = isset( $entry['error'] ) ? (string) $entry['error'] : '';
				$marker  = ( 'sent' === $type )
					? '<span style="color:#1a7f37;font-weight:600;">&#10004; sent</span>'
					: '<span style="color:#b3261e;font-weight:600;">&#10008; failed</span>';
				echo '<tr>';
				echo '<td>' . esc_html( $time ) . '</td>';
				echo '<td>' . esc_html( $to ) . '</td>';
				echo '<td>' . esc_html( $subject ) . '</td>';
				echo '<td>' . $marker . '</td>';
				echo '<td>' . esc_html( $detail ) . '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:12px;">';
		wp_nonce_field( self::EMAIL_LOG_CLEAR_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::EMAIL_LOG_CLEAR_ACTION ) . '">';
		echo '<button type="submit" class="button">' . esc_html__( 'Clear log', 'infraweaver-connector' ) . '</button>';
		echo '</form>';
	}

	/** Format a unix-second stamp with the site's date/time format (UTC fallback). */
	private static function format_time( int $unix ): string {
		if ( function_exists( 'wp_date' ) && function_exists( 'get_option' ) ) {
			$fmt = (string) get_option( 'date_format', 'Y-m-d' ) . ' ' . (string) get_option( 'time_format', 'H:i' );
			$out = wp_date( $fmt, $unix );
			if ( is_string( $out ) ) {
				return $out;
			}
		}
		return gmdate( 'Y-m-d H:i', $unix );
	}

	/**
	 * admin-post handler for the SMTP settings save. LAYER 2 of the gate: capability
	 * + nonce, then re-check the entitlement before doing any work, then
	 * save_settings() (whose first statement is the authoritative LAYER 3 gate).
	 * The password field is passed through unsanitized (only unslashed) so the exact
	 * secret is preserved; the engine validates it. POST-redirect-GET.
	 */
	public function handle_email_settings_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::EMAIL_SETTINGS_NONCE );

		$redirect = iwsl_plus_redirect_base();

		// LAYER 2: re-check the gate before touching any stored setting.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_ed_locked', '1', $redirect ) );
			exit;
		}

		$input = array(
			'host'                  => isset( $_POST['host'] ) ? sanitize_text_field( wp_unslash( $_POST['host'] ) ) : '',
			'port'                  => isset( $_POST['port'] ) ? absint( wp_unslash( $_POST['port'] ) ) : 0,
			'secure'                => isset( $_POST['secure'] ) ? sanitize_text_field( wp_unslash( $_POST['secure'] ) ) : '',
			'auth'                  => isset( $_POST['auth'] ),
			'username'              => isset( $_POST['username'] ) ? sanitize_text_field( wp_unslash( $_POST['username'] ) ) : '',
			'from_email'            => isset( $_POST['from_email'] ) ? sanitize_text_field( wp_unslash( $_POST['from_email'] ) ) : '',
			'from_name'             => isset( $_POST['from_name'] ) ? sanitize_text_field( wp_unslash( $_POST['from_name'] ) ) : '',
			// Password is the ONE field we must not sanitize (that would alter the
			// secret) — unslash only; save_settings() validates + policy-gates it.
			'password'              => isset( $_POST['password'] ) ? (string) wp_unslash( $_POST['password'] ) : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			'allow_option_password' => isset( $_POST['allow_option_password'] ),
		);

		$result = $this->email_delivery()->save_settings( $input ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_ed_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler for clearing the email log. Same LAYER 2 skeleton
	 * (capability + nonce + gate re-check), then clear_log() (LAYER 3 inside). PRG.
	 */
	public function handle_email_log_clear(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::EMAIL_LOG_CLEAR_NONCE );

		$redirect = iwsl_plus_redirect_base();

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Email_Delivery::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_ed_locked', '1', $redirect ) );
			exit;
		}

		$result = $this->email_delivery()->clear_log(); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_ed_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 4: 301 Redirect Manager ────────────────────────────────────────

	/**
	 * Render the redirect-manager section (LAYER 1 of the gate), driven by the
	 * `redirect_manager` flag. Locked → reasons only, no forms and no tables.
	 * Unlocked → per-user PRG result notice + rules table + add-rule form + the
	 * bounded 404 log with its toggle.
	 */
	private function render_redirects_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( '301 Redirect Manager', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Send visitors from old URLs to new ones with permanent (301) or temporary (302) redirects — evaluated entirely on this server.', 'infraweaver-connector' ) . '</p>';

		// A redirect from a handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_rd_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			self::toast_open( 'error' );
			echo '<p><strong>' . esc_html__( 'The Redirect Manager entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p>';
			self::toast_close();
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate, 'Redirect Manager', 'The Redirect Manager is part of the Pro plan. Turn on Pro for this site from your InfraWeaver dashboard.' );
			return;
		}

		$this->render_redirects_result_notice();
		$this->render_redirects_table();
		$this->render_redirects_add_form();

		// The 404 log + its logging toggle are secondary extras — the rules table
		// and add form above stay visible; only the log is progressively disclosed.
		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		$this->render_redirects_auto_toggle();
		$this->render_redirects_404_log();
		echo '</div></details>';
	}

	/**
	 * The auto-redirect-on-slug-change toggle. When on (the default), renaming a
	 * published post/page auto-creates a 301 from its old URL to the new one — so
	 * links and search results never land on a 404 after a rename. More automated
	 * than Yoast (which hides this behind a Premium setting the owner must find).
	 */
	private function render_redirects_auto_toggle(): void {
		$enabled = $this->redirects()->is_auto_redirect_enabled();

		echo '<h3 style="margin-top:8px;">' . esc_html__( 'Automatic redirects', 'infraweaver-connector' ) . '</h3>';
		echo '<p class="description" style="margin-bottom:8px;">' . esc_html__( 'Rename a published page and we create the 301 for you — no broken links, no manual rule.', 'infraweaver-connector' ) . '</p>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( self::REDIRECT_AUTO_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::REDIRECT_AUTO_ACTION ) . '">';
		echo '<input type="hidden" name="enabled" value="' . esc_attr( $enabled ? '0' : '1' ) . '">';
		$label = $enabled
			? esc_html__( 'Disable auto-redirect on slug change', 'infraweaver-connector' )
			: esc_html__( 'Enable auto-redirect on slug change', 'infraweaver-connector' );
		echo '<button type="submit" class="button">' . $label . '</button>';
		echo ' <span class="description">' . ( $enabled
			? esc_html__( 'On — renaming a published post auto-creates a 301.', 'infraweaver-connector' )
			: esc_html__( 'Off.', 'infraweaver-connector' ) ) . '</span>';
		echo '</form>';
	}

	/**
	 * admin-post handler: flip the auto-redirect-on-slug-change setting. LAYER 2
	 * of the gate (capability + nonce + entitlement re-check); set_auto_redirect()
	 * is LAYER 3. POST-redirect-GET back to the section the form was submitted from.
	 */
	public function handle_redirects_auto(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::REDIRECT_AUTO_NONCE );

		$redirect = iwsl_plus_redirect_base();
		$gate     = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_rd_locked', '1', $redirect ) );
			exit;
		}

		$enabled = isset( $_POST['enabled'] ) && '1' === (string) $_POST['enabled'];
		$this->redirects()->set_auto_redirect( $enabled ); // LAYER 3 inside.
		wp_safe_redirect( $redirect );
		exit;
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_redirects_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_rd_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			if ( ! empty( $result['deleted'] ) ) {
				$msg = esc_html__( 'Rule deleted.', 'infraweaver-connector' );
			} elseif ( array_key_exists( 'enabled', $result ) ) {
				$msg = esc_html__( '404 logging preference saved.', 'infraweaver-connector' );
			} else {
				$msg = esc_html__( 'Rule saved.', 'infraweaver-connector' );
			}
			self::toast_open( 'success' );
			echo '<p>' . $msg . '</p>';
			self::toast_close();
		} else {
			self::toast_open( 'error' );
			echo '<p>' . esc_html( sprintf( 'Rule refused: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p>';
			self::toast_close();
		}
	}

	/** The rules table — targets rendered as PLAIN TEXT, each with an inline delete form. */
	private function render_redirects_table(): void {
		$rules = $this->redirects()->rules();
		$count = count( $rules );

		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Redirects', 'infraweaver-connector' ) . '</h3>';

		if ( array() === $rules ) {
			echo '<p>' . esc_html__( 'No redirects defined yet.', 'infraweaver-connector' ) . '</p>';
		} else {
			echo '<table class="widefat striped" style="max-width:900px;"><thead><tr>';
			echo '<th>' . esc_html__( 'Source', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Target', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Type', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Hits', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Action', 'infraweaver-connector' ) . '</th>';
			echo '</tr></thead><tbody>';
			foreach ( $rules as $rule ) {
				$source = isset( $rule['source'] ) ? (string) $rule['source'] : '';
				$target = isset( $rule['target'] ) ? (string) $rule['target'] : '';
				$type   = isset( $rule['type'] ) ? (int) $rule['type'] : 301;
				$hits   = isset( $rule['hits'] ) ? (int) $rule['hits'] : 0;
				$id     = isset( $rule['id'] ) ? (string) $rule['id'] : '';
				echo '<tr>';
				echo '<td>' . esc_html( $source ) . '</td>';
				// Target is plain text, never an anchor — an admin page must not
				// link to an arbitrary stored URL.
				echo '<td>' . esc_html( $target ) . '</td>';
				echo '<td>' . esc_html( (string) $type ) . '</td>';
				echo '<td>' . esc_html( (string) $hits ) . '</td>';
				echo '<td>';
				echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin:0;">';
				wp_nonce_field( self::REDIRECT_DELETE_NONCE );
				echo '<input type="hidden" name="action" value="' . esc_attr( self::REDIRECT_DELETE_ACTION ) . '">';
				echo '<input type="hidden" name="rule_id" value="' . esc_attr( $id ) . '">';
				echo '<button type="submit" class="button button-link-delete">' . esc_html__( 'Delete', 'infraweaver-connector' ) . '</button>';
				echo '</form>';
				echo '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
		}

		echo '<p class="description">' . esc_html( sprintf( '%d of %d rules used.', $count, IWSL_Redirects::MAX_RULES ) ) . '</p>';
	}

	/** The nonce-protected add-rule form (POST → admin-post.php). */
	private function render_redirects_add_form(): void {
		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Add redirect', 'infraweaver-connector' ) . '</h3>';
		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px;max-width:640px;">';
		wp_nonce_field( self::REDIRECT_ADD_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::REDIRECT_ADD_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';
		echo '<tr><th scope="row"><label for="iwsl-rd-source">' . esc_html__( 'Source path', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The old web address you want to send visitors away from.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-rd-source" name="source" class="regular-text" placeholder="/old-page" value=""></td></tr>';
		echo '<tr><th scope="row"><label for="iwsl-rd-target">' . esc_html__( 'Target', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The new web address visitors should land on instead.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-rd-target" name="target" class="regular-text" placeholder="' . esc_attr__( '/new-page or https://…', 'infraweaver-connector' ) . '" value=""></td></tr>';
		echo '<tr><th scope="row"><label for="iwsl-rd-type">' . esc_html__( 'Type', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'Permanent moves for good; temporary is just for now.' ) . '</th><td>';
		echo '<select id="iwsl-rd-type" name="type">';
		echo '<option value="301">' . esc_html__( '301 (permanent)', 'infraweaver-connector' ) . '</option>';
		echo '<option value="302">' . esc_html__( '302 (temporary)', 'infraweaver-connector' ) . '</option>';
		echo '</select></td></tr>';
		echo '</tbody></table>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Add redirect', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	/** The 404-logging toggle + the bounded 404 log table. */
	private function render_redirects_404_log(): void {
		$enabled = $this->redirects()->is_404_logging_enabled();
		$log     = $this->redirects()->log_entries();

		echo '<h3 style="margin-top:24px;">' . esc_html__( '404 log', 'infraweaver-connector' ) . '</h3>';

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:8px;">';
		wp_nonce_field( self::REDIRECT_LOG_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::REDIRECT_LOG_ACTION ) . '">';
		echo '<input type="hidden" name="enabled" value="' . esc_attr( $enabled ? '0' : '1' ) . '">';
		$label = $enabled
			? esc_html__( 'Disable 404 logging', 'infraweaver-connector' )
			: esc_html__( 'Enable 404 logging', 'infraweaver-connector' );
		echo '<button type="submit" class="button">' . $label . '</button>';
		echo ' <span class="description">' . ( $enabled ? esc_html__( 'Logging is on.', 'infraweaver-connector' ) : esc_html__( 'Logging is off.', 'infraweaver-connector' ) ) . '</span>';
		echo '</form>';

		if ( array() === $log ) {
			echo '<p>' . esc_html__( 'No not-found paths recorded yet.', 'infraweaver-connector' ) . '</p>';
		} else {
			echo '<table class="widefat striped" style="max-width:720px;margin-top:12px;"><thead><tr>';
			echo '<th>' . esc_html__( 'Path', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Count', 'infraweaver-connector' ) . '</th>';
			echo '<th>' . esc_html__( 'Last seen', 'infraweaver-connector' ) . '</th>';
			echo '</tr></thead><tbody>';
			foreach ( array_reverse( $log ) as $entry ) {
				$path      = isset( $entry['path'] ) ? (string) $entry['path'] : '';
				$entry_cnt = isset( $entry['count'] ) ? (int) $entry['count'] : 0;
				$last_seen = isset( $entry['last_seen'] ) ? (int) $entry['last_seen'] : 0;
				$time      = $last_seen > 0 ? self::format_time( $last_seen ) : '';
				echo '<tr>';
				echo '<td>' . esc_html( $path ) . '</td>';
				echo '<td>' . esc_html( (string) $entry_cnt ) . '</td>';
				echo '<td>' . esc_html( $time ) . '</td>';
				echo '</tr>';
			}
			echo '</tbody></table>';
		}

		echo '<p class="description">' . esc_html( sprintf( 'Logs at most %d recent not-found paths.', IWSL_Redirects::MAX_404_LOG ) ) . '</p>';
	}

	/**
	 * admin-post handler: add a rule. LAYER 2 of the gate (capability + nonce +
	 * gate re-check), then add_rule() (LAYER 3 inside). Source/target cross the
	 * boundary ONLY into the validators — never sanitize_text_field, which would
	 * mangle URLs; the engine's validators are stricter. POST-redirect-GET.
	 */
	public function handle_redirects_add(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::REDIRECT_ADD_NONCE );

		$redirect = iwsl_plus_redirect_base();

		// LAYER 2: re-check the gate before touching any stored rule.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_rd_locked', '1', $redirect ) );
			exit;
		}

		$source = isset( $_POST['source'] ) ? (string) wp_unslash( $_POST['source'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$target = isset( $_POST['target'] ) ? (string) wp_unslash( $_POST['target'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$type   = isset( $_POST['type'] ) ? (int) $_POST['type'] : 301;

		$result = $this->redirects()->add_rule( $source, $target, $type ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_rd_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler: delete a rule. Same LAYER 2 skeleton, then delete_rule()
	 * (LAYER 3 inside). The rule id is sanitize_key'd and re-validated against
	 * RULE_ID_RE inside the engine. POST-redirect-GET.
	 */
	public function handle_redirects_delete(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::REDIRECT_DELETE_NONCE );

		$redirect = iwsl_plus_redirect_base();

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_rd_locked', '1', $redirect ) );
			exit;
		}

		$rule_id = isset( $_POST['rule_id'] ) ? sanitize_key( wp_unslash( $_POST['rule_id'] ) ) : '';
		$result  = $this->redirects()->delete_rule( $rule_id ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_rd_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler: toggle 404 logging. Same LAYER 2 skeleton, then
	 * set_404_logging() (LAYER 3 inside). POST-redirect-GET.
	 */
	public function handle_redirects_log(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::REDIRECT_LOG_NONCE );

		$redirect = iwsl_plus_redirect_base();

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Redirects::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_rd_locked', '1', $redirect ) );
			exit;
		}

		$enabled = ! empty( $_POST['enabled'] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$result  = $this->redirects()->set_404_logging( $enabled ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_rd_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 5: Custom Login & Admin White-Label ────────────────────────────

	/**
	 * Render the white-label section (LAYER 1 of the gate), driven by the
	 * `white_label` flag. Locked → reasons only, no form. Unlocked → per-user PRG
	 * result notice + the surface/hook capability table + the settings form. The
	 * behavior itself is applied by IWSL_White_Label's passive login/admin hooks
	 * (wired unconditionally in the plugin bootstrap); this page only edits settings.
	 */
	private function render_white_label_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_White_Label::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Custom Login & Admin White-Label', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Replace the WordPress login logo, header link, login message, and admin footer credit with your own brand — applied entirely on this server. Revoking the entitlement instantly restores the default WordPress chrome.', 'infraweaver-connector' ) . '</p>';

		// A redirect from the handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_wl_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			self::toast_open( 'error' );
			echo '<p><strong>' . esc_html__( 'The White-Label entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p>';
			self::toast_close();
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate, 'White-Label', 'White-Label is part of the Ultimate plan. Turn on Ultimate for this site from your InfraWeaver dashboard.' );
			return;
		}

		$this->render_white_label_result_notice();
		$this->maybe_render_white_label_wizard();
		$this->render_white_label_capability_table();
		$this->render_white_label_form();
	}

	/**
	 * The White-Label "brand your login & admin" wizard — shown only when the
	 * feature has never been saved (settings_for_render()['saved_at'] === 0).
	 * Submits to the EXISTING WHITE_LABEL_ACTION handler with the EXISTING field
	 * names. The full settings form still renders below (no-JS safe).
	 */
	private function maybe_render_white_label_wizard(): void {
		$s = $this->white_label()->settings_for_render();
		if ( ! empty( $s['saved_at'] ) ) {
			return; // already configured — the wizard would be noise.
		}
		$logo    = isset( $s['login_logo_url'] ) ? (string) $s['login_logo_url'] : '';
		$link    = isset( $s['login_header_url'] ) ? (string) $s['login_header_url'] : '';
		$message = isset( $s['login_message'] ) ? (string) $s['login_message'] : '';
		$footer  = isset( $s['admin_footer_text'] ) ? (string) $s['admin_footer_text'] : '';
		$hide    = ! empty( $s['hide_wp_logo'] );

		$this->wizard_open(
			'whitelabel',
			__( 'Brand your login & admin — guided setup', 'infraweaver-connector' ),
			array(
				'action' => self::WHITE_LABEL_ACTION,
				'nonce'  => self::WHITE_LABEL_NONCE,
				'icon'   => 'admin-appearance',
				'submit' => __( 'Save white-label settings', 'infraweaver-connector' ),
				'launch' => array(
					'heading' => __( 'Put your own brand on the login & admin', 'infraweaver-connector' ),
					'body'    => __( 'Replace the WordPress logo and footer credit with your own on the login screen and dashboard. A short guided walk-through gets the essentials set.', 'infraweaver-connector' ),
					'button'  => __( 'Brand it in 3 steps', 'infraweaver-connector' ),
				),
				'steps'  => array(
					array(
						'title' => __( 'What this does', 'infraweaver-connector' ),
						'body'  => static function (): void {
							echo '<p>' . esc_html__( 'Your login page and dashboard footer show WordPress branding by default. This swaps in your own logo, link and credit — applied entirely on this server.', 'infraweaver-connector' ) . '</p>';
							echo '<p>' . esc_html__( 'Nothing here is permanent: clearing a field, or losing the entitlement, restores the default WordPress chrome instantly.', 'infraweaver-connector' ) . '</p>';
						},
					),
					array(
						'title' => __( 'Your login logo', 'infraweaver-connector' ),
						'body'  => static function () use ( $logo, $link ): void {
							echo '<p>' . esc_html__( 'Point to your logo image and where clicking it should go. Leave blank to keep the WordPress defaults.', 'infraweaver-connector' ) . '</p>';
							echo '<div class="iwsl-wz__fields">';
							self::wizard_field( 'text', 'login_logo_url', __( 'Login logo URL', 'infraweaver-connector' ), $logo, '/wp-content/uploads/brand/logo.png' );
							self::wizard_field( 'text', 'login_header_url', __( 'Logo link URL', 'infraweaver-connector' ), $link, 'https://example.com' );
							echo '</div>';
						},
					),
					array(
						'title' => __( 'Message & footer', 'infraweaver-connector' ),
						'body'  => static function () use ( $message, $footer, $hide ): void {
							echo '<p>' . esc_html__( 'Optional finishing touches. All of these can be changed later on this page.', 'infraweaver-connector' ) . '</p>';
							echo '<div class="iwsl-wz__fields">';
							self::wizard_textarea( 'login_message', __( 'Login message', 'infraweaver-connector' ), $message, __( 'Welcome back — please sign in.', 'infraweaver-connector' ), 2 );
							self::wizard_field( 'text', 'admin_footer_text', __( 'Admin footer credit', 'infraweaver-connector' ), $footer, get_bloginfo( 'name' ) );
							echo '</div>';
							self::wizard_checkbox( 'hide_wp_logo', __( 'Remove the WordPress logo from the admin bar', 'infraweaver-connector' ), $hide );
						},
					),
				),
			)
		);
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_white_label_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_wl_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			self::toast_open( 'success' );
			echo '<p>' . esc_html__( 'White-label settings saved.', 'infraweaver-connector' ) . '</p>';
			self::toast_close();
		} else {
			self::toast_open( 'error' );
			echo '<p>' . esc_html( sprintf( 'Could not save: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p>';
			self::toast_close();
		}
	}

	/** Surface → WordPress-hooks capability table (one row per registered surface). */
	private function render_white_label_capability_table(): void {
		$caps = $this->white_label()->capabilities();
		echo '<table class="widefat striped" style="max-width:720px;margin-top:12px;"><thead><tr>';
		echo '<th>' . esc_html__( 'Surface', 'infraweaver-connector' ) . '</th><th>' . esc_html__( 'WordPress hooks', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $caps as $cap ) {
			$hooks = implode( ', ', array_map( 'strval', (array) $cap['hooks'] ) );
			echo '<tr><th scope="row">' . esc_html( (string) $cap['label'] ) . '</th><td><code>' . esc_html( $hooks ) . '</code></td></tr>';
		}
		echo '</tbody></table>';
	}

	/** The nonce-protected white-label settings form (POST → admin-post.php). */
	private function render_white_label_form(): void {
		$settings = $this->white_label()->settings_for_render();
		$logo     = isset( $settings['login_logo_url'] ) ? (string) $settings['login_logo_url'] : '';
		$hdr_url  = isset( $settings['login_header_url'] ) ? (string) $settings['login_header_url'] : '';
		$hdr_text = isset( $settings['login_header_text'] ) ? (string) $settings['login_header_text'] : '';
		$message  = isset( $settings['login_message'] ) ? (string) $settings['login_message'] : '';
		$footer   = isset( $settings['admin_footer_text'] ) ? (string) $settings['admin_footer_text'] : '';
		$hide     = ! empty( $settings['hide_wp_logo'] );

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::WHITE_LABEL_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::WHITE_LABEL_ACTION ) . '">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-wl-logo">' . esc_html__( 'Login logo URL', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'A link to your own logo for the login screen.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-wl-logo" name="login_logo_url" class="regular-text" value="' . esc_attr( $logo ) . '" placeholder="/wp-content/uploads/brand/logo.png">';
		echo '<p class="description">' . esc_html__( 'A same-site path or https URL to your logo image. Leave blank for the WordPress logo.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-wl-hdr-url">' . esc_html__( 'Logo link URL', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'Where clicking the login logo takes people.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-wl-hdr-url" name="login_header_url" class="regular-text" value="' . esc_attr( $hdr_url ) . '" placeholder="https://example.com">';
		echo '<p class="description">' . esc_html__( 'Where the login logo links to. Leave blank for your site home.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-wl-hdr-text">' . esc_html__( 'Logo link text', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'The hidden text describing where the logo links.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-wl-hdr-text" name="login_header_text" class="regular-text" value="' . esc_attr( $hdr_text ) . '"></td></tr>';

		echo '<tr><th scope="row"><label for="iwsl-wl-message">' . esc_html__( 'Login message', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'A short note shown above the login form.' ) . '</th>';
		echo '<td><textarea id="iwsl-wl-message" name="login_message" class="large-text" rows="2">' . esc_textarea( $message ) . '</textarea>';
		echo '<p class="description">' . esc_html__( 'Shown above the login form. Plain text only.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '</tbody></table>';

		// Advanced: optional admin-chrome extras beyond the core login branding.
		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<table class="form-table" role="presentation"><tbody>';

		echo '<tr><th scope="row"><label for="iwsl-wl-footer">' . esc_html__( 'Admin footer text', 'infraweaver-connector' ) . '</label>' . iwsl_field_help( 'Your own text for the dashboard footer credit.' ) . '</th>';
		echo '<td><input type="text" id="iwsl-wl-footer" name="admin_footer_text" class="regular-text" value="' . esc_attr( $footer ) . '">';
		echo '<p class="description">' . esc_html__( 'Replaces the "Thank you for creating with WordPress" credit.', 'infraweaver-connector' ) . '</p></td></tr>';

		echo '<tr><th scope="row">' . esc_html__( 'Admin bar', 'infraweaver-connector' ) . iwsl_field_help( 'Hide the WordPress logo from the top admin bar.' ) . '</th><td>';
		echo '<label><input type="checkbox" name="hide_wp_logo" value="1"' . checked( $hide, true, false ) . '> ' . esc_html__( 'Remove the WordPress logo from the admin bar', 'infraweaver-connector' ) . '</label></td></tr>';

		echo '</tbody></table>';
		echo '</div></details>';
		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Save white-label settings', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
	}

	/**
	 * admin-post handler for the white-label settings save. LAYER 2 of the gate:
	 * capability + nonce, then re-check the entitlement before doing any work, then
	 * save_settings() (whose first statement is the authoritative LAYER 3 gate). URL
	 * fields are unslashed only (sanitize_text_field would mangle them — the engine's
	 * URL gauntlet validates them); text fields are sanitized. POST-redirect-GET.
	 */
	public function handle_white_label_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::WHITE_LABEL_NONCE );

		$redirect = iwsl_plus_redirect_base();

		// LAYER 2: re-check the gate before touching any stored setting.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_White_Label::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_wl_locked', '1', $redirect ) );
			exit;
		}

		$input = array(
			// URLs: unslash only — the engine's URL gauntlet validates them.
			'login_logo_url'    => isset( $_POST['login_logo_url'] ) ? (string) wp_unslash( $_POST['login_logo_url'] ) : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			'login_header_url'  => isset( $_POST['login_header_url'] ) ? (string) wp_unslash( $_POST['login_header_url'] ) : '', // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
			'login_header_text' => isset( $_POST['login_header_text'] ) ? sanitize_text_field( wp_unslash( $_POST['login_header_text'] ) ) : '',
			'login_message'     => isset( $_POST['login_message'] ) ? sanitize_textarea_field( wp_unslash( $_POST['login_message'] ) ) : '',
			'admin_footer_text' => isset( $_POST['admin_footer_text'] ) ? sanitize_text_field( wp_unslash( $_POST['admin_footer_text'] ) ) : '',
			'hide_wp_logo'      => isset( $_POST['hide_wp_logo'] ),
		);

		$result = $this->white_label()->save_settings( $input ); // LAYER 3 inside.

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_wl_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 6: Database Cleanup & Optimization ─────────────────────────────

	/**
	 * Render the database-cleanup section (LAYER 1 of the gate), driven by the
	 * `db_optimization` flag. Locked → reasons only, no forms and no preview.
	 * Unlocked → a live per-cleaner preview table (read-only counts), a Preview
	 * form and a separate Clean-now form (with an explicit confirmation), and the
	 * last-run summary from a per-user transient. The default is always a DRY RUN:
	 * nothing is deleted without the confirmed Clean-now submit.
	 */
	private function render_db_optimizer_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_DB_Optimizer::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Database Cleanup & Optimization', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Reclaim space by clearing expired transients, old post revisions, auto-drafts, trashed posts and comments, spam, and orphaned metadata — then optimize the core tables. Runs entirely on this server; Preview never changes anything.', 'infraweaver-connector' ) . '</p>';

		// A redirect from the handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_db_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			self::toast_open( 'error' );
			echo '<p><strong>' . esc_html__( 'The Database Optimization entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p>';
			self::toast_close();
		}
		// A redirect from the handler when Clean now was submitted without confirming.
		if ( isset( $_GET['iwsl_db_confirm'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			self::toast_open( 'warning' );
			echo '<p>' . esc_html__( 'Tick the confirmation box before running Clean now.', 'infraweaver-connector' ) . '</p>';
			self::toast_close();
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate, 'Database Cleanup &amp; Optimization', 'Database Cleanup &amp; Optimization is part of the Pro plan. Turn on Pro for this site from your InfraWeaver dashboard.' );
			return;
		}

		$this->render_db_last_run_summary();
		$this->render_db_preview_table();
		$this->render_db_forms();

		echo '<p class="description" style="margin-top:8px;">' . esc_html( sprintf( 'Each cleaner removes at most %d rows per run; run again to continue on large sites. Nothing is ever dropped, truncated, or altered.', IWSL_DB_Optimizer::MAX_ROWS ) ) . '</p>';
	}

	/** Live, read-only per-cleaner preview counts (a dry run issued on render). */
	private function render_db_preview_table(): void {
		$summary = $this->db_optimizer()->run( 'preview' ); // LAYER 3 inside; preview mutates nothing.

		echo '<h3 style="margin-top:24px;">' . esc_html__( 'Preview', 'infraweaver-connector' ) . '</h3>';

		if ( empty( $summary['ok'] ) ) {
			echo '<div class="notice notice-error inline" style="margin-top:8px;padding:12px;"><p>' . esc_html( sprintf( 'Preview unavailable: %s', (string) ( $summary['reason'] ?? 'unknown' ) ) ) . '</p></div>';
			return;
		}

		$cleaners = ( isset( $summary['cleaners'] ) && is_array( $summary['cleaners'] ) ) ? $summary['cleaners'] : array();
		echo '<table class="widefat striped" style="max-width:640px;margin-top:8px;"><thead><tr>';
		echo '<th>' . esc_html__( 'Cleaner', 'infraweaver-connector' ) . '</th><th>' . esc_html__( 'Rows to clean', 'infraweaver-connector' ) . '</th>';
		echo '</tr></thead><tbody>';
		foreach ( $cleaners as $row ) {
			$label = isset( $row['label'] ) ? (string) $row['label'] : '';
			$count = isset( $row['count'] ) ? (int) $row['count'] : 0;
			echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td>' . esc_html( (string) $count ) . '</td></tr>';
		}
		echo '<tr><th scope="row"><strong>' . esc_html__( 'Total', 'infraweaver-connector' ) . '</strong></th><td><strong>' . esc_html( (string) (int) ( $summary['total'] ?? 0 ) ) . '</strong></td></tr>';
		echo '</tbody></table>';
	}

	/** The Preview (re-scan) form + the confirmed Clean-now form (both nonce-protected). */
	private function render_db_forms(): void {
		$action = esc_url( admin_url( 'admin-post.php' ) );

		// PRIMARY: Clean now is the ONLY mutating path — gated behind an explicit
		// confirmation (kept visible, it is a required safety control). The
		// per-cleaner counts are surfaced in the Preview table above.
		echo '<form method="post" action="' . $action . '" style="margin-top:16px;">';
		wp_nonce_field( self::DB_OPTIMIZE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::DB_OPTIMIZE_ACTION ) . '">';
		echo '<input type="hidden" name="iwsl_db_mode" value="run">';
		echo '<p><label><input type="checkbox" name="iwsl_db_confirm" value="1"> ' . esc_html__( 'Yes, permanently delete the items counted above.', 'infraweaver-connector' ) . iwsl_field_help( 'Tick to confirm you really want these items deleted.' ) . '</label></p>';
		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html__( 'Deletes the items counted in Preview above.', 'infraweaver-connector' ) . '</span>';
		echo '<button type="submit" class="button button-primary">' . esc_html__( 'Clean database now', 'infraweaver-connector' ) . '</button>';
		echo '</div>';
		echo '</form>';

		// Secondary: a harmless re-scan (mode=preview) — a power-user knob.
		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<form method="post" action="' . $action . '" style="margin-top:8px;display:inline-block;">';
		wp_nonce_field( self::DB_OPTIMIZE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::DB_OPTIMIZE_ACTION ) . '">';
		echo '<input type="hidden" name="iwsl_db_mode" value="preview">';
		echo '<button type="submit" class="button">' . esc_html__( 'Refresh preview', 'infraweaver-connector' ) . '</button>';
		echo '</form>';
		echo '</div></details>';
	}

	/** Render (then clear) the current user's last-run summary transient. */
	private function render_db_last_run_summary(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key     = 'iwsl_db_result_' . (int) get_current_user_id();
		$summary = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $summary ) ) {
			return;
		}

		if ( empty( $summary['ok'] ) ) {
			self::toast_open( 'error' );
			echo '<p>' . esc_html( sprintf( 'Run refused: %s', (string) ( $summary['reason'] ?? 'unknown' ) ) ) . '</p>';
			self::toast_close();
			return;
		}

		$mode  = ( isset( $summary['mode'] ) && 'run' === $summary['mode'] ) ? 'run' : 'preview';
		$total = (int) ( $summary['total'] ?? 0 );
		$title = ( 'run' === $mode )
			? esc_html__( 'Last cleanup', 'infraweaver-connector' )
			: esc_html__( 'Last preview', 'infraweaver-connector' );
		$col   = ( 'run' === $mode )
			? esc_html__( 'Rows removed', 'infraweaver-connector' )
			: esc_html__( 'Rows found', 'infraweaver-connector' );
		$lead  = ( 'run' === $mode )
			? sprintf( 'Removed %d rows.', $total )
			: sprintf( 'Found %d rows to clean.', $total );

		self::toast_open( 'success' );
		echo '<h3 style="margin-top:0;">' . $title . '</h3>';
		echo '<p>' . esc_html( $lead ) . '</p>';

		$cleaners = ( isset( $summary['cleaners'] ) && is_array( $summary['cleaners'] ) ) ? $summary['cleaners'] : array();
		if ( array() !== $cleaners ) {
			echo '<table class="widefat striped" style="max-width:600px;"><thead><tr><th>' . esc_html__( 'Cleaner', 'infraweaver-connector' ) . '</th><th>' . $col . '</th></tr></thead><tbody>';
			foreach ( $cleaners as $row ) {
				$label = isset( $row['label'] ) ? (string) $row['label'] : '';
				$value = ( 'run' === $mode ) ? (int) ( $row['deleted'] ?? 0 ) : (int) ( $row['count'] ?? 0 );
				echo '<tr><td>' . esc_html( $label ) . '</td><td>' . esc_html( (string) $value ) . '</td></tr>';
			}
			echo '</tbody></table>';
		}
		self::toast_close();
	}

	/**
	 * admin-post handler for the database cleanup/optimize run. LAYER 2 of the
	 * gate: capability + nonce, then re-check the entitlement before touching the
	 * database, then run() (whose first statement is the authoritative LAYER 3
	 * gate). The ONLY inputs that cross the boundary are the nonce, an allow-listed
	 * mode ('preview' | 'run'), and — for 'run' — a confirmation checkbox. No SQL,
	 * no table names, no cleaner ids ever cross the boundary. POST-redirect-GET.
	 */
	public function handle_db_optimize(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::DB_OPTIMIZE_NONCE );

		$redirect = iwsl_plus_redirect_base();

		// LAYER 2: re-check the gate before touching the database.
		$gate = $this->plugin->entitlements()->evaluate( IWSL_DB_Optimizer::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_db_locked', '1', $redirect ) );
			exit;
		}

		$requested = isset( $_POST['iwsl_db_mode'] ) ? sanitize_key( wp_unslash( $_POST['iwsl_db_mode'] ) ) : 'preview';

		// Deletion requires an explicit confirmation — a missing tick falls back to a
		// safe re-preview rather than deleting anything.
		if ( 'run' === $requested && empty( $_POST['iwsl_db_confirm'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_db_confirm', '1', $redirect ) );
			exit;
		}

		$mode    = ( 'run' === $requested ) ? 'run' : 'preview';
		$summary = $this->db_optimizer()->run( $mode ); // LAYER 3 (authoritative) is inside run().

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_db_result_' . (int) get_current_user_id(), $summary, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 7: Page Cache ──────────────────────────────────────────────────

	/**
	 * Render the page-cache section (LAYER 1 of the gate), driven by the
	 * `page_cache` flag. Locked → reasons only, no controls. Unlocked → per-user
	 * PRG result notice + the status table + an enable/disable toggle + a Purge-all
	 * button. The serve/store engine itself is the drop-in (installed by enable());
	 * this page only manages it and reports status.
	 */
	private function render_page_cache_section(): void {
		$gate = $this->plugin->entitlements()->evaluate( IWSL_Page_Cache::FEATURE );

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Page Cache', 'infraweaver-connector' ) . '</h2>';
		echo '<p>' . esc_html__( 'Serve a static HTML copy of public pages to anonymous visitors — faster loads with no external service. Logged-in users, password-protected posts and carts always bypass the cache, and content changes purge it automatically.', 'infraweaver-connector' ) . '</p>';

		// A redirect from a handler after a locked POST (layer-2 defence tripped).
		if ( isset( $_GET['iwsl_pc_locked'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			self::toast_open( 'error' );
			echo '<p><strong>' . esc_html__( 'The Page Cache entitlement is not granted.', 'infraweaver-connector' ) . '</strong></p>';
			self::toast_close();
		}

		if ( empty( $gate['unlocked'] ) ) {
			self::render_locked_notice( $gate, 'Page Cache', 'Page Cache is part of the Pro plan. Turn on Pro for this site from your InfraWeaver dashboard.' );
			return;
		}

		$this->render_page_cache_result_notice();
		$this->render_page_cache_status_and_controls();
	}

	/** Render (then clear) the current user's PRG result transient. */
	private function render_page_cache_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_pc_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		if ( ! empty( $result['ok'] ) ) {
			if ( ! empty( $result['purged_msg'] ) ) {
				$msg = esc_html( (string) $result['purged_msg'] );
			} elseif ( ! empty( $result['enabled'] ) ) {
				$msg = esc_html__( 'Page cache enabled.', 'infraweaver-connector' );
			} else {
				$msg = esc_html__( 'Page cache disabled.', 'infraweaver-connector' );
			}
			self::toast_open( 'success' );
			echo '<p>' . $msg . '</p>';
			if ( ! empty( $result['manual_step'] ) ) {
				echo '<p class="iwsl-toast__sub">' . esc_html( (string) $result['manual_step'] ) . '</p>';
			}
			self::toast_close();
		} else {
			self::toast_open( 'error' );
			echo '<p>' . esc_html( sprintf( 'Action failed: %s', (string) ( $result['reason'] ?? 'unknown' ) ) ) . '</p>';
			self::toast_close();
		}
	}

	/** The status table + enable/disable toggle + purge-all button + the plain note. */
	private function render_page_cache_status_and_controls(): void {
		$status  = $this->page_cache()->status();
		$enabled = ! empty( $status['enabled'] );
		$action  = esc_url( admin_url( 'admin-post.php' ) );

		// PRIMARY one-click row: current state + enable/disable toggle + purge-all.
		$state_meta = $enabled
			? sprintf(
				/* translators: 1: number of cached pages, 2: human-readable cache size. */
				esc_html__( 'Active — %1$d cached page(s), %2$s.', 'infraweaver-connector' ),
				(int) $status['entries'],
				self::format_bytes( (int) $status['total_bytes'] )
			)
			: esc_html__( 'Inactive — enable to start serving cached pages.', 'infraweaver-connector' );

		echo '<div class="iwsl-primary">';
		echo '<span class="iwsl-primary__meta">' . esc_html( $state_meta ) . '</span>';

		// Enable / disable toggle.
		echo '<form method="post" action="' . $action . '" style="display:inline-block;margin:0;">';
		wp_nonce_field( self::PAGE_CACHE_TOGGLE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::PAGE_CACHE_TOGGLE_ACTION ) . '">';
		echo '<input type="hidden" name="enable" value="' . esc_attr( $enabled ? '0' : '1' ) . '">';
		$label = $enabled
			? esc_html__( 'Disable page cache', 'infraweaver-connector' )
			: esc_html__( 'Enable page cache', 'infraweaver-connector' );
		echo '<button type="submit" class="button button-primary">' . $label . '</button>';
		echo iwsl_field_help( 'Turn saved-page speed-up on or off.' );
		echo '</form> ';

		// Purge-all button.
		echo '<form method="post" action="' . $action . '" style="display:inline-block;margin:0;">';
		wp_nonce_field( self::PAGE_CACHE_PURGE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::PAGE_CACHE_PURGE_ACTION ) . '">';
		echo '<button type="submit" class="button">' . esc_html__( 'Purge all', 'infraweaver-connector' ) . '</button>';
		echo iwsl_field_help( 'Clear all saved pages so visitors get fresh ones.' );
		echo '</form>';
		echo '</div>';

		// If WP_CACHE cannot be set automatically, show the exact manual step
		// (kept VISIBLE — it is an important activation warning, not a knob).
		if ( empty( $status['wp_cache_defined'] ) && empty( $status['wp_config_writable'] ) ) {
			echo '<div class="notice notice-warning inline" style="margin-top:12px;padding:12px;"><p>' . esc_html__( "wp-config.php is not writable. Add define('WP_CACHE', true); near the top of wp-config.php to activate the cache; the drop-in stays inert until then.", 'infraweaver-connector' ) . '</p></div>';
		}

		// Diagnostic status + freshness (TTL) — secondary detail.
		echo '<details class="iwsl-adv"><summary>' . esc_html__( 'Advanced settings', 'infraweaver-connector' ) . '</summary><div class="iwsl-adv__body">';
		echo '<table class="widefat striped" style="max-width:640px;margin-top:12px;"><thead><tr>';
		echo '<th>' . esc_html__( 'Status', 'infraweaver-connector' ) . '</th><th>' . esc_html__( 'Value', 'infraweaver-connector' ) . '</th></tr></thead><tbody>';
		self::render_page_cache_status_row( esc_html__( 'Cache active', 'infraweaver-connector' ), $enabled );
		self::render_page_cache_status_row( esc_html__( 'Drop-in installed', 'infraweaver-connector' ), ! empty( $status['dropin_present'] ) && ! empty( $status['dropin_is_ours'] ) );
		self::render_page_cache_status_row( esc_html__( 'WP_CACHE set in wp-config.php', 'infraweaver-connector' ), ! empty( $status['wp_cache_defined'] ) );
		self::render_page_cache_status_row( esc_html__( 'wp-config.php writable', 'infraweaver-connector' ), ! empty( $status['wp_config_writable'] ) );
		echo '<tr><th scope="row">' . esc_html__( 'Cached pages', 'infraweaver-connector' ) . '</th><td>' . esc_html( (string) (int) $status['entries'] ) . '</td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Cache size', 'infraweaver-connector' ) . '</th><td>' . esc_html( self::format_bytes( (int) $status['total_bytes'] ) ) . '</td></tr>';
		echo '<tr><th scope="row">' . esc_html__( 'Freshness (TTL)', 'infraweaver-connector' ) . '</th><td>' . esc_html( sprintf( '%d seconds', (int) $status['ttl'] ) ) . '</td></tr>';
		echo '</tbody></table>';
		echo '<p class="description" style="margin-top:8px;">' . esc_html__( 'Only anonymous visitors are served cached pages; logged-in users and carts always bypass. Content changes purge the cache automatically.', 'infraweaver-connector' ) . '</p>';
		echo '</div></details>';
	}

	/** One yes/no status row. */
	private static function render_page_cache_status_row( string $label, bool $ok ): void {
		$marker = $ok
			? '<span style="color:#1a7f37;font-weight:600;">&#10004; yes</span>'
			: '<span style="color:#b3261e;font-weight:600;">&#10008; no</span>';
		echo '<tr><th scope="row">' . esc_html( $label ) . '</th><td>' . $marker . '</td></tr>';
	}

	/**
	 * admin-post handler: enable/disable the page cache. LAYER 2 of the gate
	 * (capability + nonce + gate re-check), then enable()/disable() (whose own
	 * STATEMENT 1 is the authoritative LAYER 3 gate). The only input that crosses
	 * the boundary is the nonce + a boolean intent. POST-redirect-GET.
	 */
	public function handle_page_cache_toggle(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::PAGE_CACHE_TOGGLE_NONCE );

		$redirect = iwsl_plus_redirect_base();

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Page_Cache::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_pc_locked', '1', $redirect ) );
			exit;
		}

		$enable = ! empty( $_POST['enable'] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$pc     = $this->page_cache();
		if ( $enable ) {
			$out              = $pc->enable(); // LAYER 3 inside.
			$result           = array( 'ok' => ! empty( $out['ok'] ), 'enabled' => ! empty( $out['ok'] ) );
			if ( isset( $out['reason'] ) ) {
				$result['reason'] = (string) $out['reason'];
			}
			if ( ! empty( $out['manual_step'] ) ) {
				$result['manual_step'] = (string) $out['manual_step'];
			}
		} else {
			$out    = $pc->disable(); // LAYER 3 inside (signature-verified teardown).
			$result = array( 'ok' => ! empty( $out['ok'] ), 'enabled' => false );
			if ( isset( $out['reason'] ) ) {
				$result['reason'] = (string) $out['reason'];
			}
		}

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_pc_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	/**
	 * admin-post handler: purge the whole page cache. Same LAYER 2 skeleton, then
	 * purge_all(). Purging is harmless, so no further inputs cross the boundary.
	 * POST-redirect-GET.
	 */
	public function handle_page_cache_purge(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::PAGE_CACHE_PURGE_NONCE );

		$redirect = iwsl_plus_redirect_base();

		$gate = $this->plugin->entitlements()->evaluate( IWSL_Page_Cache::FEATURE );
		if ( empty( $gate['unlocked'] ) ) {
			wp_safe_redirect( add_query_arg( 'iwsl_pc_locked', '1', $redirect ) );
			exit;
		}

		$out    = $this->page_cache()->purge_all();
		$result = array(
			'ok'         => ! empty( $out['ok'] ),
			'purged_msg' => sprintf( 'Purged %d cached pages.', (int) ( $out['purged'] ?? 0 ) ),
		);

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_pc_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}

	// ── Section 8: Config editor ───────────────────────────────────────────────

	/**
	 * Render the Config section. Unlike the Plus features this carries NO
	 * entitlement gate — it is the site's own administrator editing their own
	 * wp-config constants and PHP limits, so the required gate is `manage_options`
	 * (enforced by the System sub-page/the handler) plus the form nonce. Only the
	 * hard-coded allow-list is ever shown, and each field is pre-filled with its
	 * effective current value. If a write target is not writable, a notice makes
	 * clear the change cannot be applied automatically.
	 */
	/**
	 * Render the FREE Load-Time Audit section. No entitlement gate — this feature is
	 * available on every plan, so it is built with only the site's own store (mirrors
	 * the config editor). The engine self-renders its status, controls, and table.
	 */
	private function render_perf_audit_section(): void {
		( new IWSL_Perf_Audit( new IWSL_WP_Store() ) )->render_section();
	}

	/**
	 * The Cookie Consent panel: a guided 1-minute setup wizard layered on top of the
	 * full manual form. A locked site shows the calm placeholder. Otherwise: a
	 * per-user PRG result toast, then either a prominent "set up in 1 minute" call to
	 * action (fresh install) or a compact "your banner is on" bar with a live preview
	 * link + a "re-run guided setup" button — and ALWAYS the engine's own manual
	 * settings form + consent log below, so nothing is hidden behind the wizard. The
	 * wizard is a self-contained <dialog> (inline CSS/JS, no external asset) that
	 * POSTs exactly once to the gated handle_cookie_wizard() PRG.
	 */
	private function render_consent_section( bool $unlocked ): void {
		if ( ! $unlocked ) {
			self::render_locked_panel( 'Cookie Consent' );
			return;
		}
		$cc = new IWSL_Cookie_Consent( $this->plugin->entitlements(), new IWSL_WP_Store() );

		$this->render_consent_wizard_toast();

		if ( ! $cc->is_configured() ) {
			echo '<div class="iwsl-cw-cta">';
			echo '<div class="iwsl-cw-cta__text">';
			echo '<h3>' . esc_html__( 'Set up your cookie banner in 1 minute', 'infraweaver-connector' ) . '</h3>';
			echo '<p>' . esc_html__( 'A short guided walk-through turns on a privacy-safe cookie banner that pauses trackers until visitors agree. You can fine-tune everything afterwards.', 'infraweaver-connector' ) . '</p>';
			echo '</div>';
			echo '<button type="button" class="button button-primary" data-cw-open="1"><span class="dashicons dashicons-shield" aria-hidden="true"></span>' . esc_html__( 'Start guided setup', 'infraweaver-connector' ) . '</button>';
			echo '</div>';
		} else {
			echo '<div class="iwsl-cw-bar">';
			echo '<span class="iwsl-cw-bar__on"><span class="dashicons dashicons-yes-alt" aria-hidden="true"></span>' . esc_html__( 'Your cookie banner is on.', 'infraweaver-connector' ) . '</span>';
			echo '<a class="button button-secondary" href="' . esc_url( $cc->preview_url() ) . '" target="_blank" rel="noopener noreferrer"><span class="dashicons dashicons-visibility" aria-hidden="true"></span>' . esc_html__( 'Preview banner', 'infraweaver-connector' ) . '</a>';
			echo '<button type="button" class="button button-secondary" data-cw-open="1"><span class="dashicons dashicons-update" aria-hidden="true"></span>' . esc_html__( 'Re-run guided setup', 'infraweaver-connector' ) . '</button>';
			echo '</div>';
			echo '<p class="description" style="margin:8px 0 0;">' . esc_html__( 'You are logged in, so you won’t see the banner normally — open the preview to view it as a brand-new visitor.', 'infraweaver-connector' ) . '</p>';
		}

		$this->render_consent_wizard_modal( $cc );

		$cc->render_section();
	}

	/** The Cookie Consent wizard's one-shot PRG result toast (per-user transient). */
	private function render_consent_wizard_toast(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key = self::CONSENT_WIZARD_RESULT . get_current_user_id();
		$r   = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $r ) ) {
			return;
		}
		if ( ! empty( $r['ok'] ) ) {
			self::toast_open( 'success' );
			echo '<p>' . esc_html__( 'Cookie banner is live — visitors will now see it.', 'infraweaver-connector' ) . '</p>';
			self::toast_close();
			return;
		}
		$reason = (string) ( $r['reason'] ?? 'unknown' );
		if ( 'entitlement-locked' === $reason ) {
			$err = esc_html__( 'Cookie Consent is not unlocked on this site’s plan. Upgrade from the InfraWeaver console to use it.', 'infraweaver-connector' );
		} else {
			$err = esc_html( sprintf(
				/* translators: %s is a short machine reason code. */
				__( 'Could not turn on the cookie banner: %s', 'infraweaver-connector' ),
				$reason
			) );
		}
		self::toast_open( 'error' );
		echo '<p>' . $err . '</p>';
		self::toast_close();
	}

	/**
	 * The guided-setup <dialog>: five plain-English steps (Welcome → what happens
	 * automatically → recommended setup → optional look-and-feel → turn it on),
	 * paged with Next/Back. One POST form to the gated handle_cookie_wizard() — the
	 * ONLY write. A native <dialog> gives Esc-to-close + focus containment for free;
	 * the paging is a small scoped IIFE. Self-contained: no external asset.
	 */
	private function render_consent_wizard_modal( IWSL_Cookie_Consent $cc ): void {
		$rec = $cc->recommended_defaults();

		self::render_consent_wizard_styles();

		echo '<dialog class="iwsl-cw" id="iwsl-cw-dialog" aria-labelledby="iwsl-cw-title">';
		echo '<form class="iwsl-cw__inner" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( self::CONSENT_WIZARD_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::CONSENT_WIZARD_ACTION ) . '">';

		echo '<div class="iwsl-cw__head">';
		echo '<span class="iwsl-cw__mark" aria-hidden="true"><span class="dashicons dashicons-shield"></span></span>';
		echo '<h2 class="iwsl-cw__title" id="iwsl-cw-title">' . esc_html__( 'Cookie banner — guided setup', 'infraweaver-connector' ) . '</h2>';
		echo '<button type="button" class="iwsl-cw__x" data-cw-close="1" aria-label="' . esc_attr__( 'Close', 'infraweaver-connector' ) . '">&times;</button>';
		echo '</div>';
		echo '<p class="iwsl-cw__progress" data-cw-tpl="' . esc_attr__( 'Step {n} of {t}', 'infraweaver-connector' ) . '" aria-hidden="true"></p>';

		echo '<div class="iwsl-cw__steps">';

		// Step 1 — Welcome.
		echo '<section class="iwsl-cw__step" data-step="1" aria-label="' . esc_attr__( 'Welcome', 'infraweaver-connector' ) . '">';
		echo '<h3>' . esc_html__( 'Welcome', 'infraweaver-connector' ) . '</h3>';
		echo '<p>' . esc_html__( 'This turns on a cookie banner that pauses trackers until visitors agree. Nothing changes until the final step.', 'infraweaver-connector' ) . '</p>';
		echo '</section>';

		// Step 2 — What happens automatically.
		echo '<section class="iwsl-cw__step" data-step="2" aria-label="' . esc_attr__( 'What happens automatically', 'infraweaver-connector' ) . '">';
		echo '<h3>' . esc_html__( 'What happens automatically', 'infraweaver-connector' ) . '</h3>';
		echo '<p>' . esc_html__( 'Common tools (Google Analytics, Facebook Pixel, and the like) are detected and paused until a visitor consents — you don’t configure each one.', 'infraweaver-connector' ) . '</p>';
		echo '</section>';

		// Step 3 — Recommended setup (read-only summary of recommended_defaults()).
		$model_val    = isset( $rec['default_model'] ) ? (string) $rec['default_model'] : 'opt-in';
		$model_human  = 'opt-in' === $model_val ? __( 'Ask first (opt-in)', 'infraweaver-connector' ) : ucfirst( $model_val );
		$cmode_human  = ! empty( $rec['consent_mode'] ) ? __( 'On', 'infraweaver-connector' ) : __( 'Off', 'infraweaver-connector' );
		$us_human     = ! empty( $rec['respect_gpc'] )
			? __( '“Do Not Sell or Share” + Global Privacy Control honored', 'infraweaver-connector' )
			: __( 'Opt-out (on by default)', 'infraweaver-connector' );
		$cat_labels   = array(
			'preferences' => __( 'Preferences', 'infraweaver-connector' ),
			'statistics'  => __( 'Statistics', 'infraweaver-connector' ),
			'marketing'   => __( 'Marketing', 'infraweaver-connector' ),
		);
		$cats = array();
		foreach ( $cat_labels as $ckey => $clabel ) {
			if ( ! isset( $rec['categories'] ) || ! is_array( $rec['categories'] ) || ! empty( $rec['categories'][ $ckey ] ) ) {
				$cats[] = $clabel;
			}
		}
		$cats_human = empty( $cats ) ? __( 'Necessary only', 'infraweaver-connector' ) : implode( ', ', $cats );
		$facts = array(
			array( __( 'EU & UK visitors', 'infraweaver-connector' ), __( 'Asked before any tracker runs', 'infraweaver-connector' ) ),
			array( __( 'US visitors', 'infraweaver-connector' ), $us_human ),
			array( __( 'Default consent model', 'infraweaver-connector' ), $model_human ),
			array( __( 'Google Consent Mode v2', 'infraweaver-connector' ), $cmode_human ),
			array( __( 'Cookie categories offered', 'infraweaver-connector' ), $cats_human ),
		);
		echo '<section class="iwsl-cw__step" data-step="3" aria-label="' . esc_attr__( 'Recommended setup', 'infraweaver-connector' ) . '">';
		echo '<h3>' . esc_html__( 'Recommended setup', 'infraweaver-connector' ) . '</h3>';
		echo '<p>' . esc_html__( 'These privacy-safe defaults will be applied. You can change any of them later on this page.', 'infraweaver-connector' ) . '</p>';
		echo '<ul class="iwsl-cw__facts">';
		foreach ( $facts as $fact ) {
			echo '<li><span class="iwsl-cw__fact-k">' . esc_html( (string) $fact[0] ) . '</span><span class="iwsl-cw__fact-v">' . esc_html( (string) $fact[1] ) . '</span></li>';
		}
		echo '</ul>';
		echo '</section>';

		// Step 4 — Make it yours (all optional; blank uses the built-in defaults).
		echo '<section class="iwsl-cw__step" data-step="4" aria-label="' . esc_attr__( 'Make it yours', 'infraweaver-connector' ) . '">';
		echo '<h3>' . esc_html__( 'Make it yours (optional)', 'infraweaver-connector' ) . '</h3>';
		echo '<p>' . esc_html__( 'Leave anything blank to use the sensible defaults — you can change all of this later.', 'infraweaver-connector' ) . '</p>';
		echo '<div class="iwsl-cw__fields">';
		echo '<label class="iwsl-cw__field"><span>' . esc_html__( 'Accent color', 'infraweaver-connector' ) . '</span>';
		echo '<input type="text" name="accent" value="" placeholder="#2a6df0" pattern="#?[0-9A-Fa-f]{6}" autocomplete="off"></label>';
		echo '<label class="iwsl-cw__field"><span>' . esc_html__( 'Banner shape', 'infraweaver-connector' ) . '</span>';
		echo '<select name="banner_layout"><option value="bar">' . esc_html__( 'Bar across the bottom', 'infraweaver-connector' ) . '</option><option value="box">' . esc_html__( 'Floating box in a corner', 'infraweaver-connector' ) . '</option><option value="center">' . esc_html__( 'Center popup (blurs the page)', 'infraweaver-connector' ) . '</option></select></label>';
		echo '<label class="iwsl-cw__field"><span>' . esc_html__( 'Privacy-policy link', 'infraweaver-connector' ) . '</span>';
		echo '<input type="url" name="policy_url" value="" placeholder="https://example.com/privacy" autocomplete="off"></label>';
		echo '<label class="iwsl-cw__field"><span>' . esc_html__( 'Banner title', 'infraweaver-connector' ) . '</span>';
		echo '<input type="text" name="title" value="" placeholder="' . esc_attr__( 'We value your privacy', 'infraweaver-connector' ) . '" autocomplete="off"></label>';
		echo '<label class="iwsl-cw__field iwsl-cw__field--wide"><span>' . esc_html__( 'Banner message', 'infraweaver-connector' ) . '</span>';
		echo '<textarea name="message" rows="3" placeholder="' . esc_attr__( 'We use cookies to improve your experience, analyze traffic and for marketing.', 'infraweaver-connector' ) . '"></textarea></label>';
		echo '</div>';
		echo '</section>';

		// Step 5 — Turn it on (the submit; the only write).
		echo '<section class="iwsl-cw__step" data-step="5" aria-label="' . esc_attr__( 'Turn it on', 'infraweaver-connector' ) . '">';
		echo '<h3>' . esc_html__( 'Turn it on', 'infraweaver-connector' ) . '</h3>';
		echo '<p>' . esc_html__( 'Ready. This applies the settings above and shows the banner to visitors right away.', 'infraweaver-connector' ) . '</p>';
		echo '<p class="iwsl-cw__note">' . esc_html__( 'You are logged in, so you won’t see the banner yourself — use the preview link afterwards to view it as a new visitor would.', 'infraweaver-connector' ) . '</p>';
		echo '<button type="submit" class="button button-primary iwsl-cw__go"><span class="dashicons dashicons-shield" aria-hidden="true"></span>' . esc_html__( 'Turn on my cookie banner', 'infraweaver-connector' ) . '</button>';
		echo '</section>';

		echo '</div>'; // .iwsl-cw__steps

		echo '<div class="iwsl-cw__nav">';
		echo '<button type="button" class="button button-secondary" data-cw-back="1">' . esc_html__( 'Back', 'infraweaver-connector' ) . '</button>';
		echo '<button type="button" class="button button-primary" data-cw-next="1">' . esc_html__( 'Next', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '</form>';
		echo '</dialog>';

		self::render_consent_wizard_script();
	}

	/** Scoped styles for the Cookie Consent CTA / bar / guided-setup dialog. Reuses the shell --iw-* tokens. */
	private static function render_consent_wizard_styles(): void {
		echo "<style>\n";
		echo <<<'CSS'
.iwsl-shell .iwsl-cw-cta{ display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 18px 20px; margin: 0 0 16px; border: 1px solid color-mix(in oklch, var(--iw-signal) 34%, var(--iw-line-2)); border-radius: 14px; background: color-mix(in oklch, var(--iw-signal) 8%, var(--iw-panel)); }
.iwsl-shell .iwsl-cw-cta__text{ flex: 1 1 300px; }
.iwsl-shell .iwsl-cw-cta__text h3{ margin: 0 0 4px; text-transform: none; letter-spacing: 0; }
.iwsl-shell .iwsl-cw-cta__text h3::before{ display: none; }
.iwsl-shell .iwsl-cw-cta__text p{ margin: 0; }
.iwsl-shell .iwsl-cw-bar{ display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 0 0 4px; }
.iwsl-shell .iwsl-cw-bar__on{ display: inline-flex; align-items: center; gap: 7px; margin-right: auto; font-weight: 600; color: var(--iw-good); }
.iwsl-shell .iwsl-cw-bar__on .dashicons{ font-size: 18px; width: 18px; height: 18px; }

.iwsl-shell .iwsl-cw{ width: min(560px, calc(100vw - 32px)); max-width: 560px; max-height: calc(100vh - 48px); overflow: auto; padding: 0; color: var(--iw-ink); background: var(--iw-panel); border: 1px solid var(--iw-line-2); border-radius: 16px; box-shadow: 0 40px 90px -30px rgba(0,0,0,.85); }
.iwsl-shell .iwsl-cw::backdrop{ background: rgba(4,7,11,.62); backdrop-filter: blur(2px); }
.iwsl-shell .iwsl-cw__inner{ margin: 0; padding: 22px 24px 20px; }
.iwsl-shell .iwsl-cw__head{ display: flex; align-items: center; gap: 12px; }
.iwsl-shell .iwsl-cw__mark{ display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; color: var(--iw-signal-ink); background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal)); flex: 0 0 auto; }
.iwsl-shell .iwsl-cw__mark .dashicons{ font-size: 19px; width: 19px; height: 19px; }
.iwsl-shell .iwsl-cw__title{ margin: 0; font-size: 17px; }
.iwsl-shell .iwsl-cw__x{ margin-left: auto; padding: 2px 6px; background: none; border: 0; border-radius: 8px; color: var(--iw-faint); font-size: 24px; line-height: 1; cursor: pointer; }
.iwsl-shell .iwsl-cw__x:hover{ color: var(--iw-ink); background: color-mix(in oklch, white 8%, transparent); }
.iwsl-shell .iwsl-cw__progress{ margin: 6px 0 12px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--iw-faint); }
.iwsl-shell .iwsl-cw__steps{ min-height: 150px; }
.iwsl-shell .iwsl-cw__step{ display: none; }
.iwsl-shell .iwsl-cw__step.is-active{ display: block; }
@media (prefers-reduced-motion: no-preference){ .iwsl-shell .iwsl-cw__step.is-active{ animation: iwsl-rise .28s var(--iw-ease) both; } }
.iwsl-shell .iwsl-cw__step h3{ margin: 0 0 8px; font-size: 15px; text-transform: none; letter-spacing: 0; }
.iwsl-shell .iwsl-cw__step h3::before{ display: none; }
.iwsl-shell .iwsl-cw__facts{ list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--iw-line); border-radius: 12px; overflow: hidden; }
.iwsl-shell .iwsl-cw__facts li{ display: flex; gap: 12px; justify-content: space-between; padding: 10px 14px; background: var(--iw-panel-2); }
.iwsl-shell .iwsl-cw__fact-k{ color: var(--iw-muted); font-size: 12.5px; }
.iwsl-shell .iwsl-cw__fact-v{ color: var(--iw-ink); font-size: 12.5px; font-weight: 600; text-align: right; }
.iwsl-shell .iwsl-cw__fields{ display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.iwsl-shell .iwsl-cw__field{ display: flex; flex-direction: column; gap: 5px; }
.iwsl-shell .iwsl-cw__field > span{ font-size: 12.5px; color: var(--iw-muted); }
.iwsl-shell .iwsl-cw__note{ margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; background: color-mix(in oklch, var(--iw-signal) 8%, transparent); border: 1px solid color-mix(in oklch, var(--iw-signal) 26%, var(--iw-line)); }
.iwsl-shell .iwsl-cw__go{ margin-top: 14px; }
.iwsl-shell .iwsl-cw__nav{ display: flex; justify-content: space-between; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--iw-line); }
CSS;
		echo "\n</style>\n";
	}

	/** The tiny scoped pager for the Cookie Consent guided-setup dialog (open, Next/Back, Esc/backdrop close). No external asset. */
	private static function render_consent_wizard_script(): void {
		echo "<script>\n";
		echo <<<'JS'
(function(){
	var dlg = document.getElementById('iwsl-cw-dialog');
	if (!dlg) { return; }
	var steps = Array.prototype.slice.call(dlg.querySelectorAll('.iwsl-cw__step'));
	if (!steps.length) { return; }
	var nextBtn = dlg.querySelector('[data-cw-next]');
	var backBtn = dlg.querySelector('[data-cw-back]');
	var prog = dlg.querySelector('.iwsl-cw__progress');
	var tpl = prog ? (prog.getAttribute('data-cw-tpl') || 'Step {n} of {t}') : '';
	var cur = 0;
	function render(){
		steps.forEach(function(s, i){ s.classList.toggle('is-active', i === cur); });
		if (backBtn) { backBtn.style.visibility = cur === 0 ? 'hidden' : 'visible'; }
		if (nextBtn) { nextBtn.hidden = (cur === steps.length - 1); }
		if (prog) { prog.textContent = tpl.replace('{n}', String(cur + 1)).replace('{t}', String(steps.length)); }
		if (cur !== 0) {
			var f = steps[cur].querySelector('input, select, textarea, button');
			if (f) { try { f.focus(); } catch (e) {} }
		}
	}
	function go(i){ cur = Math.max(0, Math.min(steps.length - 1, i)); render(); }
	function close(){ try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } }
	function open(){
		cur = 0;
		if (typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
		else { dlg.setAttribute('open', ''); }
		render();
	}
	Array.prototype.slice.call(document.querySelectorAll('[data-cw-open]')).forEach(function(b){
		b.addEventListener('click', function(e){ e.preventDefault(); open(); });
	});
	dlg.addEventListener('click', function(e){
		if (e.target.closest('[data-cw-next]')) { go(cur + 1); }
		else if (e.target.closest('[data-cw-back]')) { go(cur - 1); }
		else if (e.target.closest('[data-cw-close]')) { close(); }
		else if (e.target === dlg) { close(); }
	});
	render();
})();
JS;
		echo "\n</script>\n";
	}

	// ── Reusable guided-setup wizard (launcher CTA + native <dialog> stepper) ───
	//
	// One helper drives every feature setup wizard: a prominent launcher card plus
	// a self-contained <dialog> whose FINAL step submits a normal POST to that
	// feature's EXISTING admin-post save handler (reusing its action + nonce +
	// field names — no new save endpoints). Mirrors the proven Cookie-Consent
	// wizard: labelled dialog, Esc/backdrop close, Back/Next paging, focusable,
	// scoped inline CSS/JS under .iwsl-shell, no external assets. Degrades without
	// JS: the feature's full existing form is always rendered below the launcher.

	/**
	 * Render a guided-setup wizard: a launcher CTA + a stepped modal form.
	 *
	 * @param string $id    Unique slug (e.g. 'smtp'); scopes the dialog id + launcher.
	 * @param string $title Dialog title (plain text).
	 * @param array  $spec  {
	 *     action: string  EXISTING admin-post action the final step submits to.
	 *     nonce:  string  EXISTING nonce action for wp_nonce_field().
	 *     submit: string  Final-step submit-button label.
	 *     icon:   string  dashicon slug (sans the `dashicons-` prefix).
	 *     launch: array{ heading:string, body:string, button:string }  Launcher copy.
	 *     steps:  array<int, array{ title:string, body:callable():void }>  Ordered steps;
	 *             each body() echoes the step's plain-English copy + any form fields.
	 * }
	 */
	private function wizard_open( string $id, string $title, array $spec ): void {
		self::render_wizard_assets();

		$action = (string) ( $spec['action'] ?? '' );
		$nonce  = (string) ( $spec['nonce'] ?? '' );
		$submit = (string) ( $spec['submit'] ?? __( 'Finish setup', 'infraweaver-connector' ) );
		$icon   = (string) ( $spec['icon'] ?? 'admin-generic' );
		$launch = ( isset( $spec['launch'] ) && is_array( $spec['launch'] ) ) ? $spec['launch'] : array();
		$steps  = ( isset( $spec['steps'] ) && is_array( $spec['steps'] ) ) ? array_values( $spec['steps'] ) : array();
		if ( '' === $action || array() === $steps ) {
			return; // nothing to submit to, or nothing to show — render nothing.
		}
		$dialog_id = 'iwsl-wz-' . $id;

		// Launcher CTA — prominent; the caller only invokes this when unconfigured.
		echo '<div class="iwsl-wz-cta">';
		echo '<div class="iwsl-wz-cta__text">';
		echo '<h3>' . esc_html( (string) ( $launch['heading'] ?? $title ) ) . '</h3>';
		if ( ! empty( $launch['body'] ) ) {
			echo '<p>' . esc_html( (string) $launch['body'] ) . '</p>';
		}
		echo '</div>';
		echo '<button type="button" class="button button-primary" data-wz-open="' . esc_attr( $id ) . '"><span class="dashicons dashicons-' . esc_attr( $icon ) . '" aria-hidden="true"></span>' . esc_html( (string) ( $launch['button'] ?? __( 'Start guided setup', 'infraweaver-connector' ) ) ) . '</button>';
		echo '</div>';

		echo '<dialog class="iwsl-wz" id="' . esc_attr( $dialog_id ) . '" data-wz-dialog="' . esc_attr( $id ) . '" aria-labelledby="' . esc_attr( $dialog_id ) . '-title">';
		echo '<form class="iwsl-wz__inner" method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
		wp_nonce_field( $nonce );
		echo '<input type="hidden" name="action" value="' . esc_attr( $action ) . '">';

		echo '<div class="iwsl-wz__head">';
		echo '<span class="iwsl-wz__mark" aria-hidden="true"><span class="dashicons dashicons-' . esc_attr( $icon ) . '"></span></span>';
		echo '<h2 class="iwsl-wz__title" id="' . esc_attr( $dialog_id ) . '-title">' . esc_html( $title ) . '</h2>';
		echo '<button type="button" class="iwsl-wz__x" data-wz-close="1" aria-label="' . esc_attr__( 'Close', 'infraweaver-connector' ) . '">&times;</button>';
		echo '</div>';
		echo '<p class="iwsl-wz__progress" data-wz-tpl="' . esc_attr__( 'Step {n} of {t}', 'infraweaver-connector' ) . '" aria-hidden="true"></p>';

		echo '<div class="iwsl-wz__steps">';
		$last = count( $steps ) - 1;
		foreach ( $steps as $i => $step ) {
			$stitle = (string) ( $step['title'] ?? '' );
			echo '<section class="iwsl-wz__step" aria-label="' . esc_attr( '' !== $stitle ? $stitle : $title ) . '">';
			if ( '' !== $stitle ) {
				echo '<h3>' . esc_html( $stitle ) . '</h3>';
			}
			$body = $step['body'] ?? null;
			if ( is_callable( $body ) ) {
				$body();
			}
			if ( $i === $last ) {
				echo '<button type="submit" class="button button-primary iwsl-wz__go"><span class="dashicons dashicons-yes" aria-hidden="true"></span>' . esc_html( $submit ) . '</button>';
			}
			echo '</section>';
		}
		echo '</div>'; // .iwsl-wz__steps

		echo '<div class="iwsl-wz__nav">';
		echo '<button type="button" class="button button-secondary" data-wz-back="1">' . esc_html__( 'Back', 'infraweaver-connector' ) . '</button>';
		echo '<button type="button" class="button button-primary" data-wz-next="1">' . esc_html__( 'Next', 'infraweaver-connector' ) . '</button>';
		echo '</div>';

		echo '</form>';
		echo '</dialog>';
	}

	/** A labelled text/url/email/number field inside a wizard step. */
	private static function wizard_field( string $type, string $name, string $label, string $value = '', string $placeholder = '', array $attrs = array() ): void {
		echo '<label class="iwsl-wz__field"><span>' . esc_html( $label ) . '</span>';
		echo '<input type="' . esc_attr( $type ) . '" name="' . esc_attr( $name ) . '" value="' . esc_attr( $value ) . '"';
		if ( '' !== $placeholder ) {
			echo ' placeholder="' . esc_attr( $placeholder ) . '"';
		}
		foreach ( $attrs as $k => $v ) {
			echo ' ' . esc_attr( (string) $k ) . '="' . esc_attr( (string) $v ) . '"';
		}
		echo '></label>';
	}

	/** A labelled textarea field inside a wizard step. */
	private static function wizard_textarea( string $name, string $label, string $value = '', string $placeholder = '', int $rows = 3 ): void {
		echo '<label class="iwsl-wz__field"><span>' . esc_html( $label ) . '</span>';
		echo '<textarea name="' . esc_attr( $name ) . '" rows="' . esc_attr( (string) $rows ) . '" class="large-text code"';
		if ( '' !== $placeholder ) {
			echo ' placeholder="' . esc_attr( $placeholder ) . '"';
		}
		echo '>' . esc_textarea( $value ) . '</textarea></label>';
	}

	/** A labelled checkbox inside a wizard step, with optional helper text. */
	private static function wizard_checkbox( string $name, string $label, bool $checked = false, string $help = '' ): void {
		echo '<label class="iwsl-wz__check"><input type="checkbox" name="' . esc_attr( $name ) . '" value="1"' . ( $checked ? ' checked' : '' ) . '> <span>' . esc_html( $label );
		if ( '' !== $help ) {
			echo '<br><span class="description">' . esc_html( $help ) . '</span>';
		}
		echo '</span></label>';
	}

	/** Emit the shared wizard CSS + JS exactly once per request (many wizards, one asset). */
	private static function render_wizard_assets(): void {
		static $done = false;
		if ( $done ) {
			return;
		}
		$done = true;

		echo "<style>\n";
		echo <<<'CSS'
.iwsl-shell .iwsl-wz-cta{ display: flex; flex-wrap: wrap; align-items: center; gap: 16px; padding: 18px 20px; margin: 0 0 16px; border: 1px solid color-mix(in oklch, var(--iw-signal) 34%, var(--iw-line-2)); border-radius: 14px; background: color-mix(in oklch, var(--iw-signal) 8%, var(--iw-panel)); }
.iwsl-shell .iwsl-wz-cta__text{ flex: 1 1 300px; }
.iwsl-shell .iwsl-wz-cta__text h3{ margin: 0 0 4px; text-transform: none; letter-spacing: 0; }
.iwsl-shell .iwsl-wz-cta__text h3::before{ display: none; }
.iwsl-shell .iwsl-wz-cta__text p{ margin: 0; }
.iwsl-shell .iwsl-wz{ width: min(580px, calc(100vw - 32px)); max-width: 580px; max-height: calc(100vh - 48px); overflow: auto; padding: 0; color: var(--iw-ink); background: var(--iw-panel); border: 1px solid var(--iw-line-2); border-radius: 16px; box-shadow: 0 40px 90px -30px rgba(0,0,0,.85); }
.iwsl-shell .iwsl-wz::backdrop{ background: rgba(4,7,11,.62); backdrop-filter: blur(2px); }
.iwsl-shell .iwsl-wz__inner{ margin: 0; padding: 22px 24px 20px; }
.iwsl-shell .iwsl-wz__head{ display: flex; align-items: center; gap: 12px; }
.iwsl-shell .iwsl-wz__mark{ display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 10px; color: var(--iw-signal-ink); background: linear-gradient(155deg, var(--iw-signal-2), var(--iw-signal)); flex: 0 0 auto; }
.iwsl-shell .iwsl-wz__mark .dashicons{ font-size: 19px; width: 19px; height: 19px; }
.iwsl-shell .iwsl-wz__title{ margin: 0; font-size: 17px; }
.iwsl-shell .iwsl-wz__x{ margin-left: auto; padding: 2px 6px; background: none; border: 0; border-radius: 8px; color: var(--iw-faint); font-size: 24px; line-height: 1; cursor: pointer; }
.iwsl-shell .iwsl-wz__x:hover{ color: var(--iw-ink); background: color-mix(in oklch, white 8%, transparent); }
.iwsl-shell .iwsl-wz__progress{ margin: 6px 0 12px; font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--iw-faint); }
.iwsl-shell .iwsl-wz__steps{ min-height: 150px; }
.iwsl-shell .iwsl-wz__step{ display: none; }
.iwsl-shell .iwsl-wz__step.is-active{ display: block; }
@media (prefers-reduced-motion: no-preference){ .iwsl-shell .iwsl-wz__step.is-active{ animation: iwsl-rise .28s var(--iw-ease) both; } }
.iwsl-shell .iwsl-wz__step h3{ margin: 0 0 8px; font-size: 15px; text-transform: none; letter-spacing: 0; }
.iwsl-shell .iwsl-wz__step h3::before{ display: none; }
.iwsl-shell .iwsl-wz__step p{ margin: 0 0 10px; }
.iwsl-shell .iwsl-wz__fields{ display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.iwsl-shell .iwsl-wz__field{ display: flex; flex-direction: column; gap: 5px; }
.iwsl-shell .iwsl-wz__field > span{ font-size: 12.5px; color: var(--iw-muted); }
.iwsl-shell .iwsl-wz__field input, .iwsl-shell .iwsl-wz__field select, .iwsl-shell .iwsl-wz__field textarea{ width: 100%; box-sizing: border-box; }
.iwsl-shell .iwsl-wz__check{ display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; font-size: 13px; }
.iwsl-shell .iwsl-wz__check .description{ color: var(--iw-muted); }
.iwsl-shell .iwsl-wz__note{ margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; font-size: 12.5px; background: color-mix(in oklch, var(--iw-signal) 8%, transparent); border: 1px solid color-mix(in oklch, var(--iw-signal) 26%, var(--iw-line)); }
.iwsl-shell .iwsl-wz__go{ margin-top: 14px; }
.iwsl-shell .iwsl-wz__nav{ display: flex; justify-content: space-between; gap: 10px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--iw-line); }
CSS;
		echo "\n</style>\n";

		echo "<script>\n";
		echo <<<'JS'
(function(){
	function wire(dlg){
		var steps = Array.prototype.slice.call(dlg.querySelectorAll('.iwsl-wz__step'));
		if (!steps.length) { return; }
		var nextBtn = dlg.querySelector('[data-wz-next]');
		var backBtn = dlg.querySelector('[data-wz-back]');
		var prog = dlg.querySelector('.iwsl-wz__progress');
		var tpl = prog ? (prog.getAttribute('data-wz-tpl') || 'Step {n} of {t}') : '';
		var cur = 0;
		function render(){
			steps.forEach(function(s, i){ s.classList.toggle('is-active', i === cur); });
			if (backBtn) { backBtn.style.visibility = cur === 0 ? 'hidden' : 'visible'; }
			if (nextBtn) { nextBtn.hidden = (cur === steps.length - 1); }
			if (prog) { prog.textContent = tpl.replace('{n}', String(cur + 1)).replace('{t}', String(steps.length)); }
			if (cur !== 0) {
				var f = steps[cur].querySelector('input, select, textarea, button');
				if (f) { try { f.focus(); } catch (e) {} }
			}
		}
		function go(i){ cur = Math.max(0, Math.min(steps.length - 1, i)); render(); }
		function close(){ try { dlg.close(); } catch (e) { dlg.removeAttribute('open'); } }
		dlg.__wzOpen = function(){
			cur = 0;
			if (typeof dlg.showModal === 'function') { try { dlg.showModal(); } catch (e) { dlg.setAttribute('open', ''); } }
			else { dlg.setAttribute('open', ''); }
			render();
		};
		dlg.addEventListener('click', function(e){
			if (e.target.closest('[data-wz-next]')) { go(cur + 1); }
			else if (e.target.closest('[data-wz-back]')) { go(cur - 1); }
			else if (e.target.closest('[data-wz-close]')) { close(); }
			else if (e.target === dlg) { close(); }
		});
		render();
	}
	var dialogs = {};
	Array.prototype.slice.call(document.querySelectorAll('[data-wz-dialog]')).forEach(function(dlg){
		dialogs[dlg.getAttribute('data-wz-dialog')] = dlg;
		wire(dlg);
	});
	Array.prototype.slice.call(document.querySelectorAll('[data-wz-open]')).forEach(function(b){
		b.addEventListener('click', function(e){
			e.preventDefault();
			var dlg = dialogs[b.getAttribute('data-wz-open')];
			if (dlg && typeof dlg.__wzOpen === 'function') { dlg.__wzOpen(); }
		});
	});
})();
JS;
		echo "\n</script>\n";
	}

	private function render_config_section(): void {
		$editor  = $this->config_editor();
		$current = $editor->current();
		$allow   = IWSL_Config_Editor::allowlist();

		// The PHP-limits target depends on the RUNNING SAPI: Apache mod_php honors
		// php_value in .htaccess and IGNORES .user.ini; FastCGI/FPM reads .user.ini.
		// The engine resolves this per request — the UI just mirrors what it chose
		// so we never claim a file that would do nothing.
		$php_mech      = $editor->php_limits_mechanism();
		$php_file      = ( 'htaccess' === $php_mech ) ? '.htaccess (Apache mod_php)' : '.user.ini (PHP-FPM)';
		$php_file_bare = ( 'htaccess' === $php_mech ) ? '.htaccess' : '.user.ini';

		echo '<hr style="margin:24px 0;">';
		echo '<h2>' . esc_html__( 'Configuration', 'infraweaver-connector' )
			. ' <span class="iwsl-adv-badge" style="display:inline-block;margin-left:8px;padding:2px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;vertical-align:middle;color:var(--iw-ink);border:1px solid color-mix(in oklch, var(--iw-warn) 55%, transparent);background:color-mix(in oklch, var(--iw-warn) 22%, transparent);">'
			. esc_html__( 'Advanced', 'infraweaver-connector' ) . '</span></h2>';
		echo '<p class="iwsl-adv-warn" style="display:flex;gap:7px;align-items:center;margin:6px 0 10px;font-size:13px;font-weight:600;color:var(--iw-ink);">'
			. '<span class="dashicons dashicons-warning" aria-hidden="true" style="color:var(--iw-warn);font-size:17px;width:17px;height:17px;flex:0 0 auto;"></span>'
			. esc_html__( 'Advanced — changing these can take your site offline. Only edit if you know what you\'re doing.', 'infraweaver-connector' )
			. '</p>';
		echo '<p>' . esc_html(
			sprintf(
				/* translators: %s: the per-directory PHP-limits file for the running server, e.g. ".htaccess (Apache mod_php)". */
				__( 'Edit a curated allow-list of WordPress and PHP settings. Constants are written to a managed block in wp-config.php; PHP limits to a managed %s. Only these known keys can ever be written — nothing else, and no raw PHP.', 'infraweaver-connector' ),
				$php_file
			)
		) . '</p>';

		$this->render_config_result_notice();

		$wp_writable  = $editor->wp_config_writable();
		$ini_writable = $editor->php_limits_writable();
		if ( ! $wp_writable || ! $ini_writable ) {
			echo '<div class="notice notice-warning inline" style="margin-top:12px;padding:12px;"><p>';
			if ( ! $wp_writable ) {
				echo esc_html__( 'wp-config.php is not writable — constant changes cannot be applied automatically and will be reported as a manual step.', 'infraweaver-connector' ) . ' ';
			}
			if ( ! $ini_writable ) {
				echo esc_html(
					sprintf(
						/* translators: %s: the PHP-limits file for the running server, e.g. ".htaccess". */
						__( 'The %s in the site root is not writable — PHP limit changes cannot be applied automatically.', 'infraweaver-connector' ),
						$php_file_bare
					)
				);
			}
			echo '</p></div>';
		}

		echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '" style="margin-top:16px;max-width:640px;">';
		wp_nonce_field( self::CONFIG_SAVE_NONCE );
		echo '<input type="hidden" name="action" value="' . esc_attr( self::CONFIG_SAVE_ACTION ) . '">';

		echo '<h3>' . esc_html__( 'WordPress constants (wp-config.php)', 'infraweaver-connector' ) . '</h3>';
		echo '<table class="form-table" role="presentation"><tbody>';
		foreach ( $allow as $key => $spec ) {
			if ( 'wpconfig' !== $spec['group'] ) {
				continue;
			}
			self::render_config_field( (string) $key, $spec, $current[ $key ] ?? '' );
		}
		echo '</tbody></table>';

		echo '<h3>' . esc_html(
			sprintf(
				/* translators: %s: the PHP-limits file for the running server, e.g. ".htaccess (Apache mod_php)". */
				__( 'PHP limits (%s)', 'infraweaver-connector' ),
				$php_file
			)
		) . '</h3>';
		echo '<table class="form-table" role="presentation"><tbody>';
		foreach ( $allow as $key => $spec ) {
			if ( 'userini' !== $spec['group'] ) {
				continue;
			}
			self::render_config_field( (string) $key, $spec, $current[ $key ] ?? '' );
		}
		echo '</tbody></table>';

		echo '<p><button type="submit" class="button button-primary">' . esc_html__( 'Apply configuration', 'infraweaver-connector' ) . '</button></p>';
		echo '</form>';
		echo '<p class="description" style="margin-top:8px;">' . esc_html(
			sprintf(
				/* translators: %1$s: mechanism label, e.g. "PHP-FPM re-reads .user.ini"; the sentence explains when PHP limits take effect. */
				__( 'Every value is validated against a per-key allow-list; anything that fails is rejected, never written. Constant changes take effect on the next request; PHP limits when %1$s.', 'infraweaver-connector' ),
				( 'htaccess' === $php_mech ) ? __( 'Apache re-reads .htaccess (next request)', 'infraweaver-connector' ) : __( 'PHP-FPM re-reads .user.ini', 'infraweaver-connector' )
			)
		) . '</p>';
	}

	/** One form-table row: a checkbox for a bool key, otherwise a text input pre-filled with the current value. */
	private static function render_config_field( string $key, array $spec, $value ): void {
		$label = isset( $spec['label'] ) ? (string) $spec['label'] : $key;
		$type  = (string) $spec['type'];
		$id    = 'iwsl-cfg-' . strtolower( str_replace( '_', '-', $key ) );

		echo '<tr><th scope="row"><label for="' . esc_attr( $id ) . '">' . esc_html( $label ) . '</label>' . iwsl_field_help( self::config_field_help( $key ) ) . '</th><td>';
		if ( 'bool' === $type ) {
			$checked = ! empty( $value ) ? ' checked' : '';
			echo '<input type="checkbox" id="' . esc_attr( $id ) . '" name="' . esc_attr( $key ) . '" value="1"' . $checked . '>';
		} else {
			$display = self::config_value_to_string( $value );
			echo '<input type="text" id="' . esc_attr( $id ) . '" name="' . esc_attr( $key ) . '" value="' . esc_attr( $display ) . '" class="regular-text">';
		}
		$hint = self::config_field_hint( $key );
		if ( '' !== $hint ) {
			echo '<br><span class="description">' . esc_html( $hint ) . '</span>';
		}
		echo '</td></tr>';
	}

	/** Render a scalar current value for a text input (bools render as checkboxes upstream). */
	private static function config_value_to_string( $value ): string {
		if ( is_bool( $value ) ) {
			return $value ? '1' : '';
		}
		if ( null === $value ) {
			return '';
		}
		return (string) $value;
	}

	/** A short per-key hint shown under each field. */
	private static function config_field_hint( string $key ): string {
		$hints = array(
			'WP_MEMORY_LIMIT'     => 'Memory size, e.g. 256M.',
			'WP_MAX_MEMORY_LIMIT' => 'Memory size for admin tasks, e.g. 512M.',
			'WP_POST_REVISIONS'   => 'Number of revisions to keep (0 or more); leave blank to disable revisions.',
			'EMPTY_TRASH_DAYS'    => 'Days before trash is emptied (0 or more).',
			'AUTOSAVE_INTERVAL'   => 'Autosave interval in seconds (10 or more).',
			'WP_DEBUG'            => 'Enable debug mode.',
			'WP_DEBUG_LOG'        => 'Log errors to wp-content/debug.log.',
			'WP_DEBUG_DISPLAY'    => 'Show errors in page output.',
			'DISALLOW_FILE_EDIT'  => 'Disable the built-in theme/plugin file editor.',
			'upload_max_filesize' => 'Max upload size, e.g. 64M.',
			'post_max_size'       => 'Max POST body size, e.g. 64M.',
			'max_execution_time'  => 'Max script run time in seconds.',
		);
		return isset( $hints[ $key ] ) ? $hints[ $key ] : '';
	}

	/** A plain-English, non-technical sentence for the "?" help badge on each config field. */
	private static function config_field_help( string $key ): string {
		$help = array(
			'WP_MEMORY_LIMIT'     => 'How much memory your site may use for normal pages.',
			'WP_MAX_MEMORY_LIMIT' => 'How much memory heavier admin tasks may use.',
			'WP_POST_REVISIONS'   => 'How many past versions of each post to keep.',
			'EMPTY_TRASH_DAYS'    => 'How many days deleted items wait before being emptied.',
			'AUTOSAVE_INTERVAL'   => 'How often the editor auto-saves your work, in seconds.',
			'WP_DEBUG'            => 'Turn on developer error reporting to troubleshoot problems.',
			'WP_DEBUG_LOG'        => 'Save errors to a log file instead of showing them.',
			'WP_DEBUG_DISPLAY'    => 'Show errors on the page (only while fixing issues).',
			'DISALLOW_FILE_EDIT'  => 'Block editing theme and plugin files from the dashboard.',
			'upload_max_filesize' => 'The largest single file that may be uploaded.',
			'post_max_size'       => 'The largest amount of data a form may submit.',
			'max_execution_time'  => 'How many seconds a task may run before stopping.',
		);
		return isset( $help[ $key ] ) ? $help[ $key ] : '';
	}

	/** Render (then clear) the current user's PRG apply result. */
	private function render_config_result_notice(): void {
		if ( ! function_exists( 'get_transient' ) || ! function_exists( 'get_current_user_id' ) ) {
			return;
		}
		$key    = 'iwsl_cfg_result_' . (int) get_current_user_id();
		$result = get_transient( $key );
		if ( function_exists( 'delete_transient' ) ) {
			delete_transient( $key );
		}
		if ( ! is_array( $result ) ) {
			return;
		}
		$applied = ( isset( $result['applied'] ) && is_array( $result['applied'] ) ) ? $result['applied'] : array();
		$skipped = ( isset( $result['skipped'] ) && is_array( $result['skipped'] ) ) ? $result['skipped'] : array();

		// Presentation only: ONE toast carries the whole apply result — the summary
		// line, the skipped list, deferred/manual notes, and the configured-vs-
		// effective PHP table. Semantics are unchanged: a warning accent when any
		// setting was skipped, success otherwise. (The seed carries no .notice
		// class, so WordPress never hoists it above the hero.)
		$variant = ! empty( $skipped ) ? 'warning' : 'success';
		self::toast_open( $variant );

		if ( ! empty( $applied ) ) {
			$count = count( $applied );
			echo '<p><strong>'
				. esc_html( sprintf( _n( 'Applied %d setting:', 'Applied %d settings:', $count, 'infraweaver-connector' ), $count ) )
				. '</strong> ' . esc_html( implode( ', ', array_map( 'strval', $applied ) ) ) . '</p>';
		} elseif ( empty( $skipped ) ) {
			echo '<p>' . esc_html__( 'No changes to apply.', 'infraweaver-connector' ) . '</p>';
		}

		if ( ! empty( $skipped ) ) {
			echo '<p class="iwsl-toast__sub"><strong>' . esc_html__( 'Some settings were not applied:', 'infraweaver-connector' ) . '</strong></p><ul>';
			foreach ( $skipped as $k => $reason ) {
				echo '<li>' . esc_html( (string) $k . ' — ' . (string) $reason ) . '</li>';
			}
			echo '</ul>';
		}

		if ( ! empty( $result['manual_step'] ) ) {
			echo '<p class="iwsl-toast__sub">' . esc_html( (string) $result['manual_step'] ) . '</p>';
		}

		// Engine-supplied notes explain deferred effects (e.g. "PHP limits take
		// effect on the next request…") so a successful apply never implies an
		// instant change that hasn't actually landed yet.
		if ( ! empty( $result['notes'] ) && is_array( $result['notes'] ) ) {
			foreach ( $result['notes'] as $note ) {
				if ( '' === (string) $note ) {
					continue;
				}
				echo '<p class="iwsl-toast__sub">' . esc_html( (string) $note ) . '</p>';
			}
		}

		// Configured-vs-effective PHP limits: what we last WROTE to the managed
		// block next to the live ini_get() value. When they differ the change is
		// pending (PHP re-reads the file on the next request) — spell that out
		// instead of showing the old effective value as if nothing happened.
		$this->render_config_php_limits_state();

		self::toast_close();
	}

	/**
	 * A small info panel comparing the PHP limits we CONFIGURED (read back from the
	 * managed .htaccess/.user.ini block) against the live effective ini_get()
	 * values, flagging any that are still pending a PHP re-read. Rendered only when
	 * at least one PHP limit has actually been written. Read-only; side-effect free.
	 */
	private function render_config_php_limits_state(): void {
		$editor     = $this->config_editor();
		$configured = $editor->configured_php_limits();
		$configured = array_filter( $configured, static function ( $v ) {
			return '' !== (string) $v;
		} );
		if ( empty( $configured ) ) {
			return;
		}
		$current = $editor->current();
		$pending = false;

		$rows = '';
		foreach ( $configured as $key => $written ) {
			$effective = self::config_value_to_string( $current[ $key ] ?? '' );
			$is_diff   = ( (string) $written !== (string) $effective );
			$pending   = $pending || $is_diff;
			$state     = $is_diff
				? '<span style="color:var(--iw-warn);font-weight:650;">' . esc_html__( 'pending', 'infraweaver-connector' ) . '</span>'
				: '<span style="color:var(--iw-good);font-weight:650;">' . esc_html__( 'live', 'infraweaver-connector' ) . '</span>';
			$rows     .= '<tr><td><code>' . esc_html( (string) $key ) . '</code></td>'
				. '<td>' . esc_html( (string) $written ) . '</td>'
				. '<td>' . esc_html( '' === $effective ? '—' : $effective ) . '</td>'
				. '<td>' . $state . '</td></tr>';
		}

		$note = $pending
			? esc_html__( 'These PHP limits are written but not yet live — PHP applies them on its next request.', 'infraweaver-connector' )
			: esc_html__( 'All configured PHP limits are live.', 'infraweaver-connector' );

		echo '<div class="iwsl-toast__block">';
		echo '<p class="iwsl-toast__sub" style="margin-top:0;"><strong>' . esc_html__( 'PHP limits — configured vs. effective', 'infraweaver-connector' ) . '</strong></p>';
		echo '<table class="widefat striped"><thead><tr>'
			. '<th>' . esc_html__( 'Setting', 'infraweaver-connector' ) . '</th>'
			. '<th>' . esc_html__( 'Configured', 'infraweaver-connector' ) . '</th>'
			. '<th>' . esc_html__( 'Effective now', 'infraweaver-connector' ) . '</th>'
			. '<th>' . esc_html__( 'Status', 'infraweaver-connector' ) . '</th>'
			. '</tr></thead><tbody>' . $rows . '</tbody></table>';
		echo '<p class="iwsl-toast__sub" style="margin-bottom:0;">' . $note . '</p>';
		echo '</div>';
	}

	/**
	 * admin-post handler: apply the config editor. Gate = manage_options + nonce.
	 * Builds the input map from POST for ALLOW-LISTED keys ONLY (everything else —
	 * action, nonce, referer, unknown keys — is ignored). Bools are coerced from
	 * checkbox presence so an unchecked box writes an explicit false; empty text
	 * fields are omitted (left unchanged) rather than rejected. POST-redirect-GET;
	 * the page's JS restores the Config tab from localStorage.
	 */
	public function handle_config_save(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to run this action.', 'infraweaver-connector' ) );
		}
		check_admin_referer( self::CONFIG_SAVE_NONCE );

		$redirect = iwsl_plus_redirect_base();

		$input = array();
		foreach ( IWSL_Config_Editor::allowlist() as $key => $spec ) {
			if ( 'bool' === $spec['type'] ) {
				$input[ $key ] = isset( $_POST[ $key ] ) ? '1' : '0'; // phpcs:ignore WordPress.Security.NonceVerification.Missing
				continue;
			}
			if ( ! isset( $_POST[ $key ] ) ) {
				continue;
			}
			$raw = wp_unslash( $_POST[ $key ] ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized,WordPress.Security.NonceVerification.Missing
			if ( ! is_scalar( $raw ) ) {
				continue;
			}
			$clean = sanitize_text_field( (string) $raw );
			if ( '' !== $clean ) {
				$input[ $key ] = $clean;
			} elseif ( 'int_or_false' === $spec['type'] ) {
				$input[ $key ] = false; // an explicit blank disables (false).
			}
		}

		$result = $this->config_editor()->apply( $input );

		if ( function_exists( 'set_transient' ) && function_exists( 'get_current_user_id' ) ) {
			set_transient( 'iwsl_cfg_result_' . (int) get_current_user_id(), $result, 60 );
		}
		wp_safe_redirect( $redirect );
		exit;
	}
}
