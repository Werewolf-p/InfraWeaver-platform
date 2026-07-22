<?php
/**
 * SEO Suite (gate flag `seo_suite`): the pure analysis engine (IWSL_SEO_Analyzer),
 * the pure head builder (IWSL_SEO_Head), the pure sitemap builder
 * (IWSL_SEO_Sitemap), and the WP-facing orchestrator (IWSL_SEO_Suite).
 *
 * Runs under the zero-dependency harness. The three helpers are pure so they need
 * NO stubs; the orchestrator is exercised with an in-memory IWSL_Store, a fixed
 * clock, and a RECORDING meta writer / add_meta_box recorder. The gate fixtures
 * reuse the entitlement store so a single flip re-locks instantly. This suite
 * defines its own guarded WP stubs and unsets every global it installs so it can
 * never leak into another suite.
 */

// ── recording WP stubs (guarded; unset at the end of the file) ────────────────

$GLOBALS['iwseo_meta_boxes'] = array();
if ( ! function_exists( 'add_meta_box' ) ) {
	function add_meta_box( $id, $title, $cb, $screen = null, $context = 'advanced', $priority = 'default' ) {
		$GLOBALS['iwseo_meta_boxes'][] = array( 'id' => $id, 'screen' => $screen );
	}
}
// Escaping stubs so the meta-box render (guarded on esc_html) exercises here; each
// mirrors WordPress's htmlspecialchars behaviour and is function_exists-guarded so
// it can never collide with another suite (the runner isolates suites anyway).
if ( ! function_exists( 'esc_html' ) ) {
	function esc_html( $s ) {
		return htmlspecialchars( (string) $s, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_attr' ) ) {
	function esc_attr( $s ) {
		return htmlspecialchars( (string) $s, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_url' ) ) {
	function esc_url( $s ) {
		return htmlspecialchars( (string) $s, ENT_QUOTES, 'UTF-8' );
	}
}

// ── fixtures ──────────────────────────────────────────────────────────────────

$SEO_NOW = 30000000;

/** Seed a store unlocked (active + fresh heartbeat + seo_suite) and return the gate. */
function iwsl_seo_unlocked( IWSL_Store $store, int $now ): IWSL_Entitlements {
	$store->set( 'state', 'active' );
	$store->set( 'last_verified_at', $now - 1000 );
	$store->set( 'entitlements', array( 'seo_suite' => true ) );
	return new IWSL_Entitlements(
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** Build a SEO Suite engine over $store with a fixed clock. */
function iwsl_seo_engine( IWSL_Store $store, int $now ): IWSL_SEO_Suite {
	return new IWSL_SEO_Suite(
		iwsl_seo_unlocked( $store, $now ),
		$store,
		static function () use ( $now ): int {
			return $now;
		}
	);
}

/** N keyphrase occurrences ('widget') across W total words. density = 100·N/W. */
function iwsl_seo_density_content( int $n, int $w ): string {
	return trim( str_repeat( 'widget ', $n ) . str_repeat( 'lorem ', max( 0, $w - $n ) ) );
}

/** $long 21-word sentences + $short 3-word sentences. */
function iwsl_seo_sentences( int $long, int $short ): string {
	$l = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone.';
	$s = 'cats run fast.';
	return trim( str_repeat( $l . ' ', $long ) . str_repeat( $s . ' ', $short ) );
}

/** $p passive sentences + $a active sentences. */
function iwsl_seo_passive( int $p, int $a ): string {
	return trim( str_repeat( 'The cake was eaten. ', $p ) . str_repeat( 'She ate the cake. ', $a ) );
}

/** $t sentences with a transition word + $n without. */
function iwsl_seo_transitions( int $t, int $n ): string {
	return trim( str_repeat( 'However cats run quickly. ', $t ) . str_repeat( 'Cats run quickly today. ', $n ) );
}

/** Status of one check in a checks list. */
function iwsl_seo_check_status( array $checks, string $id ): string {
	$c = IWSL_SEO_Analyzer::by_id( $checks, $id );
	return is_array( $c ) ? (string) $c['status'] : 'MISSING';
}

/** Contents of an OG/Twitter meta tag by key. */
function iwsl_seo_meta_content( array $tags, string $key ): string {
	foreach ( $tags as $t ) {
		if ( $t['key'] === $key ) {
			return $t['content'];
		}
	}
	return '';
}

/** All @type values in a schema graph. @return string[] */
function iwsl_seo_graph_types( array $doc ): array {
	$out = array();
	foreach ( (array) ( $doc['@graph'] ?? array() ) as $node ) {
		if ( isset( $node['@type'] ) ) {
			$out[] = (string) $node['@type'];
		}
	}
	return $out;
}

// ── 1. Analyzer: keyphrase presence / absence in title + beginning ────────────

$r = IWSL_SEO_Analyzer::analyze( array( 'keyphrase' => 'coffee grinder', 'title' => 'Coffee Grinder Reviews' ) );
iwsl_assert_same( 'green', iwsl_seo_check_status( $r['seo']['checks'], 'keyphrase_in_title' ), 'title: all keyphrase words present → green' );
iwsl_assert_same( 'green', iwsl_seo_check_status( $r['seo']['checks'], 'keyphrase_in_title_beginning' ), 'title-beginning: exact match at start → green' );

$r = IWSL_SEO_Analyzer::analyze( array( 'keyphrase' => 'coffee grinder', 'title' => 'Best Coffee Grinder' ) );
iwsl_assert_same( 'orange', iwsl_seo_check_status( $r['seo']['checks'], 'keyphrase_in_title_beginning' ), 'title-beginning: present but not first → orange' );

$r = IWSL_SEO_Analyzer::analyze( array( 'keyphrase' => 'coffee grinder', 'title' => 'Kettle Reviews' ) );
iwsl_assert_same( 'red', iwsl_seo_check_status( $r['seo']['checks'], 'keyphrase_in_title' ), 'title: keyphrase absent → red' );

// No keyphrase → the SEO side is an explicit n/a state (Appendix A).
$r = IWSL_SEO_Analyzer::analyze( array( 'keyphrase' => '', 'title' => 'Anything', 'content' => 'Some words here.' ) );
iwsl_assert_same( 'na', $r['seo']['rating'], 'no keyphrase → SEO rating na' );
iwsl_assert_same( 1, count( $r['seo']['checks'] ), 'no keyphrase → single focus_keyphrase check' );
iwsl_assert_same( 'focus_keyphrase', $r['seo']['checks'][0]['id'], 'no keyphrase → the check is focus_keyphrase' );

// ── 2. Analyzer: keyphrase length bands ───────────────────────────────────────

iwsl_assert_same( 'green', iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( array( 'keyphrase' => 'coffee grinder' ) )['seo']['checks'], 'keyphrase_length' ), 'kw length 2 words → green' );
iwsl_assert_same( 'orange', iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( array( 'keyphrase' => 'best coffee grinder maker deluxe' ) )['seo']['checks'], 'keyphrase_length' ), 'kw length 5 words → orange' );
iwsl_assert_same( 'red', iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( array( 'keyphrase' => 'alpha beta gamma delta epsilon zeta eta' ) )['seo']['checks'], 'keyphrase_length' ), 'kw length 7 words → red' );

// ── 3. Analyzer: density band edges (0.5% and 3.0%) ───────────────────────────

$density = static function ( int $n, int $w ): string {
	$paper = array( 'keyphrase' => 'widget', 'content' => iwsl_seo_density_content( $n, $w ) );
	return iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( $paper )['seo']['checks'], 'keyphrase_density' );
};
iwsl_assert_same( 'red', $density( 0, 200 ), 'density 0% → red' );
iwsl_assert_same( 'green', $density( 1, 200 ), 'density exactly 0.5% → green (inclusive lower edge)' );
iwsl_assert_same( 'red', $density( 1, 300 ), 'density 0.33% (<0.5) → red' );
iwsl_assert_same( 'green', $density( 6, 200 ), 'density exactly 3.0% → green (inclusive upper edge)' );
iwsl_assert_same( 'red', $density( 7, 200 ), 'density 3.5% (>3) → red' );

// ── 4. Analyzer: meta description length limits ───────────────────────────────

$meta_len = static function ( int $len ): string {
	$paper = array( 'keyphrase' => 'widget', 'meta' => str_repeat( 'a', $len ) );
	return iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( $paper )['seo']['checks'], 'meta_length' );
};
iwsl_assert_same( 'red', $meta_len( 0 ), 'meta length 0 → red' );
iwsl_assert_same( 'orange', $meta_len( 119 ), 'meta length 119 (<120) → orange' );
iwsl_assert_same( 'green', $meta_len( 120 ), 'meta length 120 → green (lower edge)' );
iwsl_assert_same( 'green', $meta_len( 156 ), 'meta length 156 → green (upper edge)' );
iwsl_assert_same( 'orange', $meta_len( 157 ), 'meta length 157 (>156) → orange' );

// ── 5. Analyzer: title pixel-width limits (explicit title_width) ───────────────

$title_w = static function ( int $px ): string {
	$paper = array( 'keyphrase' => 'widget', 'title_width' => $px );
	return iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( $paper )['seo']['checks'], 'title_width' );
};
iwsl_assert_same( 'orange', $title_w( 400 ), 'title width 400 (<401) → orange' );
iwsl_assert_same( 'green', $title_w( 401 ), 'title width 401 → green (lower edge)' );
iwsl_assert_same( 'green', $title_w( 600 ), 'title width 600 → green (upper edge)' );
iwsl_assert_same( 'red', $title_w( 601 ), 'title width 601 (>600) → red' );

