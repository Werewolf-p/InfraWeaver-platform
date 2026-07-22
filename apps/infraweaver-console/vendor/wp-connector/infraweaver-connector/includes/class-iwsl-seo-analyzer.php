<?php
/**
 * Pure on-page SEO + readability analysis engine (the heart of the SEO Suite).
 *
 * This class contains ZERO WordPress calls and no state: it is a set of static,
 * deterministic functions that consume a plain "paper" array — the same idea as
 * YoastSEO.js's Paper/Researcher/Assessment split, but reimplemented server-side
 * in PHP (the §17.3 feasibility table confirms every check is string/DOM work
 * PHP does fine). Because it is pure it is fully unit-testable under the
 * zero-dependency harness with no stubs at all.
 *
 * THE PAPER (all keys optional, string/array as noted):
 *   title        Resolved SEO title text.
 *   title_width  Pixel width of the title (client canvas measureText); when
 *                absent it is estimated from `title` via a char-width table.
 *   content      Post content HTML.
 *   meta         Meta description text.
 *   slug         Post slug.
 *   url          Permalink (unused by scoring; reserved).
 *   keyphrase    Focus keyphrase.
 *   synonyms     string[] of synonym phrases (count as keyphrase matches).
 *   related      string[] of related keyphrases (each gets its own mini-analysis).
 *   locale       BCP-47-ish locale; language checks run only when it starts 'en'.
 *   is_cornerstone bool — raises the text-length "good" bar to 900 words.
 *   type         'post' | 'page' | 'taxonomy' — tunes the text-length bands.
 *
 * SCORING (spec §3.2): each check yields an integer 0..9 and a status. We map
 *   score <= 4 → red (Problem), 5..7 → orange (Improvement), >= 8 → green (Good).
 *   A check that does not apply is emitted with status 'na' and EXCLUDED from the
 *   aggregate. We deliberately drop Yoast's negative sentinel scores (§17.2).
 *   Aggregate = round( sum(scores) / (9 * count(applicable)) * 100 ), 0..100.
 *   Traffic light: 1-40 red "Needs work", 41-70 orange "OK", 71-100 green "Good".
 *   No focus keyphrase → the SEO side is an explicit 'na' state (Appendix A).
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_SEO_Analyzer {

	/** Per-check statuses. Paired ALWAYS with a text label at render (never colour alone). */
	const RED    = 'red';
	const ORANGE = 'orange';
	const GREEN  = 'green';
	const NA     = 'na';

	/** Overall traffic-light thresholds (inclusive lower bounds). */
	const GOOD_MIN = 71;
	const OK_MIN   = 41;

	/** Snippet limits (spec §5): pixels for the title, characters for the description. */
	const TITLE_PX_MIN  = 401;
	const TITLE_PX_MAX  = 600;
	const META_CH_MIN   = 120;
	const META_CH_MAX   = 156;

	/** Text-length "good" word bars. */
	const TEXT_GOOD_DEFAULT     = 300;
	const TEXT_GOOD_CORNERSTONE = 900;
	const TEXT_GOOD_TAXONOMY    = 250;

	/** Bound the input we will ever scan (defence against pathological content). */
	const MAX_CONTENT_BYTES = 500000;

	/** Reading-speed used for the estimated-reading-time insight (words per minute). */
	const WORDS_PER_MINUTE = 200;

	/**
	 * Full analysis of a paper. Returns an immutable result:
	 *   [
	 *     'seo'         => [ 'score'=>int, 'rating'=>status, 'checks'=>[ item, ... ] ],
	 *     'readability' => [ 'score'=>int, 'rating'=>status, 'checks'=>[ item, ... ] ],
	 *     'related'     => [ [ 'keyphrase'=>string, 'score'=>int, 'rating'=>status, 'checks'=>[...] ], ... ],
	 *     'insights'    => [ 'word_count'=>int, 'reading_time'=>int, 'flesch'=>float ],
	 *   ]
	 * Each check item: [ 'id', 'group', 'label', 'score', 'status', 'message' ].
	 *
	 * @param array<string, mixed> $paper
	 * @return array<string, mixed>
	 */
	public static function analyze( array $paper ): array {
		$research = self::research( $paper );

		$seo_checks = self::seo_checks( $paper, $research );
		$read_checks = self::readability_checks( $paper, $research );

		$seo = self::aggregate( $seo_checks );
		$read = self::aggregate( $read_checks );

		$related = array();
		$related_phrases = isset( $paper['related'] ) && is_array( $paper['related'] ) ? $paper['related'] : array();
		foreach ( $related_phrases as $phrase ) {
			$phrase = is_string( $phrase ) ? trim( $phrase ) : '';
			if ( '' === $phrase ) {
				continue;
			}
			// A related keyphrase gets the same content-based checks minus the ones
			// that can only serve the ONE main phrase (title/slug/title-beginning).
			$sub_paper = array_merge( $paper, array( 'keyphrase' => $phrase, 'synonyms' => array(), 'related' => array() ) );
			$sub_research = self::research( $sub_paper );
			$checks = self::keyphrase_content_checks( $sub_paper, $sub_research );
			$agg = self::aggregate( $checks );
			$related[] = array(
				'keyphrase' => $phrase,
				'score'     => $agg['score'],
				'rating'    => $agg['rating'],
				'checks'    => $checks,
			);
			if ( count( $related ) >= 4 ) {
				break; // Yoast Premium caps related keyphrases at 4.
			}
		}

		return array(
			'seo'         => $seo + array( 'checks' => $seo_checks ),
			'readability' => $read + array( 'checks' => $read_checks ),
			'related'     => $related,
			'insights'    => array(
				'word_count'   => $research['word_count'],
				'reading_time' => (int) ceil( $research['word_count'] / self::WORDS_PER_MINUTE ),
				'flesch'       => self::flesch_value( $research ),
			),
		);
	}

	/**
	 * Aggregate a list of check items into { score 0..100, rating }. Items whose
	 * status is 'na' are excluded. Zero applicable checks → score 0, rating 'na'.
	 *
	 * @param array<int, array> $checks
	 * @return array{ score:int, rating:string }
	 */
	public static function aggregate( array $checks ): array {
		$sum = 0;
		$n = 0;
		foreach ( $checks as $c ) {
			if ( self::NA === $c['status'] ) {
				continue;
			}
			$sum += (int) $c['score'];
			++$n;
		}
		if ( 0 === $n ) {
			return array( 'score' => 0, 'rating' => self::NA );
		}
		$score = (int) round( $sum / ( 9 * $n ) * 100 );
		return array( 'score' => $score, 'rating' => self::overall_rating( $score ) );
	}

	/** Map a 0..100 aggregate to the overall traffic light. */
	public static function overall_rating( int $score ): string {
		if ( $score >= self::GOOD_MIN ) {
			return self::GREEN;
		}
		if ( $score >= self::OK_MIN ) {
			return self::ORANGE;
		}
		return self::RED;
	}

	/** Map a per-check 0..9 score to a status. */
	public static function status_for( int $score ): string {
		if ( $score <= 4 ) {
			return self::RED;
		}
		if ( $score <= 7 ) {
			return self::ORANGE;
		}
		return self::GREEN;
	}

	/** Find one check item by id in a checks list (test/render convenience). @return array|null */
	public static function by_id( array $checks, string $id ): ?array {
		foreach ( $checks as $c ) {
			if ( isset( $c['id'] ) && $c['id'] === $id ) {
				return $c;
			}
		}
		return null;
	}

	// ── the SEO side ────────────────────────────────────────────────────────────

	/**
	 * The SEO check list. When there is no focus keyphrase we surface a single
	 * 'na' state (Appendix A) rather than mis-scoring keyphrase-dependent checks.
	 *
	 * @return array<int, array>
	 */
	private static function seo_checks( array $paper, array $research ): array {
		$keyphrase = self::str( $paper, 'keyphrase' );
		if ( '' === trim( $keyphrase ) ) {
			return array(
				self::item( 'focus_keyphrase', 'seo', 'Focus keyphrase', 0, self::NA, 'No focus keyphrase set. Add the query you want this page to rank for to start scoring.' ),
			);
		}

		$checks = array();
		$checks[] = self::check_keyphrase_length( $paper );
		$checks[] = self::check_keyphrase_in_title( $paper );
		$checks[] = self::check_keyphrase_in_title_beginning( $paper );
		$checks[] = self::check_title_width( $paper );
		$checks[] = self::check_meta_length( $paper );
		$checks[] = self::check_keyphrase_in_meta( $paper, $research );
		$checks[] = self::check_keyphrase_in_slug( $paper );
		// The remaining keyphrase-vs-content checks are shared with related phrases.
		return array_merge( $checks, self::keyphrase_content_checks( $paper, $research ) );
	}

	/**
	 * The content-side keyphrase checks (intro, subheadings, image alt, density,
	 * images, text length). Shared by the main phrase and each related phrase.
	 *
	 * @return array<int, array>
	 */
	private static function keyphrase_content_checks( array $paper, array $research ): array {
		return array(
			self::check_keyphrase_in_introduction( $paper, $research ),
			self::check_keyphrase_in_subheadings( $paper, $research ),
			self::check_keyphrase_in_image_alt( $paper, $research ),
			self::check_images_present( $research ),
			self::check_keyphrase_density( $paper, $research ),
			self::check_text_length( $paper, $research ),
		);
	}

	private static function check_keyphrase_length( array $paper ): array {
		$words = self::content_words( self::str( $paper, 'keyphrase' ) );
		$n = count( $words );
		if ( $n >= 1 && $n <= 4 ) {
			return self::item( 'keyphrase_length', 'seo', 'Keyphrase length', 9, self::GREEN, sprintf( 'Keyphrase length: %d content words. Good length.', $n ) );
		}
		if ( 5 === $n || 6 === $n ) {
			return self::item( 'keyphrase_length', 'seo', 'Keyphrase length', 6, self::ORANGE, sprintf( 'Keyphrase length: %d content words, a little long. Make it shorter.', $n ) );
		}
		return self::item( 'keyphrase_length', 'seo', 'Keyphrase length', 3, self::RED, sprintf( 'Keyphrase length: %d content words is too long. Trim it to 4 or fewer.', $n ) );
	}

	private static function check_keyphrase_in_title( array $paper ): array {
		$title_words = self::tokenize( self::str( $paper, 'title' ) );
		$needle = self::content_words( self::str( $paper, 'keyphrase' ) );
		$present = self::words_all_present( $needle, $title_words );
		$some = self::words_any_present( $needle, $title_words );
		if ( $present ) {
			return self::item( 'keyphrase_in_title', 'seo', 'Keyphrase in SEO title', 9, self::GREEN, 'Keyphrase in SEO title: all keyphrase words appear in the title. Good job!' );
		}
		if ( $some ) {
			return self::item( 'keyphrase_in_title', 'seo', 'Keyphrase in SEO title', 6, self::ORANGE, 'Keyphrase in SEO title: only some keyphrase words are in the title. Use the exact match.' );
		}
		return self::item( 'keyphrase_in_title', 'seo', 'Keyphrase in SEO title', 2, self::RED, 'Keyphrase in SEO title: not found. Put the exact keyphrase in the SEO title.' );
	}

	private static function check_keyphrase_in_title_beginning( array $paper ): array {
		$title_words = self::tokenize( self::str( $paper, 'title' ) );
		$needle = self::content_words( self::str( $paper, 'keyphrase' ) );
		if ( self::phrase_at_beginning( $needle, $title_words ) ) {
			return self::item( 'keyphrase_in_title_beginning', 'seo', 'Keyphrase at title start', 9, self::GREEN, 'Keyphrase at title start: the exact match opens the SEO title. Good job!' );
		}
		if ( self::words_all_present( $needle, $title_words ) ) {
			return self::item( 'keyphrase_in_title_beginning', 'seo', 'Keyphrase at title start', 6, self::ORANGE, 'Keyphrase at title start: the keyphrase is in the title but not at the beginning. Move it to the front.' );
		}
		return self::item( 'keyphrase_in_title_beginning', 'seo', 'Keyphrase at title start', 3, self::RED, 'Keyphrase at title start: the keyphrase does not open the SEO title. Move it to the front.' );
	}

	private static function check_title_width( array $paper ): array {
		$width = isset( $paper['title_width'] ) && is_numeric( $paper['title_width'] )
			? (int) $paper['title_width']
			: self::estimate_pixel_width( self::str( $paper, 'title' ) );
		if ( $width <= 0 ) {
			return self::item( 'title_width', 'seo', 'SEO title width', 3, self::RED, 'SEO title width: no title set. It will fall back to the template — write a specific one.' );
		}
		if ( $width < self::TITLE_PX_MIN ) {
			return self::item( 'title_width', 'seo', 'SEO title width', 6, self::ORANGE, sprintf( 'SEO title width: %d px, on the short side. Use the space (up to 600 px) for a compelling title.', $width ) );
		}
		if ( $width > self::TITLE_PX_MAX ) {
			return self::item( 'title_width', 'seo', 'SEO title width', 3, self::RED, sprintf( 'SEO title width: %d px — over the 600 px limit, so Google will cut it. Shorten it.', $width ) );
		}
		return self::item( 'title_width', 'seo', 'SEO title width', 9, self::GREEN, sprintf( 'SEO title width: %d px — within the visible limit. Good job!', $width ) );
	}

	private static function check_meta_length( array $paper ): array {
		$meta = self::str( $paper, 'meta' );
		$len = self::mb_len( $meta );
		if ( 0 === $len ) {
			return self::item( 'meta_length', 'seo', 'Meta description', 3, self::RED, 'Meta description: none set. Google will invent one — write your own to control the snippet.' );
		}
		if ( $len < self::META_CH_MIN ) {
			return self::item( 'meta_length', 'seo', 'Meta description', 6, self::ORANGE, sprintf( 'Meta description: %d characters — short. Up to 156 are available; use the space.', $len ) );
		}
		if ( $len > self::META_CH_MAX ) {
			return self::item( 'meta_length', 'seo', 'Meta description', 6, self::ORANGE, sprintf( 'Meta description: %d characters — over 156, so Google will cut it. Trim it.', $len ) );
		}
		return self::item( 'meta_length', 'seo', 'Meta description', 9, self::GREEN, sprintf( 'Meta description: %d characters — a good length. Well done!', $len ) );
	}

	private static function check_keyphrase_in_meta( array $paper, array $research ): array {
		$meta = self::str( $paper, 'meta' );
		if ( '' === trim( $meta ) ) {
			// The empty-meta case is owned by check_meta_length; not applicable here.
			return self::item( 'keyphrase_in_meta', 'seo', 'Keyphrase in meta description', 0, self::NA, 'Keyphrase in meta description: no meta description to check yet.' );
		}
		$count = self::phrase_occurrences( self::needles( $paper ), self::tokenize_stemmed( $meta ) );
		if ( 1 === $count || 2 === $count ) {
			return self::item( 'keyphrase_in_meta', 'seo', 'Keyphrase in meta description', 9, self::GREEN, sprintf( 'Keyphrase in meta description: appears %d time(s). Google will bold it. Good.', $count ) );
		}
		if ( 0 === $count ) {
			return self::item( 'keyphrase_in_meta', 'seo', 'Keyphrase in meta description', 3, self::RED, 'Keyphrase in meta description: the keyphrase is missing from the meta description. Add it once.' );
		}
		return self::item( 'keyphrase_in_meta', 'seo', 'Keyphrase in meta description', 3, self::RED, sprintf( 'Keyphrase in meta description: appears %d times — over the max of 2. Trim the repetition.', $count ) );
	}

	private static function check_keyphrase_in_slug( array $paper ): array {
		$slug_words = self::tokenize( str_replace( array( '-', '_' ), ' ', self::str( $paper, 'slug' ) ) );
		$needle = self::content_words( self::str( $paper, 'keyphrase' ) );
		if ( array() === $needle ) {
			return self::item( 'keyphrase_in_slug', 'seo', 'Keyphrase in slug', 0, self::NA, 'Keyphrase in slug: no keyphrase to check.' );
		}
		$hits = self::count_present( $needle, $slug_words );
		$need = count( $needle ) > 2 ? (int) ceil( count( $needle ) / 2 ) : count( $needle );
		if ( $hits >= $need ) {
			return self::item( 'keyphrase_in_slug', 'seo', 'Keyphrase in slug', 9, self::GREEN, 'Keyphrase in slug: the slug contains the keyphrase. Great work!' );
		}
		if ( $hits > 0 ) {
			return self::item( 'keyphrase_in_slug', 'seo', 'Keyphrase in slug', 6, self::ORANGE, 'Keyphrase in slug: only part of the keyphrase is in the slug. Add the rest.' );
		}
		return self::item( 'keyphrase_in_slug', 'seo', 'Keyphrase in slug', 3, self::RED, 'Keyphrase in slug: the slug does not contain the keyphrase. Change it.' );
	}

	private static function check_keyphrase_in_introduction( array $paper, array $research ): array {
		$intro = $research['first_paragraph'];
		$needles = self::needles( $paper );
		if ( '' === trim( $intro ) ) {
			return self::item( 'keyphrase_in_introduction', 'seo', 'Keyphrase in introduction', 3, self::RED, 'Keyphrase in introduction: the first paragraph is empty. Open by saying what the page is about.' );
		}
		$sentences = self::split_sentences( $intro );
		$in_one = false;
		$scattered = false;
		foreach ( $sentences as $s ) {
			$sw = self::tokenize_stemmed( $s );
			foreach ( $needles as $needle ) {
				if ( self::words_all_present( $needle, $sw ) ) {
					$in_one = true;
					break 2;
				}
			}
		}
		if ( ! $in_one ) {
			$para_words = self::tokenize_stemmed( $intro );
			foreach ( $needles as $needle ) {
				if ( self::words_all_present( $needle, $para_words ) ) {
					$scattered = true;
					break;
				}
			}
		}
		if ( $in_one ) {
			return self::item( 'keyphrase_in_introduction', 'seo', 'Keyphrase in introduction', 9, self::GREEN, 'Keyphrase in introduction: the keyphrase appears in the first paragraph. Well done!' );
		}
		if ( $scattered ) {
			return self::item( 'keyphrase_in_introduction', 'seo', 'Keyphrase in introduction', 6, self::ORANGE, 'Keyphrase in introduction: the words are in the first paragraph but not within one sentence. Tighten it.' );
		}
		return self::item( 'keyphrase_in_introduction', 'seo', 'Keyphrase in introduction', 3, self::RED, 'Keyphrase in introduction: not found in your first paragraph. Say what the page is about up top.' );
	}

	private static function check_keyphrase_in_subheadings( array $paper, array $research ): array {
		$subs = $research['subheadings'];
		$total = count( $subs );
		if ( 0 === $total ) {
			return self::item( 'keyphrase_in_subheadings', 'seo', 'Keyphrase in subheadings', 0, self::NA, 'Keyphrase in subheadings: no H2/H3 subheadings to check.' );
		}
		$needles = self::needles( $paper );
		$hit = 0;
		foreach ( $subs as $sub ) {
			$sw = self::tokenize_stemmed( $sub );
			foreach ( $needles as $needle ) {
				if ( self::words_all_present( $needle, $sw ) ) {
					++$hit;
					break;
				}
			}
		}
		$pct = (int) round( $hit / $total * 100 );
		if ( $pct >= 30 && $pct <= 75 ) {
			return self::item( 'keyphrase_in_subheadings', 'seo', 'Keyphrase in subheadings', 9, self::GREEN, sprintf( 'Keyphrase in subheadings: %d%% of your H2/H3 reflect the topic. Good job!', $pct ) );
		}
		if ( $pct > 75 ) {
			return self::item( 'keyphrase_in_subheadings', 'seo', 'Keyphrase in subheadings', 3, self::RED, sprintf( 'Keyphrase in subheadings: %d%% of your H2/H3 use it — too many. Don\'t over-optimize.', $pct ) );
		}
		if ( $pct > 0 ) {
			return self::item( 'keyphrase_in_subheadings', 'seo', 'Keyphrase in subheadings', 6, self::ORANGE, sprintf( 'Keyphrase in subheadings: only %d%% of your H2/H3 reflect the topic. Use it in a few more.', $pct ) );
		}
		return self::item( 'keyphrase_in_subheadings', 'seo', 'Keyphrase in subheadings', 3, self::RED, 'Keyphrase in subheadings: none of your H2/H3 reflect the topic. Add the keyphrase to some.' );
	}

	private static function check_keyphrase_in_image_alt( array $paper, array $research ): array {
		$images = $research['images'];
		$total = count( $images );
		if ( 0 === $total ) {
			return self::item( 'keyphrase_in_image_alt', 'seo', 'Image keyphrase (alt)', 0, self::NA, 'Image keyphrase (alt): no images to check.' );
		}
		$needles = self::needles( $paper );
		$hit = 0;
		foreach ( $images as $alt ) {
			$aw = self::tokenize_stemmed( $alt );
			foreach ( $needles as $needle ) {
				if ( self::words_all_present( $needle, $aw ) ) {
					++$hit;
					break;
				}
			}
		}
		$pct = (int) round( $hit / $total * 100 );
		if ( 0 === $hit ) {
			return self::item( 'keyphrase_in_image_alt', 'seo', 'Image keyphrase (alt)', 3, self::RED, 'Image keyphrase (alt): no image alt text reflects the topic. Add the keyphrase to a relevant image.' );
		}
		if ( $pct >= 30 && $pct <= 70 ) {
			return self::item( 'keyphrase_in_image_alt', 'seo', 'Image keyphrase (alt)', 9, self::GREEN, sprintf( 'Image keyphrase (alt): %d%% of images carry the keyphrase in alt text. Good job!', $pct ) );
		}
		if ( $pct > 70 ) {
			return self::item( 'keyphrase_in_image_alt', 'seo', 'Image keyphrase (alt)', 6, self::ORANGE, sprintf( 'Image keyphrase (alt): %d%% of images use the keyphrase in alt — a bit much. Vary the alt text.', $pct ) );
		}
		return self::item( 'keyphrase_in_image_alt', 'seo', 'Image keyphrase (alt)', 6, self::ORANGE, sprintf( 'Image keyphrase (alt): only %d%% of images use the keyphrase in alt. Add it to a few more.', $pct ) );
	}

	private static function check_images_present( array $research ): array {
		$n = count( $research['images'] );
		if ( $n >= 1 ) {
			return self::item( 'images_present', 'seo', 'Images', 9, self::GREEN, sprintf( 'Images: %d on this page. Good job!', $n ) );
		}
		return self::item( 'images_present', 'seo', 'Images', 3, self::RED, 'Images: none on this page. Add at least one relevant image.' );
	}

	private static function check_keyphrase_density( array $paper, array $research ): array {
		$wc = $research['word_count'];
		if ( 0 === $wc ) {
			return self::item( 'keyphrase_density', 'seo', 'Keyphrase density', 0, self::NA, 'Keyphrase density: no body text to measure.' );
		}
		$count = self::phrase_occurrences( self::needles( $paper ), $research['words_stemmed'] );
		$density = 100.0 * $count / $wc;
		$d = round( $density, 1 );
		if ( 0 === $count ) {
			return self::item( 'keyphrase_density', 'seo', 'Keyphrase density', 3, self::RED, 'Keyphrase density: the keyphrase does not appear in the copy. Work it into the text.' );
		}
		if ( $density > 3.0 ) {
			return self::item( 'keyphrase_density', 'seo', 'Keyphrase density', 3, self::RED, sprintf( 'Keyphrase density: %s%% (%d occurrences) — over the 3%% maximum. Don\'t over-optimize.', $d, $count ) );
		}
		if ( $density < 0.5 ) {
			return self::item( 'keyphrase_density', 'seo', 'Keyphrase density', 4, self::RED, sprintf( 'Keyphrase density: %s%% (%d occurrences) — under the 0.5%% minimum. Use the keyphrase more.', $d, $count ) );
		}
		return self::item( 'keyphrase_density', 'seo', 'Keyphrase density', 9, self::GREEN, sprintf( 'Keyphrase density: %s%% (%d occurrences) — within the 0.5–3%% sweet spot. Good.', $d, $count ) );
	}

	private static function check_text_length( array $paper, array $research ): array {
		$wc = $research['word_count'];
		$good = self::text_good_bar( $paper );
		$ok_floor = $good - 50;
		if ( $wc >= $good ) {
			return self::item( 'text_length', 'seo', 'Text length', 9, self::GREEN, sprintf( 'Text length: %d words. Good job!', $wc ) );
		}
		if ( $wc >= $ok_floor ) {
			return self::item( 'text_length', 'seo', 'Text length', 6, self::ORANGE, sprintf( 'Text length: %d words — a little under the %d-word target. Add a bit more.', $wc, $good ) );
		}
		return self::item( 'text_length', 'seo', 'Text length', 3, self::RED, sprintf( 'Text length: %d words — below the %d-word target. Add more content.', $wc, $good ) );
	}

	private static function text_good_bar( array $paper ): int {
		if ( ! empty( $paper['is_cornerstone'] ) ) {
			return self::TEXT_GOOD_CORNERSTONE;
		}
		if ( 'taxonomy' === self::str( $paper, 'type' ) ) {
			return self::TEXT_GOOD_TAXONOMY;
		}
		return self::TEXT_GOOD_DEFAULT;
	}

	// ── the readability side ────────────────────────────────────────────────────

	/** @return array<int, array> */
	private static function readability_checks( array $paper, array $research ): array {
		$en = self::is_english( $paper );
		return array(
			self::check_sentence_length( $research ),
			self::check_paragraph_length( $research ),
			self::check_subheading_distribution( $research ),
			self::check_passive_voice( $research, $en ),
			self::check_transition_words( $research, $en ),
			self::check_consecutive_sentences( $research ),
			self::check_flesch( $research, $en ),
		);
	}

	private static function check_sentence_length( array $research ): array {
		$sentences = $research['sentences'];
		$total = count( $sentences );
		if ( 0 === $total ) {
			return self::item( 'sentence_length', 'readability', 'Sentence length', 0, self::NA, 'Sentence length: no sentences to measure.' );
		}
		$long = 0;
		foreach ( $sentences as $s ) {
			if ( count( self::tokenize( $s ) ) > 20 ) {
				++$long;
			}
		}
		$pct = round( $long / $total * 100, 1 );
		if ( $pct <= 25 ) {
			return self::item( 'sentence_length', 'readability', 'Sentence length', 9, self::GREEN, sprintf( 'Sentence length: %s%% of sentences are over 20 words — within the 25%% limit. Good.', $pct ) );
		}
		if ( $pct <= 30 ) {
			return self::item( 'sentence_length', 'readability', 'Sentence length', 6, self::ORANGE, sprintf( 'Sentence length: %s%% of sentences are over 20 words — over the 25%% guideline. Shorten a few.', $pct ) );
		}
		return self::item( 'sentence_length', 'readability', 'Sentence length', 3, self::RED, sprintf( 'Sentence length: %s%% of sentences are over 20 words — well over 25%%. Break the long ones up.', $pct ) );
	}

	private static function check_paragraph_length( array $research ): array {
		$paras = $research['paragraph_words'];
		if ( array() === $paras ) {
			return self::item( 'paragraph_length', 'readability', 'Paragraph length', 0, self::NA, 'Paragraph length: no paragraphs to measure.' );
		}
		$max = max( $paras );
		if ( $max <= 150 ) {
			return self::item( 'paragraph_length', 'readability', 'Paragraph length', 9, self::GREEN, sprintf( 'Paragraph length: longest paragraph is %d words — under 150. Good.', $max ) );
		}
		if ( $max <= 200 ) {
			return self::item( 'paragraph_length', 'readability', 'Paragraph length', 6, self::ORANGE, sprintf( 'Paragraph length: a paragraph runs %d words — over 150. Consider splitting it.', $max ) );
		}
		return self::item( 'paragraph_length', 'readability', 'Paragraph length', 3, self::RED, sprintf( 'Paragraph length: a paragraph runs %d words — over 200. Shorten your paragraphs.', $max ) );
	}

	private static function check_subheading_distribution( array $research ): array {
		$wc = $research['word_count'];
		if ( 0 === $wc ) {
			return self::item( 'subheading_distribution', 'readability', 'Subheading distribution', 0, self::NA, 'Subheading distribution: no body text to measure.' );
		}
		if ( $wc < 300 ) {
			return self::item( 'subheading_distribution', 'readability', 'Subheading distribution', 9, self::GREEN, 'Subheading distribution: the text is short and probably does not need subheadings. Good.' );
		}
		$run = $research['longest_subheadless_run'];
		if ( $run <= 300 ) {
			return self::item( 'subheading_distribution', 'readability', 'Subheading distribution', 9, self::GREEN, sprintf( 'Subheading distribution: no section runs longer than %d words without a subheading. Good.', $run ) );
		}
		if ( $run <= 350 ) {
			return self::item( 'subheading_distribution', 'readability', 'Subheading distribution', 6, self::ORANGE, sprintf( 'Subheading distribution: a section runs %d words without a subheading. Add one.', $run ) );
		}
		return self::item( 'subheading_distribution', 'readability', 'Subheading distribution', 3, self::RED, sprintf( 'Subheading distribution: a section runs %d words without a subheading. Break it up with subheadings.', $run ) );
	}

	private static function check_passive_voice( array $research, bool $en ): array {
		if ( ! $en ) {
			return self::item( 'passive_voice', 'readability', 'Passive voice', 0, self::NA, 'Passive voice: not checked — this heuristic only supports English for now.' );
		}
		$sentences = $research['sentences'];
		$total = count( $sentences );
		if ( 0 === $total ) {
			return self::item( 'passive_voice', 'readability', 'Passive voice', 0, self::NA, 'Passive voice: no sentences to measure.' );
		}
		$passive = 0;
		foreach ( $sentences as $s ) {
			if ( self::sentence_is_passive( $s ) ) {
				++$passive;
			}
		}
		$pct = round( $passive / $total * 100, 1 );
		if ( $pct <= 10 ) {
			return self::item( 'passive_voice', 'readability', 'Passive voice', 9, self::GREEN, sprintf( 'Passive voice: %s%% of sentences — within the 10%% limit. That\'s great!', $pct ) );
		}
		if ( $pct <= 15 ) {
			return self::item( 'passive_voice', 'readability', 'Passive voice', 6, self::ORANGE, sprintf( 'Passive voice: %s%% of sentences — over the 10%% guideline. Prefer the active voice.', $pct ) );
		}
		return self::item( 'passive_voice', 'readability', 'Passive voice', 3, self::RED, sprintf( 'Passive voice: %s%% of sentences — well over 10%%. Rewrite some in the active voice.', $pct ) );
	}

	private static function check_transition_words( array $research, bool $en ): array {
		if ( ! $en ) {
			return self::item( 'transition_words', 'readability', 'Transition words', 0, self::NA, 'Transition words: not checked — only supports English for now.' );
		}
		$sentences = $research['sentences'];
		$total = count( $sentences );
		if ( 0 === $total ) {
			return self::item( 'transition_words', 'readability', 'Transition words', 0, self::NA, 'Transition words: no sentences to measure.' );
		}
		$with = 0;
		foreach ( $sentences as $s ) {
			if ( self::sentence_has_transition( $s ) ) {
				++$with;
			}
		}
		$pct = round( $with / $total * 100, 1 );
		if ( $pct >= 30 ) {
			return self::item( 'transition_words', 'readability', 'Transition words', 9, self::GREEN, sprintf( 'Transition words: %s%% of sentences use one — plenty. Good.', $pct ) );
		}
		if ( $pct >= 20 ) {
			return self::item( 'transition_words', 'readability', 'Transition words', 6, self::ORANGE, sprintf( 'Transition words: %s%% of sentences use one — a bit low. Add a few more.', $pct ) );
		}
		return self::item( 'transition_words', 'readability', 'Transition words', 3, self::RED, sprintf( 'Transition words: only %s%% of sentences use one. Use more to connect your ideas.', $pct ) );
	}

	private static function check_consecutive_sentences( array $research ): array {
		$sentences = $research['sentences'];
		if ( count( $sentences ) < 3 ) {
			return self::item( 'consecutive_sentences', 'readability', 'Consecutive sentences', 0, self::NA, 'Consecutive sentences: too few sentences to judge variety.' );
		}
		$run = 1;
		$max_run = 1;
		$prev = null;
		foreach ( $sentences as $s ) {
			$first = self::first_content_word( $s );
			if ( '' === $first ) {
				$prev = null;
				$run = 1;
				continue;
			}
			if ( null !== $prev && $first === $prev ) {
				++$run;
				$max_run = max( $max_run, $run );
			} else {
				$run = 1;
			}
			$prev = $first;
		}
		if ( $max_run >= 3 ) {
			return self::item( 'consecutive_sentences', 'readability', 'Consecutive sentences', 3, self::RED, sprintf( 'Consecutive sentences: %d in a row start with the same word. Mix things up!', $max_run ) );
		}
		return self::item( 'consecutive_sentences', 'readability', 'Consecutive sentences', 9, self::GREEN, 'Consecutive sentences: enough variety in how sentences start. That\'s great!' );
	}

	private static function check_flesch( array $research, bool $en ): array {
		if ( ! $en ) {
			return self::item( 'flesch', 'readability', 'Reading ease', 0, self::NA, 'Reading ease: not checked — the Flesch formula only supports English for now.' );
		}
		$flesch = self::flesch_value( $research );
		if ( null === $flesch ) {
			return self::item( 'flesch', 'readability', 'Reading ease', 0, self::NA, 'Reading ease: no measurable text yet.' );
		}
		$f = round( $flesch, 1 );
		if ( $flesch >= 60 ) {
			return self::item( 'flesch', 'readability', 'Reading ease', 9, self::GREEN, sprintf( 'Reading ease: %s (Flesch) — easy to read. Good.', $f ) );
		}
		if ( $flesch >= 50 ) {
			return self::item( 'flesch', 'readability', 'Reading ease', 6, self::ORANGE, sprintf( 'Reading ease: %s (Flesch) — fairly hard. Shorten sentences and simplify words.', $f ) );
		}
		return self::item( 'flesch', 'readability', 'Reading ease', 3, self::RED, sprintf( 'Reading ease: %s (Flesch) — hard to read. Use shorter sentences and simpler words.', $f ) );
	}

	/** The Flesch Reading Ease value, or null when there is nothing to measure. @return float|null */
	private static function flesch_value( array $research ) {
		$words = $research['word_count'];
		$sentences = max( 1, count( $research['sentences'] ) );
		if ( 0 === $words ) {
			return null;
		}
		$syllables = $research['syllables'];
		return 206.835 - 1.015 * ( $words / $sentences ) - 84.6 * ( $syllables / $words );
	}

	// ── research (compute-once shared inputs) ───────────────────────────────────

	/**
	 * Build the shared research array from a paper in one pass. Everything the
	 * checks consume lives here so the analysis is O(content) not O(content×checks).
	 *
	 * @return array<string, mixed>
	 */
	private static function research( array $paper ): array {
		$html = self::str( $paper, 'content' );
		if ( strlen( $html ) > self::MAX_CONTENT_BYTES ) {
			$html = substr( $html, 0, self::MAX_CONTENT_BYTES );
		}

		$subheadings = self::extract_subheadings( $html );
		$images = self::extract_image_alts( $html );
		$paragraphs = self::extract_paragraphs( $html );
		$plain = self::html_to_text( $html );

		$words = self::tokenize( $plain );
		$word_count = count( $words );
		$sentences = self::split_sentences( $plain );

		$paragraph_words = array();
		foreach ( $paragraphs as $p ) {
			$paragraph_words[] = count( self::tokenize( $p ) );
		}

		$first_paragraph = array() !== $paragraphs ? $paragraphs[0] : $plain;

		return array(
			'plain'                   => $plain,
			'words'                   => $words,
			'words_stemmed'           => array_map( array( __CLASS__, 'stem' ), $words ),
			'word_count'              => $word_count,
			'sentences'               => $sentences,
			'paragraphs'              => $paragraphs,
			'paragraph_words'         => $paragraph_words,
			'first_paragraph'         => $first_paragraph,
			'subheadings'             => $subheadings,
			'images'                  => $images,
			'syllables'               => self::count_syllables( $words ),
			'longest_subheadless_run' => self::longest_subheadless_run( $html ),
		);
	}

	/** All match needles: the keyphrase content words plus each synonym's. @return array<int, array<int, string>> */
	private static function needles( array $paper ): array {
		$needles = array();
		$key = self::content_words( self::str( $paper, 'keyphrase' ) );
		if ( array() !== $key ) {
			$needles[] = array_map( array( __CLASS__, 'stem' ), $key );
		}
		$synonyms = isset( $paper['synonyms'] ) && is_array( $paper['synonyms'] ) ? $paper['synonyms'] : array();
		foreach ( $synonyms as $syn ) {
			$syn = is_string( $syn ) ? $syn : '';
			$sw = self::content_words( $syn );
			if ( array() !== $sw ) {
				$needles[] = array_map( array( __CLASS__, 'stem' ), $sw );
			}
		}
		return $needles;
	}

	// ── tokenization + matching primitives ──────────────────────────────────────

	/** Lower-cased word tokens (letters/numbers/apostrophes). @return string[] */
	public static function tokenize( string $text ): array {
		$text = self::lower( $text );
		$parts = preg_split( '/[^\p{L}\p{N}\']+/u', $text, -1, PREG_SPLIT_NO_EMPTY );
		return is_array( $parts ) ? $parts : array();
	}

	/** Tokens with the light stemmer applied. @return string[] */
	private static function tokenize_stemmed( string $text ): array {
		return array_map( array( __CLASS__, 'stem' ), self::tokenize( $text ) );
	}

	/** Content words of a phrase: tokens minus function words. @return string[] */
	public static function content_words( string $phrase ): array {
		$out = array();
		foreach ( self::tokenize( $phrase ) as $w ) {
			if ( ! isset( self::FUNCTION_WORDS[ $w ] ) ) {
				$out[] = $w;
			}
		}
		// A phrase made ENTIRELY of function words keeps its words so it is never empty.
		return array() === $out ? self::tokenize( $phrase ) : $out;
	}

	/** True when every needle word (already stemmed) is present in the haystack tokens. */
	private static function words_all_present( array $needle_words, array $haystack_tokens ): bool {
		if ( array() === $needle_words ) {
			return false;
		}
		$stem_haystack = array();
		foreach ( $haystack_tokens as $t ) {
			$stem_haystack[ self::stem( $t ) ] = true;
		}
		foreach ( $needle_words as $w ) {
			if ( ! isset( $stem_haystack[ self::stem( $w ) ] ) ) {
				return false;
			}
		}
		return true;
	}

	/** True when at least one needle word is present. */
	private static function words_any_present( array $needle_words, array $haystack_tokens ): bool {
		return self::count_present( $needle_words, $haystack_tokens ) > 0;
	}

	/** How many needle words appear in the haystack. */
	private static function count_present( array $needle_words, array $haystack_tokens ): int {
		$stem_haystack = array();
		foreach ( $haystack_tokens as $t ) {
			$stem_haystack[ self::stem( $t ) ] = true;
		}
		$hits = 0;
		foreach ( $needle_words as $w ) {
			if ( isset( $stem_haystack[ self::stem( $w ) ] ) ) {
				++$hits;
			}
		}
		return $hits;
	}

	/** True when the needle words open the haystack (in order, at position 0). */
	private static function phrase_at_beginning( array $needle_words, array $haystack_tokens ): bool {
		$n = count( $needle_words );
		if ( 0 === $n || count( $haystack_tokens ) < $n ) {
			return false;
		}
		for ( $i = 0; $i < $n; $i++ ) {
			if ( self::stem( $haystack_tokens[ $i ] ) !== self::stem( $needle_words[ $i ] ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Occurrence count of a set of needles across a stemmed token stream. For a
	 * single-word needle it is the token frequency; for a multi-word needle it is
	 * the min frequency across its words (a deterministic co-occurrence proxy).
	 * Needle counts are summed (keyphrase + synonyms → topic frequency).
	 */
	private static function phrase_occurrences( array $needles, array $stemmed_tokens ): int {
		if ( array() === $needles || array() === $stemmed_tokens ) {
			return 0;
		}
		$freq = array();
		foreach ( $stemmed_tokens as $t ) {
			$freq[ $t ] = ( $freq[ $t ] ?? 0 ) + 1;
		}
		$total = 0;
		foreach ( $needles as $needle ) {
			$min = null;
			foreach ( $needle as $w ) {
				$c = $freq[ self::stem( $w ) ] ?? 0;
				$min = null === $min ? $c : min( $min, $c );
			}
			$total += (int) $min;
		}
		return $total;
	}

	/**
	 * A light Porter-ish English stemmer: enough to fold buy/buys/buying and
	 * grinder/grinders together without a morphology data file (§12.5). Kept simple
	 * and deterministic so threshold tests are stable.
	 */
	public static function stem( string $word ): string {
		$w = self::lower( $word );
		$len = strlen( $w );
		if ( $len <= 3 ) {
			return $w;
		}
		if ( self::ends_with( $w, 'ies' ) && $len > 4 ) {
			return substr( $w, 0, -3 ) . 'y';
		}
		if ( self::ends_with( $w, 'ing' ) && $len > 5 ) {
			return substr( $w, 0, -3 );
		}
		if ( self::ends_with( $w, 'edly' ) && $len > 5 ) {
			return substr( $w, 0, -4 );
		}
		if ( self::ends_with( $w, 'ly' ) && $len > 4 ) {
			return substr( $w, 0, -2 );
		}
		if ( self::ends_with( $w, 'es' ) && $len > 4 ) {
			return substr( $w, 0, -2 );
		}
		if ( self::ends_with( $w, 'ed' ) && $len > 4 ) {
			return substr( $w, 0, -2 );
		}
		if ( self::ends_with( $w, 's' ) && ! self::ends_with( $w, 'ss' ) && $len > 3 ) {
			return substr( $w, 0, -1 );
		}
		return $w;
	}

	// ── sentence / passive / transition helpers ─────────────────────────────────

	/** Split plain text into sentences on terminators. @return string[] */
	public static function split_sentences( string $text ): array {
		$text = trim( preg_replace( '/\s+/u', ' ', $text ) ?? '' );
		if ( '' === $text ) {
			return array();
		}
		$parts = preg_split( '/(?<=[.!?])\s+/u', $text );
		$out = array();
		foreach ( (array) $parts as $p ) {
			$p = trim( (string) $p );
			if ( '' !== $p && preg_match( '/\p{L}/u', $p ) ) {
				$out[] = $p;
			}
		}
		return $out;
	}

	/** English passive-voice heuristic: auxiliary + nearby past participle. */
	private static function sentence_is_passive( string $sentence ): bool {
		$tokens = self::tokenize( $sentence );
		$n = count( $tokens );
		for ( $i = 0; $i < $n; $i++ ) {
			if ( ! isset( self::PASSIVE_AUX[ $tokens[ $i ] ] ) ) {
				continue;
			}
			$limit = min( $n, $i + 4 );
			for ( $j = $i + 1; $j < $limit; $j++ ) {
				if ( self::is_participle( $tokens[ $j ] ) ) {
					return true;
				}
			}
		}
		return false;
	}

	/** Whether a token is a past participle (regular -ed or a common irregular). */
	private static function is_participle( string $token ): bool {
		if ( isset( self::IRREGULAR_PARTICIPLES[ $token ] ) ) {
			return true;
		}
		return strlen( $token ) > 3 && self::ends_with( $token, 'ed' );
	}

	/** Whether a sentence contains a transition word/phrase. */
	private static function sentence_has_transition( string $sentence ): bool {
		$lower = self::lower( $sentence );
		foreach ( self::TRANSITION_PHRASES as $phrase ) {
			if ( false !== strpos( ' ' . $lower . ' ', ' ' . $phrase . ' ' ) ) {
				return true;
			}
		}
		$tokens = self::tokenize( $sentence );
		foreach ( $tokens as $t ) {
			if ( isset( self::TRANSITION_WORDS[ $t ] ) ) {
				return true;
			}
		}
		return false;
	}

	/** First non-stopword token of a sentence (for the consecutive-starts check). */
	private static function first_content_word( string $sentence ): string {
		foreach ( self::tokenize( $sentence ) as $t ) {
			if ( ! isset( self::CONSECUTIVE_STOP[ $t ] ) ) {
				return self::stem( $t );
			}
		}
		return '';
	}

	// ── HTML extraction (regex-based so the class stays WP-free) ────────────────

	/** Strip tags to readable text, decoding entities and dropping script/style. */
	public static function html_to_text( string $html ): string {
		$html = preg_replace( '#<(script|style)\b[^>]*>.*?</\1>#is', ' ', $html ) ?? $html;
		$html = preg_replace( '#<[^>]+>#', ' ', $html ) ?? $html;
		$text = html_entity_decode( $html, ENT_QUOTES | ENT_HTML5, 'UTF-8' );
		$text = preg_replace( '/\s+/u', ' ', $text ) ?? $text;
		return trim( $text );
	}

	/** @return string[] H2/H3 inner text. */
	private static function extract_subheadings( string $html ): array {
		$out = array();
		if ( preg_match_all( '#<h[23]\b[^>]*>(.*?)</h[23]>#is', $html, $m ) ) {
			foreach ( $m[1] as $inner ) {
				$out[] = self::html_to_text( $inner );
			}
		}
		return $out;
	}

	/**
	 * @return string[] the `src` URL of each <img> that has one (imgs without a
	 * src are skipped). Sibling of extract_image_alts, same regex idiom — used to
	 * fold in-content images into the XML sitemap. Public + pure so it is unit
	 * testable with plain strings.
	 */
	public static function extract_image_srcs( string $html ): array {
		$out = array();
		if ( preg_match_all( '#<img\b[^>]*>#is', $html, $m ) ) {
			foreach ( $m[0] as $tag ) {
				if ( ! preg_match( '#\bsrc\s*=\s*("([^"]*)"|\'([^\']*)\')#i', $tag, $sm ) ) {
					continue; // No src attribute — skip.
				}
				$src = '' !== $sm[2] ? $sm[2] : ( isset( $sm[3] ) ? $sm[3] : '' );
				$src = trim( html_entity_decode( $src, ENT_QUOTES | ENT_HTML5, 'UTF-8' ) );
				if ( '' !== $src ) {
					$out[] = $src;
				}
			}
		}
		return $out;
	}

	/** @return string[] alt text of each <img> (empty string when alt is absent). */
	private static function extract_image_alts( string $html ): array {
		$out = array();
		if ( preg_match_all( '#<img\b[^>]*>#is', $html, $m ) ) {
			foreach ( $m[0] as $tag ) {
				$alt = '';
				if ( preg_match( '#\balt\s*=\s*("([^"]*)"|\'([^\']*)\')#i', $tag, $am ) ) {
					$alt = '' !== $am[2] ? $am[2] : ( isset( $am[3] ) ? $am[3] : '' );
				}
				$out[] = self::html_to_text( $alt );
			}
		}
		return $out;
	}

	/**
	 * Paragraph texts: prefer explicit <p> blocks; fall back to blank-line splitting
	 * so plain-text / block content is still measured. @return string[]
	 */
	private static function extract_paragraphs( string $html ): array {
		$out = array();
		if ( preg_match_all( '#<p\b[^>]*>(.*?)</p>#is', $html, $m ) ) {
			foreach ( $m[1] as $inner ) {
				$t = self::html_to_text( $inner );
				if ( '' !== $t ) {
					$out[] = $t;
				}
			}
		}
		if ( array() !== $out ) {
			return $out;
		}
		$plain = self::html_to_text( preg_replace( '#<(h[1-6]|div|section|article|br)\b[^>]*>#i', "\n", $html ) ?? $html );
		foreach ( preg_split( '/\n{1,}/', $plain ) as $chunk ) {
			$chunk = trim( (string) $chunk );
			if ( '' !== $chunk ) {
				$out[] = $chunk;
			}
		}
		return array() !== $out ? $out : array( self::html_to_text( $html ) );
	}

	/**
	 * Longest run of words between subheadings (§4.2 subheading distribution). We
	 * split the content on H2/H3 boundaries and take the max word count of the
	 * resulting chunks.
	 */
	private static function longest_subheadless_run( string $html ): int {
		$chunks = preg_split( '#<h[23]\b[^>]*>.*?</h[23]>#is', $html );
		$max = 0;
		foreach ( (array) $chunks as $chunk ) {
			$max = max( $max, count( self::tokenize( self::html_to_text( (string) $chunk ) ) ) );
		}
		return $max;
	}

	/** Syllable estimate across a token list (vowel-group heuristic). */
	private static function count_syllables( array $words ): int {
		$total = 0;
		foreach ( $words as $w ) {
			$total += self::syllables_in( $w );
		}
		return $total;
	}

	/** Rough English syllable count for one word (min 1). */
	private static function syllables_in( string $word ): int {
		$w = preg_replace( '/[^a-z]/', '', self::lower( $word ) ) ?? '';
		if ( '' === $w ) {
			return 0;
		}
		$groups = preg_match_all( '/[aeiouy]+/', $w );
		$count = is_int( $groups ) ? $groups : 0;
		if ( strlen( $w ) > 2 && self::ends_with( $w, 'e' ) && ! self::ends_with( $w, 'le' ) ) {
			--$count;
		}
		return max( 1, $count );
	}

	// ── title pixel-width estimate ──────────────────────────────────────────────

	/**
	 * Estimate the rendered pixel width of a title at Google's ~20px Arial metrics
	 * using a per-character class width table. The editor refines this live with
	 * canvas measureText and passes `title_width`, but the server needs a value too.
	 */
	public static function estimate_pixel_width( string $title ): int {
		$title = trim( $title );
		if ( '' === $title ) {
			return 0;
		}
		$chars = preg_split( '//u', $title, -1, PREG_SPLIT_NO_EMPTY );
		$width = 0.0;
		foreach ( (array) $chars as $ch ) {
			$width += self::char_width( $ch );
		}
		return (int) round( $width );
	}

	/** Approximate glyph advance (px) at ~20px Arial for width estimation. */
	private static function char_width( string $ch ): float {
		if ( ' ' === $ch ) {
			return 5.0;
		}
		if ( 1 !== strlen( $ch ) ) {
			return 11.0; // multibyte glyph — assume a wide advance.
		}
		if ( false !== strpos( "iIl.,:;'|!ftj", $ch ) ) {
			return 5.0;
		}
		if ( false !== strpos( 'mwMW', $ch ) ) {
			return 15.5;
		}
		if ( $ch >= 'A' && $ch <= 'Z' ) {
			return 12.0;
		}
		if ( $ch >= '0' && $ch <= '9' ) {
			return 10.0;
		}
		return 9.0;
	}

	// ── tiny string helpers ─────────────────────────────────────────────────────

	private static function str( array $a, string $k ): string {
		return isset( $a[ $k ] ) && is_string( $a[ $k ] ) ? $a[ $k ] : '';
	}

	private static function lower( string $s ): string {
		return function_exists( 'mb_strtolower' ) ? mb_strtolower( $s, 'UTF-8' ) : strtolower( $s );
	}

	private static function mb_len( string $s ): int {
		return function_exists( 'mb_strlen' ) ? (int) mb_strlen( $s, 'UTF-8' ) : strlen( $s );
	}

	private static function ends_with( string $haystack, string $needle ): bool {
		$nl = strlen( $needle );
		return $nl <= strlen( $haystack ) && substr( $haystack, -$nl ) === $needle;
	}

	private static function is_english( array $paper ): bool {
		$locale = self::str( $paper, 'locale' );
		if ( '' === $locale ) {
			return true; // default assumption for a plain paper.
		}
		return 0 === stripos( $locale, 'en' );
	}

	/** A fresh check item. */
	private static function item( string $id, string $group, string $label, int $score, string $status, string $message ): array {
		return array(
			'id'      => $id,
			'group'   => $group,
			'label'   => $label,
			'score'   => $score,
			'status'  => $status,
			'message' => $message,
		);
	}

	// ── static word lists ───────────────────────────────────────────────────────

	/** Function words ignored when counting keyphrase "content" words. */
	const FUNCTION_WORDS = array(
		'a' => 1, 'an' => 1, 'and' => 1, 'as' => 1, 'at' => 1, 'be' => 1, 'by' => 1, 'for' => 1,
		'from' => 1, 'in' => 1, 'into' => 1, 'is' => 1, 'of' => 1, 'on' => 1, 'or' => 1, 'the' => 1,
		'to' => 1, 'with' => 1, 'your' => 1, 'you' => 1, 'this' => 1, 'that' => 1, 'it' => 1, 'its' => 1,
		'are' => 1, 'was' => 1, 'were' => 1, 'will' => 1, 'not' => 1, 'but' => 1, 'if' => 1, 'so' => 1,
	);

	/** Auxiliaries that can head an English passive construction. */
	const PASSIVE_AUX = array(
		'am' => 1, 'is' => 1, 'are' => 1, 'was' => 1, 'were' => 1, 'be' => 1, 'been' => 1,
		'being' => 1, 'get' => 1, 'gets' => 1, 'got' => 1, 'gotten' => 1,
	);

	/** Common irregular past participles (regular -ed is detected separately). */
	const IRREGULAR_PARTICIPLES = array(
		'done' => 1, 'made' => 1, 'given' => 1, 'taken' => 1, 'seen' => 1, 'written' => 1, 'known' => 1,
		'shown' => 1, 'held' => 1, 'kept' => 1, 'built' => 1, 'sent' => 1, 'told' => 1, 'found' => 1,
		'bought' => 1, 'brought' => 1, 'thought' => 1, 'caught' => 1, 'taught' => 1, 'put' => 1, 'set' => 1,
		'cut' => 1, 'read' => 1, 'run' => 1, 'come' => 1, 'become' => 1, 'begun' => 1, 'chosen' => 1,
		'driven' => 1, 'eaten' => 1, 'fallen' => 1, 'forgotten' => 1, 'hidden' => 1, 'ridden' => 1,
		'risen' => 1, 'spoken' => 1, 'stolen' => 1, 'broken' => 1, 'frozen' => 1, 'born' => 1, 'worn' => 1,
		'torn' => 1, 'drawn' => 1, 'grown' => 1, 'thrown' => 1, 'blown' => 1, 'flown' => 1, 'gone' => 1,
		'left' => 1, 'lost' => 1, 'meant' => 1, 'paid' => 1, 'said' => 1, 'sold' => 1, 'spent' => 1,
	);

	/** Single-word transition words. */
	const TRANSITION_WORDS = array(
		'however' => 1, 'therefore' => 1, 'consequently' => 1, 'furthermore' => 1, 'moreover' => 1,
		'meanwhile' => 1, 'nevertheless' => 1, 'nonetheless' => 1, 'accordingly' => 1, 'additionally' => 1,
		'besides' => 1, 'finally' => 1, 'first' => 1, 'firstly' => 1, 'second' => 1, 'secondly' => 1,
		'third' => 1, 'thirdly' => 1, 'next' => 1, 'then' => 1, 'thus' => 1, 'hence' => 1, 'instead' => 1,
		'likewise' => 1, 'similarly' => 1, 'subsequently' => 1, 'ultimately' => 1, 'afterward' => 1,
		'afterwards' => 1, 'although' => 1, 'because' => 1, 'consequently' => 1, 'conversely' => 1,
		'indeed' => 1, 'notably' => 1, 'overall' => 1, 'specifically' => 1, 'undoubtedly' => 1, 'whereas' => 1,
	);

	/** Multi-word transition phrases. */
	const TRANSITION_PHRASES = array(
		'as well as', 'in order to', 'in addition', 'for example', 'for instance', 'in contrast',
		'on the other hand', 'as a result', 'in conclusion', 'in fact', 'in other words', 'such as',
		'in particular', 'at the same time', 'due to', 'even though', 'in summary', 'to summarize',
		'as long as', 'in general', 'for this reason', 'by contrast', 'above all',
	);

	/** Stop-set ignored when comparing sentence-start words. */
	const CONSECUTIVE_STOP = array(
		'the' => 1, 'a' => 1, 'an' => 1, 'and' => 1, 'but' => 1, 'or' => 1, 'if' => 1, 'so' => 1,
		'to' => 1, 'of' => 1, 'in' => 1, 'on' => 1, 'at' => 1, 'it' => 1, 'is' => 1, 'this' => 1,
		'that' => 1, 'as' => 1, 'for' => 1, 'with' => 1,
	);
}
