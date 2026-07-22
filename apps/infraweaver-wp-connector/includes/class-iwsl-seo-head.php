<?php
/**
 * Pure builder for the front-end SEO head block: template-variable resolution,
 * the robots directive list, Open Graph / Twitter meta tags, and the JSON-LD
 * `@graph` (spec §6–§8, §10). Like the analyzer this class holds NO state and
 * makes NO WordPress calls of its own beyond function_exists-guarded escaping —
 * the engine (IWSL_SEO_Suite) resolves a plain "context" array from post meta +
 * settings + WP and hands it here, which keeps every shape unit-testable.
 *
 * ESCAPING. Every dynamic byte that reaches output goes through self::e()
 * (esc_attr under WordPress, htmlspecialchars otherwise) or, for the JSON-LD, a
 * single json_encode with JSON_UNESCAPED_SLASHES|JSON_HEX_TAG so `</script>`
 * cannot break out. Nothing is ever echoed raw.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SEO_Head {

	/** The always-on snippet-permission directives (free CTR, no downside). */
	const MAX_DIRECTIVES = array( 'max-snippet:-1', 'max-image-preview:large', 'max-video-preview:-1' );

	/** Advanced robots directives we recognise (per-post `robots_adv`). */
	const ADV_DIRECTIVES = array( 'noimageindex', 'noarchive', 'nosnippet' );

	// ── template variables ──────────────────────────────────────────────────────

	/**
	 * Resolve a `%%var%%` template against a flat replacement map. Unknown
	 * variables resolve to empty, then doubled separators and whitespace are
	 * collapsed so `%%title%% %%sep%% %%category%%` with no category never leaves a
	 * dangling separator. The `sep` value is used to tidy separator runs.
	 *
	 * @param string               $template e.g. "%%title%% %%sep%% %%sitename%%".
	 * @param array<string, string> $vars     Map keyed WITHOUT the %% delimiters.
	 */
	public static function replace_vars( string $template, array $vars ): string {
		if ( '' === $template ) {
			return '';
		}
		$sep = isset( $vars['sep'] ) && is_string( $vars['sep'] ) && '' !== $vars['sep'] ? $vars['sep'] : '-';

		$resolved = preg_replace_callback(
			'/%%([A-Za-z0-9_]+)%%/',
			static function ( array $m ) use ( $vars ): string {
				$key = strtolower( $m[1] );
				if ( 'sitename' === $key ) {
					$key = 'sitename';
				}
				return isset( $vars[ $key ] ) && is_string( $vars[ $key ] ) ? $vars[ $key ] : '';
			},
			$template
		);
		$resolved = is_string( $resolved ) ? $resolved : '';

		// Collapse whitespace, then strip separators left stranded at the ends or
		// doubled up by an empty variable between two separators.
		$resolved = preg_replace( '/\s+/u', ' ', $resolved ) ?? $resolved;
		$sep_q = preg_quote( $sep, '/' );
		$resolved = preg_replace( '/(?:\s*' . $sep_q . '\s*){2,}/u', ' ' . $sep . ' ', $resolved ) ?? $resolved;
		$resolved = preg_replace( '/^(?:\s*' . $sep_q . '\s*)+|(?:\s*' . $sep_q . '\s*)+$/u', '', $resolved ) ?? $resolved;
		return trim( $resolved );
	}

	// ── content-derived description ─────────────────────────────────────────────

	/**
	 * Derive a clean, snippet-length plain-text description from post HTML: strip
	 * shortcodes + tags (script/style bodies dropped whole), decode entities,
	 * collapse whitespace, then truncate to the last WHOLE word at or before
	 * $max_chars — never a mid-word cut. Returns '' for empty/markup-only input.
	 * Pure + deterministic: the automated meta-description fallback that makes our
	 * SEO more hands-off than Yoast (which leaves the description blank).
	 */
	public static function auto_excerpt( string $html, int $max_chars = 155 ): string {
		if ( '' === $html ) {
			return '';
		}
		// Drop script/style bodies, then shortcodes, then every remaining tag.
		$text = preg_replace( '#<(script|style)\b[^>]*>.*?</\1>#is', ' ', $html ) ?? $html;
		$text = preg_replace( '/\[\/?[^\]]*\]/', ' ', $text ) ?? $text;
		$text = preg_replace( '#<[^>]+>#', ' ', $text ) ?? $text;
		$text = html_entity_decode( $text, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
		$text = preg_replace( '/\s+/u', ' ', $text ) ?? $text;
		$text = trim( $text );
		if ( '' === $text ) {
			return '';
		}

		$max_chars = max( 1, $max_chars );
		if ( self::u_len( $text ) <= $max_chars ) {
			return $text;
		}

		// Rebuild word by word until the next whole word would overflow the budget.
		$out = '';
		foreach ( explode( ' ', $text ) as $word ) {
			$candidate = '' === $out ? $word : $out . ' ' . $word;
			if ( self::u_len( $candidate ) > $max_chars ) {
				break;
			}
			$out = $candidate;
		}
		// A single leading word longer than the whole budget: hard-cut it so we
		// never return empty for over-budget content.
		if ( '' === $out ) {
			$out = self::u_substr( $text, 0, $max_chars );
		}
		return $out;
	}

	// ── robots ──────────────────────────────────────────────────────────────────

	/**
	 * The robots directive list for a context. Default indexable pages get
	 * `index, follow` plus the max-* snippet permissions; per-post noindex/nofollow
	 * and the recognised advanced flags compose on top.
	 *
	 * @return string[]
	 */
	public static function robots_directives( array $ctx ): array {
		$noindex = ! empty( $ctx['noindex'] );
		$nofollow = ! empty( $ctx['nofollow'] );
		$out = array( $noindex ? 'noindex' : 'index', $nofollow ? 'nofollow' : 'follow' );

		$adv = isset( $ctx['robots_adv'] ) && is_array( $ctx['robots_adv'] ) ? $ctx['robots_adv'] : array();
		foreach ( self::ADV_DIRECTIVES as $d ) {
			if ( in_array( $d, $adv, true ) ) {
				$out[] = $d;
			}
		}
		// Snippet permissions only make sense when the page is indexable.
		if ( ! $noindex && ! in_array( 'nosnippet', $out, true ) ) {
			$out = array_merge( $out, self::MAX_DIRECTIVES );
		}
		return $out;
	}

	/** The robots directives joined for a `<meta name="robots">`/`wp_robots` merge. */
	public static function robots_string( array $ctx ): string {
		return implode( ', ', self::robots_directives( $ctx ) );
	}

	// ── Open Graph + Twitter ────────────────────────────────────────────────────

	/**
	 * The OG image following the cascade: per-post OG image → featured image →
	 * first in-content image → site default social image → ''. The engine supplies
	 * already-resolved candidates.
	 */
	public static function og_image( array $ctx ): string {
		$og = isset( $ctx['og'] ) && is_array( $ctx['og'] ) ? $ctx['og'] : array();
		foreach ( array( 'image', 'featured', 'content_image', 'default_image' ) as $k ) {
			if ( ! empty( $og[ $k ] ) && is_string( $og[ $k ] ) ) {
				return $og[ $k ];
			}
		}
		return '';
	}

	/**
	 * Structured OG + Twitter meta tags for a singular/context view. Each entry is
	 * [ 'type' => 'property'|'name', 'key' => string, 'content' => string ] so the
	 * renderer and the tests share one shape. Empty-content tags are omitted.
	 *
	 * @return array<int, array{ type:string, key:string, content:string }>
	 */
	public static function meta_tags( array $ctx ): array {
		$out = array();
		$desc = self::ctx_str( $ctx, 'description' );
		if ( '' !== $desc ) {
			$out[] = self::tag( 'name', 'description', $desc );
		}

		$og = isset( $ctx['og'] ) && is_array( $ctx['og'] ) ? $ctx['og'] : array();
		$og_title = self::pick( $og, 'title', self::ctx_str( $ctx, 'title' ) );
		$og_desc = self::pick( $og, 'description', $desc );
		$og_url = self::pick( $og, 'url', self::ctx_str( $ctx, 'canonical' ) );
		$og_type = self::pick( $og, 'type', 'website' );
		$og_site = self::pick( $og, 'site_name', self::ctx_str( $ctx, 'site_name' ) );

		$out[] = self::tag( 'property', 'og:type', $og_type );
		$out[] = self::tag( 'property', 'og:title', $og_title );
		$out[] = self::tag( 'property', 'og:description', $og_desc );
		$out[] = self::tag( 'property', 'og:url', $og_url );
		$out[] = self::tag( 'property', 'og:site_name', $og_site );
		$out[] = self::tag( 'property', 'og:locale', self::ctx_str( $ctx, 'locale' ) );

		$image = self::og_image( $ctx );
		if ( '' !== $image ) {
			$out[] = self::tag( 'property', 'og:image', $image );
			if ( ! empty( $og['image_width'] ) ) {
				$out[] = self::tag( 'property', 'og:image:width', (string) (int) $og['image_width'] );
			}
			if ( ! empty( $og['image_height'] ) ) {
				$out[] = self::tag( 'property', 'og:image:height', (string) (int) $og['image_height'] );
			}
		}
		if ( 'article' === $og_type ) {
			if ( '' !== self::ctx_str( $ctx, 'published' ) ) {
				$out[] = self::tag( 'property', 'article:published_time', self::ctx_str( $ctx, 'published' ) );
			}
			if ( '' !== self::ctx_str( $ctx, 'modified' ) ) {
				$out[] = self::tag( 'property', 'article:modified_time', self::ctx_str( $ctx, 'modified' ) );
			}
		}

		$tw = isset( $ctx['twitter'] ) && is_array( $ctx['twitter'] ) ? $ctx['twitter'] : array();
		$out[] = self::tag( 'name', 'twitter:card', self::pick( $tw, 'card', 'summary_large_image' ) );
		$out[] = self::tag( 'name', 'twitter:title', self::pick( $tw, 'title', $og_title ) );
		$out[] = self::tag( 'name', 'twitter:description', self::pick( $tw, 'description', $og_desc ) );
		$tw_image = self::pick( $tw, 'image', $image );
		if ( '' !== $tw_image ) {
			$out[] = self::tag( 'name', 'twitter:image', $tw_image );
		}
		if ( '' !== self::pick( $tw, 'site', '' ) ) {
			$out[] = self::tag( 'name', 'twitter:site', self::pick( $tw, 'site', '' ) );
		}

		// Drop any entry whose content ended up empty.
		return array_values(
			array_filter(
				$out,
				static function ( array $t ): bool {
					return '' !== $t['content'];
				}
			)
		);
	}

	// ── JSON-LD @graph ──────────────────────────────────────────────────────────

	/**
	 * Build the connected JSON-LD graph (§8.2) for a context. Node @ids follow
	 * Yoast's tested conventions (home#organization / home#website /
	 * canonical#webpage / canonical#article / canonical#breadcrumb) because that is
	 * what "correct" looks like against Google's Rich Results Test.
	 *
	 * @return array<string, mixed> The full `{ @context, @graph }` document.
	 */
	public static function schema_graph( array $ctx ): array {
		$home = rtrim( self::ctx_str( $ctx, 'home_url' ), '/' ) . '/';
		$canonical = self::ctx_str( $ctx, 'canonical' );
		$schema = isset( $ctx['schema'] ) && is_array( $ctx['schema'] ) ? $ctx['schema'] : array();
		$lang = self::ctx_str( $ctx, 'locale' );

		$org_id = $home . '#organization';
		$site_id = $home . '#website';
		$page_id = ( '' !== $canonical ? $canonical : $home ) . '#webpage';

		$graph = array();

		// Organization / Person.
		$rep = isset( $schema['representation'] ) && is_array( $schema['representation'] ) ? $schema['representation'] : array();
		$rep_type = ( isset( $rep['type'] ) && 'person' === $rep['type'] ) ? 'Person' : 'Organization';
		$org = array(
			'@type' => $rep_type,
			'@id'   => $org_id,
			'name'  => self::pick( $rep, 'name', self::ctx_str( $ctx, 'site_name' ) ),
			'url'   => $home,
		);
		if ( ! empty( $rep['logo'] ) ) {
			$org['logo'] = array(
				'@type' => 'ImageObject',
				'@id'   => $home . '#/schema/logo/image/',
				'url'   => (string) $rep['logo'],
			);
			if ( 'Organization' === $rep_type ) {
				$org['image'] = array( '@id' => $home . '#/schema/logo/image/' );
			}
		}
		if ( ! empty( $rep['same_as'] ) && is_array( $rep['same_as'] ) ) {
			$org['sameAs'] = array_values( array_filter( array_map( 'strval', $rep['same_as'] ) ) );
		}
		$graph[] = $org;

		// WebSite + SearchAction.
		$site = array(
			'@type'     => 'WebSite',
			'@id'       => $site_id,
			'url'       => $home,
			'name'      => self::ctx_str( $ctx, 'site_name' ),
			'publisher' => array( '@id' => $org_id ),
			'potentialAction' => array(
				array(
					'@type'       => 'SearchAction',
					'target'      => array(
						'@type'       => 'EntryPoint',
						'urlTemplate' => $home . '?s={search_term_string}',
					),
					'query-input' => 'required name=search_term_string',
				),
			),
		);
		if ( '' !== $lang ) {
			$site['inLanguage'] = $lang;
		}
		$graph[] = $site;

		// WebPage.
		$page = array(
			'@type'    => self::pick( $schema, 'page_type', 'WebPage' ),
			'@id'      => $page_id,
			'url'      => '' !== $canonical ? $canonical : $home,
			'name'     => self::ctx_str( $ctx, 'title' ),
			'isPartOf' => array( '@id' => $site_id ),
		);
		if ( '' !== self::ctx_str( $ctx, 'description' ) ) {
			$page['description'] = self::ctx_str( $ctx, 'description' );
		}
		if ( '' !== self::ctx_str( $ctx, 'published' ) ) {
			$page['datePublished'] = self::ctx_str( $ctx, 'published' );
		}
		if ( '' !== self::ctx_str( $ctx, 'modified' ) ) {
			$page['dateModified'] = self::ctx_str( $ctx, 'modified' );
		}
		if ( '' !== $lang ) {
			$page['inLanguage'] = $lang;
		}

		// Primary image.
		$primary_image = self::og_image( $ctx );
		if ( '' !== $primary_image ) {
			$img_id = ( '' !== $canonical ? $canonical : $home ) . '#primaryimage';
			$graph[] = array(
				'@type' => 'ImageObject',
				'@id'   => $img_id,
				'url'   => $primary_image,
			);
			$page['primaryImageOfPage'] = array( '@id' => $img_id );
		}

		// Breadcrumbs (emitted even when the visual trail is off — free SERP win).
		$crumbs = isset( $schema['breadcrumbs'] ) && is_array( $schema['breadcrumbs'] ) ? $schema['breadcrumbs'] : array();
		if ( count( $crumbs ) > 1 ) {
			$bc_id = ( '' !== $canonical ? $canonical : $home ) . '#breadcrumb';
			$graph[] = self::breadcrumb_list( $bc_id, $crumbs );
			$page['breadcrumb'] = array( '@id' => $bc_id );
		}
		$graph[] = $page;

		// Article (posts only).
		$article_type = self::pick( $schema, 'article_type', '' );
		if ( '' !== $article_type && 'None' !== $article_type ) {
			$article = array(
				'@type'            => $article_type,
				'@id'              => ( '' !== $canonical ? $canonical : $home ) . '#article',
				'isPartOf'         => array( '@id' => $page_id ),
				'mainEntityOfPage' => array( '@id' => $page_id ),
				'headline'         => self::ctx_str( $ctx, 'title' ),
				'publisher'        => array( '@id' => $org_id ),
			);
			if ( '' !== self::ctx_str( $ctx, 'published' ) ) {
				$article['datePublished'] = self::ctx_str( $ctx, 'published' );
			}
			if ( '' !== self::ctx_str( $ctx, 'modified' ) ) {
				$article['dateModified'] = self::ctx_str( $ctx, 'modified' );
			}
			if ( ! empty( $schema['word_count'] ) ) {
				$article['wordCount'] = (int) $schema['word_count'];
			}
			if ( ! empty( $schema['section'] ) ) {
				$article['articleSection'] = (string) $schema['section'];
			}
			if ( '' !== $lang ) {
				$article['inLanguage'] = $lang;
			}
			if ( '' !== self::ctx_str( $ctx, 'author' ) ) {
				$person_id = $home . '#/schema/person/' . substr( md5( self::ctx_str( $ctx, 'author' ) ), 0, 12 );
				$article['author'] = array( '@id' => $person_id );
				$graph[] = array(
					'@type' => 'Person',
					'@id'   => $person_id,
					'name'  => self::ctx_str( $ctx, 'author' ),
				);
			}
			$graph[] = $article;
		}

		return array(
			'@context' => 'https://schema.org',
			'@graph'   => array_values( $graph ),
		);
	}

	/** A BreadcrumbList node from a crumb list of [ 'name'=>, 'url'=> ]. */
	private static function breadcrumb_list( string $id, array $crumbs ): array {
		$items = array();
		$pos = 1;
		$last = count( $crumbs );
		foreach ( $crumbs as $crumb ) {
			$name = is_array( $crumb ) && isset( $crumb['name'] ) ? (string) $crumb['name'] : '';
			$item = array(
				'@type'    => 'ListItem',
				'position' => $pos,
				'name'     => $name,
			);
			// The last crumb carries no `item` URL (Google's convention).
			if ( $pos < $last && is_array( $crumb ) && ! empty( $crumb['url'] ) ) {
				$item['item'] = (string) $crumb['url'];
			}
			$items[] = $item;
			++$pos;
		}
		return array(
			'@type'           => 'BreadcrumbList',
			'@id'             => $id,
			'itemListElement' => $items,
		);
	}

	// ── rendering (escaped) ─────────────────────────────────────────────────────

	/**
	 * The complete escaped head block string for a context: description/OG/Twitter
	 * meta, canonical link, and the JSON-LD graph. The engine echoes this at
	 * wp_head priority 1. Robots is emitted separately via the wp_robots filter.
	 */
	public static function render_head( array $ctx ): string {
		$html = "<!-- InfraWeaver SEO -->\n";

		$canonical = self::ctx_str( $ctx, 'canonical' );
		if ( '' !== $canonical ) {
			$html .= '<link rel="canonical" href="' . self::e_url( $canonical ) . '" />' . "\n";
		}

		foreach ( self::meta_tags( $ctx ) as $t ) {
			$html .= '<meta ' . self::e( $t['type'] ) . '="' . self::e( $t['key'] ) . '" content="' . self::e( $t['content'] ) . '" />' . "\n";
		}

		$graph = self::schema_graph( $ctx );
		$json = wp_json_encode_compat( $graph );
		if ( '' !== $json ) {
			$html .= '<script type="application/ld+json" class="iwseo-schema-graph">' . $json . '</script>' . "\n";
		}

		$html .= "<!-- / InfraWeaver SEO -->\n";
		return $html;
	}

	// ── helpers ─────────────────────────────────────────────────────────────────

	private static function tag( string $type, string $key, string $content ): array {
		return array( 'type' => $type, 'key' => $key, 'content' => $content );
	}

	private static function ctx_str( array $ctx, string $key ): string {
		return isset( $ctx[ $key ] ) && is_string( $ctx[ $key ] ) ? $ctx[ $key ] : '';
	}

	private static function pick( array $a, string $key, string $fallback ): string {
		return isset( $a[ $key ] ) && is_string( $a[ $key ] ) && '' !== $a[ $key ] ? $a[ $key ] : $fallback;
	}

	/** Escape for an HTML attribute (esc_attr under WP, else htmlspecialchars). */
	private static function e( string $s ): string {
		if ( function_exists( 'esc_attr' ) ) {
			return esc_attr( $s );
		}
		return htmlspecialchars( $s, ENT_QUOTES, 'UTF-8' );
	}

	/** Escape a URL (esc_url under WP, else attribute escape). */
	private static function e_url( string $s ): string {
		if ( function_exists( 'esc_url' ) ) {
			return esc_url( $s );
		}
		return self::e( $s );
	}

	/** Character length (mb-aware, ASCII fallback). */
	private static function u_len( string $s ): int {
		return function_exists( 'mb_strlen' ) ? (int) mb_strlen( $s, 'UTF-8' ) : strlen( $s );
	}

	/** Character-wise substring (mb-aware, ASCII fallback). */
	private static function u_substr( string $s, int $start, int $length ): string {
		return function_exists( 'mb_substr' ) ? (string) mb_substr( $s, $start, $length, 'UTF-8' ) : (string) substr( $s, $start, $length );
	}
}

/**
 * JSON encoder that prefers wp_json_encode but degrades to a hardened json_encode
 * under the no-WP harness. `</script>` is neutralised via JSON_HEX_TAG so the
 * blob can never break out of its <script> element.
 */
if ( ! function_exists( 'wp_json_encode_compat' ) ) {
	function wp_json_encode_compat( $data ): string {
		$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG;
		if ( function_exists( 'wp_json_encode' ) ) {
			$out = wp_json_encode( $data, $flags );
		} else {
			$out = json_encode( $data, $flags );
		}
		return is_string( $out ) ? $out : '';
	}
}