// ── 6. Analyzer: readability — sentence length % (25/30 edges) ─────────────────

$sent = static function ( int $long, int $short ): string {
	return iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( array( 'content' => iwsl_seo_sentences( $long, $short ) ) )['readability']['checks'], 'sentence_length' );
};
iwsl_assert_same( 'green', $sent( 5, 15 ), 'sentence length 25% long → green (edge)' );
iwsl_assert_same( 'orange', $sent( 6, 14 ), 'sentence length 30% long → orange (edge)' );
iwsl_assert_same( 'red', $sent( 7, 13 ), 'sentence length 35% long → red' );

// ── 7. Analyzer: readability — passive voice % (10/15 edges) ──────────────────

$passive = static function ( int $p, int $a ): string {
	return iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( array( 'content' => iwsl_seo_passive( $p, $a ) ) )['readability']['checks'], 'passive_voice' );
};
iwsl_assert_same( 'green', $passive( 1, 9 ), 'passive 10% → green (edge)' );
iwsl_assert_same( 'orange', $passive( 3, 17 ), 'passive 15% → orange (edge)' );
iwsl_assert_same( 'red', $passive( 2, 8 ), 'passive 20% → red' );

// ── 8. Analyzer: readability — transition words % (30/20 edges) ───────────────

$trans = static function ( int $t, int $n ): string {
	return iwsl_seo_check_status( IWSL_SEO_Analyzer::analyze( array( 'content' => iwsl_seo_transitions( $t, $n ) ) )['readability']['checks'], 'transition_words' );
};
iwsl_assert_same( 'green', $trans( 3, 7 ), 'transitions 30% → green (edge)' );
iwsl_assert_same( 'orange', $trans( 2, 8 ), 'transitions 20% → orange (edge)' );
iwsl_assert_same( 'red', $trans( 1, 9 ), 'transitions 10% → red' );

// ── 9. Analyzer: consecutive sentence starts + Flesch ─────────────────────────

$consec = IWSL_SEO_Analyzer::analyze( array( 'content' => 'Widgets are great. Widgets sell well. Widgets ship fast. We agree.' ) );
iwsl_assert_same( 'red', iwsl_seo_check_status( $consec['readability']['checks'], 'consecutive_sentences' ), 'consecutive: 3 sentences start "Widgets" → red' );

$easy = IWSL_SEO_Analyzer::analyze( array( 'content' => 'The cat sat. The dog ran. We go home. She is nice. He is kind.' ) );
iwsl_assert_same( 'green', iwsl_seo_check_status( $easy['readability']['checks'], 'flesch' ), 'flesch: short simple text → green' );
$hard = IWSL_SEO_Analyzer::analyze( array( 'content' => 'Consequently, the aforementioned multifaceted infrastructural considerations necessitate comprehensive interdisciplinary collaboration throughout organizational restructuring initiatives undertaken systematically nationwide.' ) );
iwsl_assert_same( 'red', iwsl_seo_check_status( $hard['readability']['checks'], 'flesch' ), 'flesch: dense polysyllabic text → red' );

// Non-English disables language checks with an honest n/a.
$nonen = IWSL_SEO_Analyzer::analyze( array( 'content' => 'Bonjour le monde. Ceci est un test.', 'locale' => 'fr_FR' ) );
iwsl_assert_same( 'na', iwsl_seo_check_status( $nonen['readability']['checks'], 'passive_voice' ), 'non-English → passive voice n/a' );
iwsl_assert_same( 'na', iwsl_seo_check_status( $nonen['readability']['checks'], 'flesch' ), 'non-English → Flesch n/a' );

