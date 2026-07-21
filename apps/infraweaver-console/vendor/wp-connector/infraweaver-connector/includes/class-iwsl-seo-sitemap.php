<?php
/**
 * Pure XML sitemap builder (spec §9): a sitemap index plus per-type url-sets,
 * with noindex exclusion, ~1,000-entry pagination, and optional image entries.
 * Stateless and WordPress-free, so the shapes are unit-testable; the engine
 * (IWSL_SEO_Suite) collects entries from WP queries and hands them here.
 *
 * An "entry" is [ 'loc'=>url, 'lastmod'=>iso|'' , 'noindex'=>bool, 'images'=>[url,...] ].
 * A "sub-sitemap" (for the index) is [ 'loc'=>url, 'lastmod'=>iso|'' ].
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SEO_Sitemap {

	/** Split each per-type sitemap at this many entries (spec §9.2). */
	const PER_PAGE = 1000;

	/** Drop noindexed / password-protected entries: sitemap ≡ indexable canonicals. */
	public static function filter_indexable( array $entries ): array {
		$out = array();
		foreach ( $entries as $e ) {
			if ( ! is_array( $e ) || empty( $e['loc'] ) || ! is_string( $e['loc'] ) ) {
				continue;
			}
			if ( ! empty( $e['noindex'] ) ) {
				continue;
			}
			$out[] = $e;
		}
		return array_values( $out );
	}

	/**
	 * Chunk a flat entry list into pages of at most PER_PAGE (bounds each query and
	 * file). Page 1 is entries[0..999], page 2 is 1000..1999, etc.
	 *
	 * @return array<int, array> A list of pages (each a list of entries).
	 */
	public static function paginate( array $entries, int $per_page = self::PER_PAGE ): array {
		$per_page = max( 1, min( self::PER_PAGE, $per_page ) );
		$indexable = self::filter_indexable( $entries );
		if ( array() === $indexable ) {
			return array();
		}
		return array_chunk( $indexable, $per_page );
	}

	/**
	 * The `<sitemapindex>` XML listing child sitemaps.
	 *
	 * @param array<int, array{ loc:string, lastmod?:string }> $subs
	 */
	public static function index_xml( array $subs ): string {
		$xml = self::header() . '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";
		foreach ( $subs as $s ) {
			if ( ! is_array( $s ) || empty( $s['loc'] ) || ! is_string( $s['loc'] ) ) {
				continue;
			}
			$xml .= "\t<sitemap>\n\t\t<loc>" . self::esc( $s['loc'] ) . "</loc>\n";
			if ( ! empty( $s['lastmod'] ) && is_string( $s['lastmod'] ) ) {
				$xml .= "\t\t<lastmod>" . self::esc( $s['lastmod'] ) . "</lastmod>\n";
			}
			$xml .= "\t</sitemap>\n";
		}
		$xml .= '</sitemapindex>';
		return $xml;
	}

	/**
	 * A `<urlset>` for one page of entries. Noindexed entries are filtered here too
	 * (defence-in-depth), and any per-entry image URLs are folded in as
	 * `<image:image>` children (the folded-in image sitemap, §9.2).
	 */
	public static function urlset_xml( array $entries ): string {
		$xml = self::header()
			. '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
			. 'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">' . "\n";
		foreach ( self::filter_indexable( $entries ) as $e ) {
			$xml .= "\t<url>\n\t\t<loc>" . self::esc( (string) $e['loc'] ) . "</loc>\n";
			if ( ! empty( $e['lastmod'] ) && is_string( $e['lastmod'] ) ) {
				$xml .= "\t\t<lastmod>" . self::esc( $e['lastmod'] ) . "</lastmod>\n";
			}
			if ( ! empty( $e['images'] ) && is_array( $e['images'] ) ) {
				foreach ( $e['images'] as $img ) {
					if ( is_string( $img ) && '' !== $img ) {
						$xml .= "\t\t<image:image>\n\t\t\t<image:loc>" . self::esc( $img ) . "</image:loc>\n\t\t</image:image>\n";
					}
				}
			}
			$xml .= "\t</url>\n";
		}
		$xml .= '</urlset>';
		return $xml;
	}

	/** The XML declaration shared by both document kinds. */
	private static function header(): string {
		return '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
	}

	/** XML-escape a text node (esc_xml under modern WP, else a safe local escape). */
	private static function esc( string $s ): string {
		if ( function_exists( 'esc_xml' ) ) {
			return esc_xml( $s );
		}
		return htmlspecialchars( $s, ENT_QUOTES | ENT_XML1, 'UTF-8' );
	}
}