// ── 10. Aggregate → traffic-light mapping (40/70) ─────────────────────────────

iwsl_assert_same( 'red', IWSL_SEO_Analyzer::overall_rating( 1 ), 'overall 1 → red' );
iwsl_assert_same( 'red', IWSL_SEO_Analyzer::overall_rating( 40 ), 'overall 40 → red (upper red edge)' );
iwsl_assert_same( 'orange', IWSL_SEO_Analyzer::overall_rating( 41 ), 'overall 41 → orange (lower ok edge)' );
iwsl_assert_same( 'orange', IWSL_SEO_Analyzer::overall_rating( 70 ), 'overall 70 → orange (upper ok edge)' );
iwsl_assert_same( 'green', IWSL_SEO_Analyzer::overall_rating( 71 ), 'overall 71 → green (lower good edge)' );
iwsl_assert_same( 'green', IWSL_SEO_Analyzer::overall_rating( 100 ), 'overall 100 → green' );

$agg = IWSL_SEO_Analyzer::aggregate( array(
	array( 'id' => 'a', 'status' => 'green', 'score' => 9 ),
	array( 'id' => 'b', 'status' => 'green', 'score' => 9 ),
) );
iwsl_assert_same( 100, $agg['score'], 'aggregate: all green → 100' );
iwsl_assert_same( 'green', $agg['rating'], 'aggregate: all green → green' );

$agg = IWSL_SEO_Analyzer::aggregate( array(
	array( 'id' => 'a', 'status' => 'red', 'score' => 3 ),
	array( 'id' => 'b', 'status' => 'red', 'score' => 3 ),
) );
iwsl_assert_same( 33, $agg['score'], 'aggregate: all red (3/9) → 33' );
iwsl_assert_same( 'red', $agg['rating'], 'aggregate: 33 → red' );

$agg = IWSL_SEO_Analyzer::aggregate( array(
	array( 'id' => 'a', 'status' => 'green', 'score' => 9 ),
	array( 'id' => 'b', 'status' => 'na', 'score' => 0 ),
) );
iwsl_assert_same( 100, $agg['score'], 'aggregate: na checks are excluded' );

// ── 11. Head: template-variable resolution ────────────────────────────────────

iwsl_assert_same(
	'Hello - My Site',
	IWSL_SEO_Head::replace_vars( '%%title%% %%sep%% %%sitename%%', array( 'title' => 'Hello', 'sep' => '-', 'sitename' => 'My Site' ) ),
	'replace_vars: %%title%% %%sep%% %%sitename%%'
);
iwsl_assert_same(
	'Hello',
	IWSL_SEO_Head::replace_vars( '%%title%% %%sep%% %%category%%', array( 'title' => 'Hello', 'sep' => '-' ) ),
	'replace_vars: unknown %%category%% stripped + dangling separator collapsed'
);
iwsl_assert_same(
	'Widgets - 2026',
	IWSL_SEO_Head::replace_vars( '%%title%% %%sep%% %%currentyear%%', array( 'title' => 'Widgets', 'sep' => '-', 'currentyear' => '2026' ) ),
	'replace_vars: %%currentyear%%'
);

// ── 12. Head: robots directives from context ──────────────────────────────────

iwsl_assert_same(
	array( 'index', 'follow', 'max-snippet:-1', 'max-image-preview:large', 'max-video-preview:-1' ),
	IWSL_SEO_Head::robots_directives( array() ),
	'robots: default indexable page gets index,follow + max-* permissions'
);
iwsl_assert_same(
	array( 'noindex', 'follow' ),
	IWSL_SEO_Head::robots_directives( array( 'noindex' => true ) ),
	'robots: noindex drops the snippet permissions'
);
iwsl_assert_same(
	array( 'index', 'nofollow', 'max-snippet:-1', 'max-image-preview:large', 'max-video-preview:-1' ),
	IWSL_SEO_Head::robots_directives( array( 'nofollow' => true ) ),
	'robots: nofollow composes with index + permissions'
);
iwsl_assert_same(
	array( 'index', 'follow', 'nosnippet' ),
	IWSL_SEO_Head::robots_directives( array( 'robots_adv' => array( 'nosnippet' ) ) ),
	'robots: nosnippet advanced flag suppresses the max-* permissions'
);

// ── 13. Head: OG / Twitter meta tag shape ─────────────────────────────────────

$ctx = array(
	'title'       => 'Coffee Grinder Reviews',
	'description' => 'The best grinders, tested.',
	'canonical'   => 'https://example.com/coffee-grinder',
	'site_name'   => 'Example',
	'locale'      => 'en-US',
	'og'          => array( 'type' => 'article', 'image' => 'https://example.com/img.jpg', 'image_width' => 1200, 'image_height' => 630 ),
	'twitter'     => array( 'site' => '@example' ),
	'published'   => '2026-07-21T10:00:00+00:00',
);
$tags = IWSL_SEO_Head::meta_tags( $ctx );
iwsl_assert_same( 'The best grinders, tested.', iwsl_seo_meta_content( $tags, 'description' ), 'meta: description present' );
iwsl_assert_same( 'article', iwsl_seo_meta_content( $tags, 'og:type' ), 'meta: og:type=article' );
iwsl_assert_same( 'Coffee Grinder Reviews', iwsl_seo_meta_content( $tags, 'og:title' ), 'meta: og:title falls back to title' );
iwsl_assert_same( 'https://example.com/coffee-grinder', iwsl_seo_meta_content( $tags, 'og:url' ), 'meta: og:url = canonical' );
iwsl_assert_same( 'https://example.com/img.jpg', iwsl_seo_meta_content( $tags, 'og:image' ), 'meta: og:image from cascade' );
iwsl_assert_same( '1200', iwsl_seo_meta_content( $tags, 'og:image:width' ), 'meta: og:image:width' );
iwsl_assert_same( '2026-07-21T10:00:00+00:00', iwsl_seo_meta_content( $tags, 'article:published_time' ), 'meta: article:published_time on article type' );
iwsl_assert_same( 'summary_large_image', iwsl_seo_meta_content( $tags, 'twitter:card' ), 'meta: twitter:card default' );
iwsl_assert_same( '@example', iwsl_seo_meta_content( $tags, 'twitter:site' ), 'meta: twitter:site' );

// Image cascade order: per-post image beats featured/default.
iwsl_assert_same(
	'https://example.com/post.jpg',
	IWSL_SEO_Head::og_image( array( 'og' => array( 'image' => 'https://example.com/post.jpg', 'featured' => 'https://example.com/feat.jpg', 'default_image' => 'https://example.com/def.jpg' ) ) ),
	'og_image cascade: per-post image wins'
);
iwsl_assert_same(
	'https://example.com/def.jpg',
	IWSL_SEO_Head::og_image( array( 'og' => array( 'default_image' => 'https://example.com/def.jpg' ) ) ),
	'og_image cascade: falls through to the site default'
);

// ── 14. Head: JSON-LD @graph shape ────────────────────────────────────────────

$ctx = array(
	'home_url'    => 'https://example.com',
	'canonical'   => 'https://example.com/coffee-grinder',
	'title'       => 'Coffee Grinder Reviews',
	'description' => 'Tested grinders.',
	'site_name'   => 'Example',
	'locale'      => 'en-US',
	'author'      => 'Jane Roe',
	'og'          => array( 'image' => 'https://example.com/img.jpg' ),
	'schema'      => array(
		'representation' => array( 'type' => 'organization', 'name' => 'Example', 'logo' => 'https://example.com/logo.png', 'same_as' => array( 'https://x.com/example' ) ),
		'page_type'      => 'WebPage',
		'article_type'   => 'Article',
		'breadcrumbs'    => array(
			array( 'name' => 'Home', 'url' => 'https://example.com/' ),
			array( 'name' => 'Coffee Grinder Reviews', 'url' => 'https://example.com/coffee-grinder' ),
		),
	),
);
$graph = IWSL_SEO_Head::schema_graph( $ctx );
iwsl_assert_same( 'https://schema.org', $graph['@context'], 'schema: @context' );
$types = iwsl_seo_graph_types( $graph );
iwsl_assert( in_array( 'Organization', $types, true ), 'schema: Organization node present' );
iwsl_assert( in_array( 'WebSite', $types, true ), 'schema: WebSite node present' );
iwsl_assert( in_array( 'WebPage', $types, true ), 'schema: WebPage node present' );
iwsl_assert( in_array( 'Article', $types, true ), 'schema: Article node present' );
iwsl_assert( in_array( 'BreadcrumbList', $types, true ), 'schema: BreadcrumbList node present' );
iwsl_assert( in_array( 'ImageObject', $types, true ), 'schema: primary ImageObject present' );
iwsl_assert( in_array( 'Person', $types, true ), 'schema: author Person node present' );

// No article type → no Article node (page).
$graph2 = IWSL_SEO_Head::schema_graph( array(
	'home_url' => 'https://example.com',
	'canonical' => 'https://example.com/about',
	'title' => 'About',
	'site_name' => 'Example',
	'schema' => array( 'representation' => array( 'type' => 'organization', 'name' => 'Example' ), 'page_type' => 'AboutPage', 'article_type' => '' ),
) );
iwsl_assert( ! in_array( 'Article', iwsl_seo_graph_types( $graph2 ), true ), 'schema: page with no article type omits Article' );
iwsl_assert( in_array( 'AboutPage', iwsl_seo_graph_types( $graph2 ), true ), 'schema: WebPage @type honours page_type=AboutPage' );

// render_head string carries canonical + description + JSON-LD script.
$head = IWSL_SEO_Head::render_head( $ctx );
iwsl_assert( false !== strpos( $head, 'rel="canonical"' ), 'render_head: canonical link present' );
iwsl_assert( false !== strpos( $head, 'application/ld+json' ), 'render_head: JSON-LD script present' );
iwsl_assert( false !== strpos( $head, 'name="description"' ), 'render_head: description meta present' );

// ── 15. Sitemap: noindex exclusion + pagination ───────────────────────────────

$entries = array(
	array( 'loc' => 'https://example.com/a', 'noindex' => false ),
	array( 'loc' => 'https://example.com/b', 'noindex' => true ),
	array( 'loc' => 'https://example.com/c', 'noindex' => false ),
);
$idx = IWSL_SEO_Sitemap::filter_indexable( $entries );
iwsl_assert_same( 2, count( $idx ), 'sitemap: noindex entry excluded' );
iwsl_assert_same( 'https://example.com/a', $idx[0]['loc'], 'sitemap: first indexable kept in order' );

$big = array();
for ( $i = 0; $i < 2500; $i++ ) {
	$big[] = array( 'loc' => 'https://example.com/p' . $i, 'noindex' => false );
}
$pages = IWSL_SEO_Sitemap::paginate( $big );
iwsl_assert_same( 3, count( $pages ), 'sitemap: 2500 entries → 3 pages' );
iwsl_assert_same( 1000, count( $pages[0] ), 'sitemap: page 1 holds 1000' );
iwsl_assert_same( 500, count( $pages[2] ), 'sitemap: page 3 holds the remaining 500' );

$index_xml = IWSL_SEO_Sitemap::index_xml( array( array( 'loc' => 'https://example.com/post-sitemap.xml', 'lastmod' => '2026-07-21' ) ) );
iwsl_assert( false !== strpos( $index_xml, '<sitemapindex' ), 'sitemap index: <sitemapindex> present' );
iwsl_assert( false !== strpos( $index_xml, 'post-sitemap.xml' ), 'sitemap index: child loc present' );

$urlset = IWSL_SEO_Sitemap::urlset_xml( array(
	array( 'loc' => 'https://example.com/a', 'lastmod' => '2026-07-21', 'noindex' => false, 'images' => array( 'https://example.com/i.jpg' ) ),
	array( 'loc' => 'https://example.com/b', 'noindex' => true ),
) );
iwsl_assert( false !== strpos( $urlset, '<urlset' ), 'urlset: <urlset> present' );
iwsl_assert( false !== strpos( $urlset, '<image:loc>https://example.com/i.jpg</image:loc>' ), 'urlset: image entry folded in' );
iwsl_assert( false === strpos( $urlset, 'https://example.com/b' ), 'urlset: noindex entry excluded from XML' );

// ── 16. Engine: save persists sanitized _iwseo_* meta + scores (unlocked) ─────

$store = new IWSL_Memory_Store();
$eng = iwsl_seo_engine( $store, $SEO_NOW );
$written = array();
$writer = static function ( string $k, $v ) use ( &$written ): void {
	$written[ $k ] = $v;
};
$res = $eng->save_post_meta(
	123,
	array(
		'title'       => "Coffee Grinder\x00 Guide",
		'desc'        => 'The best grinders, tested and ranked.',
		'focuskw'     => 'coffee grinder',
		'canonical'   => 'https://example.com/coffee-grinder',
		'noindex'     => true,
		'nofollow'    => false,
		'robots_adv'  => array( 'noarchive', 'bogus' ),
		'og_image'    => 'https://example.com/img.jpg',
		'cornerstone' => true,
		'page_type'   => 'FAQPage',
		'article_type' => 'NewsArticle',
		'content'     => '<p>Coffee grinder buyers guide with plenty of words about the coffee grinder.</p>',
		'slug'        => 'coffee-grinder',
		'post_type'   => 'post',
		'locale'      => 'en_US',
	),
	$writer
);
iwsl_assert_same( true, $res['ok'], 'save: ok=true when unlocked' );
iwsl_assert_same( 'Coffee Grinder Guide', $written['_iwseo_title'], 'save: title control char stripped' );
iwsl_assert_same( 'coffee grinder', $written['_iwseo_focuskw'], 'save: focus keyphrase persisted' );
iwsl_assert_same( '1', $written['_iwseo_noindex'], 'save: noindex cast to "1"' );
iwsl_assert_same( '', $written['_iwseo_nofollow'], 'save: nofollow off → ""' );
iwsl_assert_same( 'noarchive', $written['_iwseo_robots_adv'], 'save: advanced robots whitelisted (bogus dropped)' );
iwsl_assert_same( 'https://example.com/img.jpg', $written['_iwseo_og_image'], 'save: og image URL kept' );
iwsl_assert_same( '1', $written['_iwseo_cornerstone'], 'save: cornerstone cast to "1"' );
iwsl_assert_same( 'FAQPage', $written['_iwseo_page_type'], 'save: schema page type kept' );
iwsl_assert_same( true, is_int( $written['_iwseo_score'] ), 'save: numeric SEO score persisted' );
iwsl_assert_same( true, is_int( $written['_iwseo_read_score'] ), 'save: numeric readability score persisted' );

// Bad canonical (scheme-relative) is dropped to '' by the URL gauntlet.
$written2 = array();
$eng->save_post_meta( 9, array( 'focuskw' => 'x', 'canonical' => '//evil.example/x', 'content' => 'hi' ), static function ( $k, $v ) use ( &$written2 ) {
	$written2[ $k ] = $v; } );
iwsl_assert_same( '', $written2['_iwseo_canonical'], 'save: scheme-relative canonical rejected → ""' );

// ── 17. Gate: locked blocks save (no meta written) ────────────────────────────

$store = new IWSL_Memory_Store();
$store->set( 'state', 'active' );
$store->set( 'last_verified_at', $SEO_NOW - 1000 );
$store->set( 'entitlements', array( 'plus' => true ) ); // seo_suite ABSENT
$ent = new IWSL_Entitlements( $store, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } );
$eng = new IWSL_SEO_Suite( $ent, $store, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } );
$touched = false;
$res = $eng->save_post_meta( 1, array( 'focuskw' => 'x', 'content' => 'hi' ), static function () use ( &$touched ) {
	$touched = true; } );
iwsl_assert_same( false, $res['ok'], 'locked (flag absent): save ok=false' );
iwsl_assert_same( 'entitlement-locked', $res['reason'], 'locked (flag absent): entitlement-locked' );
iwsl_assert_same( false, $touched, 'locked (flag absent): writer never called' );

// ── 18. Gate: locked blocks head output + meta box + sitemap + settings ───────

ob_start();
$eng->render_head();
iwsl_assert_same( '', ob_get_clean(), 'locked: render_head emits nothing' );

$GLOBALS['iwseo_meta_boxes'] = array();
$eng->register_meta_boxes();
iwsl_assert_same( 0, count( $GLOBALS['iwseo_meta_boxes'] ), 'locked: no meta box registered' );

$_SERVER['REQUEST_URI'] = '/sitemap_index.xml';
ob_start();
$eng->maybe_serve_sitemap();
iwsl_assert_same( '', ob_get_clean(), 'locked: maybe_serve_sitemap serves nothing (no exit)' );

$store->set( 'seo_settings', null );
$sv = $eng->save_settings( array( 'separator' => '|' ) );
iwsl_assert_same( 'entitlement-locked', $sv['reason'], 'locked: save_settings refused' );
iwsl_assert_same( null, $store->get( 'seo_settings' ), 'locked: settings store untouched' );

// ── 19. Gate: not-linked and stale-heartbeat also lock ────────────────────────

$store_p = new IWSL_Memory_Store();
$store_p->set( 'state', 'pending' );
$store_p->set( 'last_verified_at', $SEO_NOW - 1000 );
$store_p->set( 'entitlements', array( 'seo_suite' => true ) );
$eng_p = new IWSL_SEO_Suite( new IWSL_Entitlements( $store_p, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } ), $store_p, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } );
$touched = false;
$eng_p->save_post_meta( 1, array( 'focuskw' => 'x' ), static function () use ( &$touched ) {
	$touched = true; } );
iwsl_assert_same( false, $touched, 'locked (state=pending): save blocked' );

$store_s = new IWSL_Memory_Store();
$store_s->set( 'state', 'active' );
$store_s->set( 'last_verified_at', $SEO_NOW - 10800000 ); // 3h stale
$store_s->set( 'entitlements', array( 'seo_suite' => true ) );
$eng_s = new IWSL_SEO_Suite( new IWSL_Entitlements( $store_s, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } ), $store_s, static function () use ( $SEO_NOW ): int {
	return $SEO_NOW; } );
ob_start();
$eng_s->render_head();
iwsl_assert_same( '', ob_get_clean(), 'locked (stale heartbeat): render_head emits nothing' );

// ── 20. Engine: unlocked registers a meta box + saves settings ────────────────

$store = new IWSL_Memory_Store();
$eng = iwsl_seo_engine( $store, $SEO_NOW );
$GLOBALS['iwseo_meta_boxes'] = array();
$eng->register_meta_boxes();
iwsl_assert( count( $GLOBALS['iwseo_meta_boxes'] ) >= 1, 'unlocked: at least one meta box registered' );

$sv = $eng->save_settings( array(
	'separator'       => '|',
	'title_templates' => array( 'post' => '%%title%% %%sep%% %%sitename%%' ),
	'sitemap_enabled' => true,
	'org'             => array( 'type' => 'organization', 'name' => 'Example', 'same_as' => "https://x.com/example\nnot a url" ),
) );
iwsl_assert_same( true, $sv['ok'], 'unlocked: save_settings ok' );
$saved = $eng->settings();
iwsl_assert_same( '|', $saved['separator'], 'settings: separator persisted' );
iwsl_assert_same( true, $saved['sitemap_enabled'], 'settings: sitemap toggle persisted' );
iwsl_assert_same( array( 'https://x.com/example' ), $saved['org']['same_as'], 'settings: sameAs list sanitized (bad URL dropped)' );

// ── 21. Meta box renders when unlocked (smoke, no fatal) ──────────────────────

$post = (object) array(
	'ID'           => 5,
	'post_title'   => 'Coffee Grinder Guide',
	'post_content' => '<h2>Coffee grinder basics</h2><p>The coffee grinder is essential. However, choosing one is hard.</p>',
	'post_name'    => 'coffee-grinder-guide',
	'post_type'    => 'post',
);
ob_start();
$eng->render_meta_box( $post );
$html = ob_get_clean();
iwsl_assert( false !== strpos( $html, 'iwseo-box' ), 'meta box: renders the box shell when unlocked' );
iwsl_assert( false !== strpos( $html, 'iwseo-serp' ), 'meta box: renders the snippet preview card' );
iwsl_assert( false !== strpos( $html, 'iwseo_focuskw' ), 'meta box: renders the focus keyphrase field' );

// ── 22. register (unlocked) strips WP core's competing canonical actions ──────
// register() wires hooks on every request but must, ONLY on the active path,
// remove core's rel_canonical / wp_shortlink_wp_head / index_rel_link so our own
// wp_head-pri-1 canonical is authoritative (no duplicate defeating _iwseo_canonical).
// Recording stubs (guarded; this suite runs in its own subprocess, so they are
// isolated). add_action/add_filter must exist or register() early-returns.

$GLOBALS['iwseo_removed'] = array();
if ( ! function_exists( 'add_action' ) ) {
	function add_action( $hook, $cb = null, $priority = 10, $args = 1 ) {
		return true;
	}
}
if ( ! function_exists( 'add_filter' ) ) {
	function add_filter( $hook, $cb = null, $priority = 10, $args = 1 ) {
		return true;
	}
}
if ( ! function_exists( 'add_shortcode' ) ) {
	function add_shortcode( $tag, $cb ) {
		return true;
	}
}
if ( ! function_exists( 'remove_action' ) ) {
	function remove_action( $hook, $cb, $priority = 10 ) {
		$GLOBALS['iwseo_removed'][] = array( (string) $hook, (string) $cb );
		return true;
	}
}
/** Whether the recorder captured a (hook, callback) removal. */
function iwseo_removed_has( string $hook, string $cb ): bool {
	foreach ( $GLOBALS['iwseo_removed'] as $r ) {
		if ( $r[0] === $hook && $r[1] === $cb ) {
			return true;
		}
	}
	return false;
}

$store = new IWSL_Memory_Store();
$eng = iwsl_seo_engine( $store, $SEO_NOW );
$GLOBALS['iwseo_removed'] = array();
$eng->register();
iwsl_assert( iwseo_removed_has( 'wp_head', 'rel_canonical' ), 'register (unlocked): removes core rel_canonical' );
iwsl_assert( iwseo_removed_has( 'wp_head', 'wp_shortlink_wp_head' ), 'register (unlocked): removes core wp_shortlink_wp_head' );
iwsl_assert( iwseo_removed_has( 'wp_head', 'index_rel_link' ), 'register (unlocked): removes core index_rel_link' );

// Gated: a LOCKED site must leave core's canonical actions intact (stock WP head).
$store_l = new IWSL_Memory_Store();
$store_l->set( 'state', 'active' );
$store_l->set( 'last_verified_at', $SEO_NOW - 1000 );
$store_l->set( 'entitlements', array( 'plus' => true ) ); // seo_suite ABSENT
$eng_l = new IWSL_SEO_Suite(
	new IWSL_Entitlements( $store_l, static function () use ( $SEO_NOW ): int {
		return $SEO_NOW; } ),
	$store_l,
	static function () use ( $SEO_NOW ): int {
		return $SEO_NOW; }
);
$GLOBALS['iwseo_removed'] = array();
$eng_l->register();
iwsl_assert_same( 0, count( $GLOBALS['iwseo_removed'] ), 'register (locked): core canonical actions left intact' );

// ── 23. Sitemap query stubs (guarded; isolated subprocess) ────────────────────
// get_post_types drives public_types(); wp_count_posts drives the index page count;
// get_posts honours offset+posts_per_page so per-page fetch is observable.

$GLOBALS['iwseo_types']  = array( 'post', 'page' );
$GLOBALS['iwseo_counts'] = array();
$GLOBALS['iwseo_posts']  = array();
if ( ! function_exists( 'get_post_types' ) ) {
	function get_post_types( $args = array(), $output = 'names' ) {
		$t = (array) $GLOBALS['iwseo_types'];
		return array_combine( $t, $t );
	}
}
if ( ! function_exists( 'wp_count_posts' ) ) {
	function wp_count_posts( $type = 'post', $perm = '' ) {
		$n = isset( $GLOBALS['iwseo_counts'][ $type ] ) ? (int) $GLOBALS['iwseo_counts'][ $type ] : 0;
		return (object) array( 'publish' => $n );
	}
}
if ( ! function_exists( 'get_posts' ) ) {
	function get_posts( array $args = array() ) {
		$type = isset( $args['post_type'] ) ? (string) $args['post_type'] : 'post';
		$all  = isset( $GLOBALS['iwseo_posts'][ $type ] ) ? (array) $GLOBALS['iwseo_posts'][ $type ] : array();
		$off  = isset( $args['offset'] ) ? (int) $args['offset'] : 0;
		$per  = isset( $args['posts_per_page'] ) ? (int) $args['posts_per_page'] : count( $all );
		if ( $per < 0 ) {
			return array_values( $all );
		}
		return array_values( array_slice( $all, $off, $per ) );
	}
}
if ( ! function_exists( 'get_permalink' ) ) {
	function get_permalink( $id = 0 ) {
		return 'https://example.com/?p=' . (int) $id;
	}
}
if ( ! function_exists( 'get_post_modified_time' ) ) {
	function get_post_modified_time( $fmt = 'c', $gmt = false, $id = 0 ) {
		return '2026-07-21T00:00:00+00:00';
	}
}

$subs_ref = new ReflectionMethod( 'IWSL_SEO_Suite', 'sitemap_subs' );
$subs_ref->setAccessible( true );
$entries_ref = new ReflectionMethod( 'IWSL_SEO_Suite', 'sitemap_entries' );
$entries_ref->setAccessible( true );
$parse_ref = new ReflectionMethod( 'IWSL_SEO_Suite', 'parse_type_sitemap' );
$parse_ref->setAccessible( true );

$store_sm = new IWSL_Memory_Store();
$eng_sm = iwsl_seo_engine( $store_sm, $SEO_NOW );

// ── 24. Index derives page count from the type's total; page N uses the offset ─

$GLOBALS['iwseo_types']  = array( 'guide' );
$GLOBALS['iwseo_counts'] = array( 'guide' => 2500 );
$ids = array();
for ( $i = 1; $i <= 2500; $i++ ) {
	$ids[] = $i;
}
$GLOBALS['iwseo_posts'] = array( 'guide' => $ids );

$subs = $subs_ref->invoke( $eng_sm );
iwsl_assert_same( 3, count( $subs ), 'sitemap index: 2500 entries → 3 children (ceil 2500/1000)' );
iwsl_assert( false !== strpos( $subs[0]['loc'], '/guide-sitemap.xml' ), 'sitemap index: first child is guide-sitemap.xml' );
iwsl_assert( false !== strpos( $subs[2]['loc'], '/guide-sitemap3.xml' ), 'sitemap index: third child is guide-sitemap3.xml' );

$page3 = $entries_ref->invoke( $eng_sm, 'guide', 3 );
iwsl_assert_same( 500, count( $page3 ), 'sitemap page 3: serves the remaining 500 entries' );
iwsl_assert( false !== strpos( $page3[0]['loc'], '?p=2001' ), 'sitemap page 3: first entry is post 2001 (offset applied, not dropped)' );
iwsl_assert( false !== strpos( $page3[499]['loc'], '?p=2500' ), 'sitemap page 3: last entry is post 2500' );

// ── 25. Zero-entry type is absent from the index (no advertised 404) ──────────

$GLOBALS['iwseo_types']  = array( 'guide', 'empty_cpt' );
$GLOBALS['iwseo_counts'] = array( 'guide' => 2500, 'empty_cpt' => 0 );
$subs_c = $subs_ref->invoke( $eng_sm );
iwsl_assert_same( 3, count( $subs_c ), 'sitemap index: zero-entry type contributes no children' );
$has_empty = false;
foreach ( $subs_c as $s ) {
	if ( false !== strpos( $s['loc'], 'empty_cpt' ) ) {
		$has_empty = true;
	}
}
iwsl_assert_same( false, $has_empty, 'sitemap index: empty_cpt absent from the index' );

// ── 26. Digit/hyphen CPT slug resolves through the request regex + public_types ─

$p1 = $parse_ref->invoke( null, '/my-cpt2-sitemap.xml' );
iwsl_assert_same( 'my-cpt2', $p1['type'], 'sitemap regex: digit/hyphen slug my-cpt2 resolves' );
iwsl_assert_same( 1, $p1['page'], 'sitemap regex: my-cpt2 default page = 1' );
$p2 = $parse_ref->invoke( null, '/post-sitemap2.xml' );
iwsl_assert_same( 'post', $p2['type'], 'sitemap regex: post-sitemap2 → type post' );
iwsl_assert_same( 2, $p2['page'], 'sitemap regex: post-sitemap2 → page 2' );
iwsl_assert_same( null, $parse_ref->invoke( null, '/sitemap_index.xml' ), 'sitemap regex: sitemap_index is not a per-type child' );

$GLOBALS['iwseo_types'] = array( 'my-cpt2' );
$GLOBALS['iwseo_posts'] = array( 'my-cpt2' => array( 10, 20, 30 ) );
$entries_d = $entries_ref->invoke( $eng_sm, 'my-cpt2', 1 );
iwsl_assert_same( 3, count( $entries_d ), 'sitemap: my-cpt2 resolves to its published entries (was unmatchable by the old regex)' );

// ── 27. Head: the meta type attribute is esc_attr-escaped (defence-in-depth) ──

$ctx_e = array(
	'title'       => 'T',
	'description' => 'D',
	'canonical'   => 'https://example.com/x',
	'site_name'   => 'S',
	'locale'      => 'en-US',
	'og'          => array( 'type' => 'website' ),
);
$head_e = IWSL_SEO_Head::render_head( $ctx_e );
$type_ok = true;
foreach ( IWSL_SEO_Head::meta_tags( $ctx_e ) as $t ) {
	if ( false === strpos( $head_e, '<meta ' . esc_attr( $t['type'] ) . '="' . esc_attr( $t['key'] ) . '"' ) ) {
		$type_ok = false;
	}
}
iwsl_assert( $type_ok, 'render_head: meta type attribute rendered via esc_attr for every tag' );
iwsl_assert( false !== strpos( $head_e, '<meta property="og:type"' ), 'render_head: og:type type attribute well-formed + escaped' );
iwsl_assert( false !== strpos( $head_e, '<meta name="description"' ), 'render_head: description type attribute well-formed + escaped' );

// ── 28. Head: auto_excerpt — content-derived meta description fallback ─────────

iwsl_assert_same( 'Hello world', IWSL_SEO_Head::auto_excerpt( '<p>Hello <b>world</b></p>' ), 'auto_excerpt: strips tags to plain text' );
iwsl_assert_same( 'Tom & Jerry', IWSL_SEO_Head::auto_excerpt( '<p>Tom &amp; Jerry</p>' ), 'auto_excerpt: decodes HTML entities' );
iwsl_assert_same( 'Real text here', IWSL_SEO_Head::auto_excerpt( '[gallery ids="1,2"]Real text here[/gallery]' ), 'auto_excerpt: strips shortcodes' );
iwsl_assert_same( '', IWSL_SEO_Head::auto_excerpt( '<p>   </p>' ), 'auto_excerpt: markup/whitespace-only → empty' );
iwsl_assert_same( '', IWSL_SEO_Head::auto_excerpt( '' ), 'auto_excerpt: empty in → empty out' );
$ae_long = 'one two three four five six seven eight nine ten';
iwsl_assert_same( 'one two three', IWSL_SEO_Head::auto_excerpt( $ae_long, 13 ), 'auto_excerpt: truncates at a whole word within budget' );
iwsl_assert_same( 'one two three', IWSL_SEO_Head::auto_excerpt( $ae_long, 14 ), 'auto_excerpt: never cuts mid-word (14 still stops at "three")' );
iwsl_assert_same( 'one two three', IWSL_SEO_Head::auto_excerpt( 'one two three', 13 ), 'auto_excerpt: exact boundary (len == max) returns the whole text' );
iwsl_assert_same( 'café münchen', IWSL_SEO_Head::auto_excerpt( '<p>café münchen</p>', 155 ), 'auto_excerpt: unicode text preserved' );
iwsl_assert_same( 'über café', IWSL_SEO_Head::auto_excerpt( 'über café münchen test', 12 ), 'auto_excerpt: unicode truncation stops at a whole word' );
iwsl_assert_same( 'superca', IWSL_SEO_Head::auto_excerpt( 'supercalifragilistic', 7 ), 'auto_excerpt: a single over-budget word is hard-cut (never empty)' );

// ── 29. Analyzer: extract_image_srcs — powers the image sitemap ────────────────

iwsl_assert_same(
	array( 'https://ex.com/a.jpg', 'https://ex.com/b.png' ),
	IWSL_SEO_Analyzer::extract_image_srcs( '<img src="https://ex.com/a.jpg"><p>x</p><img src=\'https://ex.com/b.png\' alt="b">' ),
	'extract_image_srcs: multiple imgs, both quote styles, in order'
);
iwsl_assert_same( array(), IWSL_SEO_Analyzer::extract_image_srcs( '<img alt="no src here">' ), 'extract_image_srcs: img with no src is skipped' );
iwsl_assert_same( array(), IWSL_SEO_Analyzer::extract_image_srcs( '<img src="">' ), 'extract_image_srcs: empty src is skipped' );
iwsl_assert_same( array( 'https://ex.com/x.jpg' ), IWSL_SEO_Analyzer::extract_image_srcs( '<img   src = "https://ex.com/x.jpg"  >tail' ), 'extract_image_srcs: tolerant of attribute whitespace' );
iwsl_assert_same( array( 'https://ex.com/a?x=1&y=2' ), IWSL_SEO_Analyzer::extract_image_srcs( '<img src="https://ex.com/a?x=1&amp;y=2">' ), 'extract_image_srcs: decodes entities in the src URL' );

// ── 30. Sitemap entry folds featured + in-content images (uses §23 reflection) ─

$GLOBALS['iwseo_content_map'] = array( 100 => '<img src="https://ex.com/in.jpg">body' );
$GLOBALS['iwseo_thumb_map']   = array( 100 => 'https://ex.com/feat.jpg' );
if ( ! function_exists( 'get_post' ) ) {
	function get_post( $id = 0 ) {
		$c = isset( $GLOBALS['iwseo_content_map'][ (int) $id ] ) ? $GLOBALS['iwseo_content_map'][ (int) $id ] : '';
		return (object) array( 'ID' => (int) $id, 'post_content' => $c );
	}
}
if ( ! function_exists( 'get_the_post_thumbnail_url' ) ) {
	function get_the_post_thumbnail_url( $id = 0, $size = 'post-thumbnail' ) {
		return isset( $GLOBALS['iwseo_thumb_map'][ (int) $id ] ) ? $GLOBALS['iwseo_thumb_map'][ (int) $id ] : false;
	}
}
$GLOBALS['iwseo_types'] = array( 'guide' );
$GLOBALS['iwseo_posts'] = array( 'guide' => array( 100 ) );
$entries_img = $entries_ref->invoke( $eng_sm, 'guide', 1 );
iwsl_assert_same( 1, count( $entries_img ), 'sitemap images: one entry produced' );
iwsl_assert_same(
	array( 'https://ex.com/feat.jpg', 'https://ex.com/in.jpg' ),
	$entries_img[0]['images'],
	'sitemap entry: featured image first, then the in-content <img src>'
);

// ── 31. should_noindex_archive — pure archive noindex policy ──────────────────

iwsl_assert_same( true, IWSL_SEO_Suite::should_noindex_archive( array( 'archive_type' => 'search' ) ), 'noindex archive: search results → noindex' );
iwsl_assert_same( true, IWSL_SEO_Suite::should_noindex_archive( array( 'archive_type' => 'archive', 'post_count' => 0 ) ), 'noindex archive: zero-post archive → noindex' );
iwsl_assert_same( true, IWSL_SEO_Suite::should_noindex_archive( array( 'archive_type' => 'author', 'single_author_site' => true, 'post_count' => 5 ) ), 'noindex archive: author archive on a single-author site → noindex' );
iwsl_assert_same( false, IWSL_SEO_Suite::should_noindex_archive( array( 'archive_type' => 'author', 'single_author_site' => false, 'post_count' => 5 ) ), 'noindex archive: author archive on a multi-author site → indexable' );
iwsl_assert_same( false, IWSL_SEO_Suite::should_noindex_archive( array( 'archive_type' => 'archive', 'post_count' => 10 ) ), 'noindex archive: a populated term archive → indexable' );

// ── 32. sanitize_settings — archive/author/search template buckets ────────────

$store_ss = new IWSL_Memory_Store();
$eng_ss   = iwsl_seo_engine( $store_ss, $SEO_NOW );
$clean_ss = $eng_ss->sanitize_settings( array(
	'title_templates' => array( 'author' => '%%name%% %%sep%% %%sitename%%', 'search' => 'Search: %%searchphrase%%', 'archive' => '%%term_title%%' ),
	'meta_templates'  => array( 'archive' => 'Browse %%term_title%%' ),
) );
iwsl_assert_same( '%%name%% %%sep%% %%sitename%%', $clean_ss['title_templates']['author'], 'sanitize_settings: author title bucket kept' );
iwsl_assert_same( 'Search: %%searchphrase%%', $clean_ss['title_templates']['search'], 'sanitize_settings: search title bucket kept' );
iwsl_assert_same( '%%term_title%%', $clean_ss['title_templates']['archive'], 'sanitize_settings: archive title bucket kept' );
iwsl_assert_same( 'Browse %%term_title%%', $clean_ss['meta_templates']['archive'], 'sanitize_settings: archive meta bucket kept' );
iwsl_assert( isset( $clean_ss['title_templates']['post'] ), 'sanitize_settings: original post bucket still present (additive)' );

// ── cleanup: unset every global this suite installed ──────────────────────────

unset( $GLOBALS['iwseo_content_map'], $GLOBALS['iwseo_thumb_map'] );
unset( $GLOBALS['iwseo_meta_boxes'] );
unset( $GLOBALS['iwseo_removed'] );
unset( $GLOBALS['iwseo_types'] );
unset( $GLOBALS['iwseo_counts'] );
unset( $GLOBALS['iwseo_posts'] );
unset( $_SERVER['REQUEST_URI'] );
