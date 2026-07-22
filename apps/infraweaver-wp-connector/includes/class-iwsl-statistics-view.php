<?php
/**
 * The render layer for the gated "Site Statistics" ("Insights") dashboard — extracted
 * out of IWSL_Statistics so the engine (recording, retention, gate) and the view
 * (KPI hero, charts, drill-downs) can each stay small and be reasoned about alone.
 *
 * TRUST / PRIVACY. This class only ever RENDERS an already-computed, bounded model
 * (the IWSL_Stats_Classifier::aggregate() output). It issues no queries, opens no
 * sockets, and pulls in no external asset: every chart is hand-built inline SVG, all
 * interactivity is one inlined vanilla-JS IIFE, and the click-to-drill payload is a
 * small (~15 KB) inert `application/json` island rendered client-side — never a
 * server round-trip. Every dynamic fragment is escaped; the drawer is built with
 * createElement + textContent only, so recorded strings can never become markup.
 *
 * DEGRADATION. Nothing is visibility-gated on JavaScript. With scripting disabled the
 * full dashboard still renders and reads — only the tooltip, the compare ghost, the
 * metric toggle animation and the drill drawer quietly drop away.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Statistics_View {

	/** Primary-chart geometry (px, viewBox units). */
	const W = 760;
	const H = 260;
	const PADL = 44;
	const PADR = 16;
	const PADT = 16;
	const PADB = 30;

	/** @var array The dashboard model (aggregate() output). */
	private $data;

	/** @var int The active KPI range (1|7|30). */
	private $range;

	/** @var array|null Memoised primary-chart model. */
	private $chart = null;

	/** A modest ISO-2 → English country-name map for the flag list (falls back to the code). */
	const COUNTRY_NAMES = array(
		'US' => 'United States', 'GB' => 'United Kingdom', 'NL' => 'Netherlands', 'DE' => 'Germany',
		'FR' => 'France', 'ES' => 'Spain', 'IT' => 'Italy', 'BE' => 'Belgium', 'PT' => 'Portugal',
		'IE' => 'Ireland', 'SE' => 'Sweden', 'NO' => 'Norway', 'DK' => 'Denmark', 'FI' => 'Finland',
		'PL' => 'Poland', 'AT' => 'Austria', 'CH' => 'Switzerland', 'CZ' => 'Czechia', 'GR' => 'Greece',
		'CA' => 'Canada', 'MX' => 'Mexico', 'BR' => 'Brazil', 'AR' => 'Argentina', 'AU' => 'Australia',
		'NZ' => 'New Zealand', 'JP' => 'Japan', 'CN' => 'China', 'IN' => 'India', 'KR' => 'South Korea',
		'SG' => 'Singapore', 'ZA' => 'South Africa', 'RU' => 'Russia', 'TR' => 'Turkey', 'UA' => 'Ukraine',
		'RO' => 'Romania', 'HU' => 'Hungary', 'IL' => 'Israel', 'AE' => 'United Arab Emirates',
	);

	public function __construct( array $data, int $range ) {
		$this->data  = $data;
		$this->range = in_array( $range, array( 1, 7, 30 ), true ) ? $range : 7;
	}

	// ── entry points ─────────────────────────────────────────────────────────────

	/** The locked-state notice with the human gate reasons (no chart, no script, no island). */
	public function render_locked( array $gate ): void {
		$reasons = isset( $gate['reasons'] ) && is_array( $gate['reasons'] ) ? $gate['reasons'] : array();
		echo '<div class="notice notice-warning"><p>';
		echo self::esc_html_safe( 'Site Statistics is locked.' );
		if ( array() !== $reasons ) {
			echo ' ' . self::esc_html_safe( 'Reasons: ' . implode( ', ', array_map( 'strval', $reasons ) ) );
		}
		echo '</p></div>';
	}

	/** The full dashboard: styles → header → KPI hero → primary chart → zones → feed → housekeeping → drawer → island → script. */
	public function render(): void {
		echo '<div class="iwsl-stats">';
		$this->render_styles();
		echo '<h2 class="iwsl-stats__title">' . self::esc_html_safe( 'Site Statistics' ) . '</h2>';

		$this->render_header();
		$this->render_kpi_strip();
		$this->render_main_chart();

		$this->render_acquisition_zone();
		$this->render_content_zone();
		$this->render_audience_zone();
		$this->render_feed();

		echo '<details class="iwsl-adv"><summary>' . self::esc_html_safe( 'Advanced settings' ) . '</summary><div class="iwsl-adv__body">';
		$this->render_reset_form();
		echo '</div></details>';

		$this->render_drawer_shell();
		$this->render_json_island();
		$this->render_scripts();
		echo '</div>';
	}

	// ── header: privacy line, range control, compare toggle ──────────────────────

	private function render_header(): void {
		$lock = '<svg class="iwsl-stats__lock" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">'
			. '<rect x="4" y="10" width="16" height="10" rx="2" fill="currentColor" opacity="0.85"/>'
			. '<path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
		echo '<p class="iwsl-stats__privacy">' . $lock . ' ' . self::esc_html_safe(
			'Counting ~100% of visitors — no cookies, no fingerprints stored, ad-blocker-proof, and nothing ever leaves your server.'
		) . '</p>';

		echo '<div class="iwsl-stats__controls">';
		$this->render_range_control();
		$model    = $this->chart_model();
		$disabled = empty( $model['has_prev'] );
		echo '<button type="button" class="iwsl-stats__compare" aria-pressed="false" hidden'
			. ( $disabled ? ' disabled title="' . self::esc_attr_safe( 'No earlier data to compare yet' ) . '"' : '' )
			. '>' . self::esc_html_safe( 'Compare' ) . '</button>';
		echo '</div>';
	}

	/** The date-range switch (Today / 7d / 30d) — gated, escaped GET links, segmented pill. */
	private function render_range_control(): void {
		$base = $this->page_base_url();
		echo '<div class="iwsl-stats__ranges" role="group" aria-label="' . self::esc_attr_safe( 'Date range' ) . '">';
		foreach ( IWSL_Statistics::ALLOWED_RANGES as $days ) {
			$url  = self::add_query_arg_safe( $base, IWSL_Statistics::RANGE_PARAM, (string) $days );
			$on   = $days === $this->range;
			$cls  = $on ? 'iwsl-stats__range is-active' : 'iwsl-stats__range';
			$aria = $on ? ' aria-current="true"' : '';
			echo '<a class="' . self::esc_attr_safe( $cls ) . '" href="' . self::esc_url_safe( $url ) . '"' . $aria . '>'
				. self::esc_html_safe( self::range_label( $days ) ) . '</a>';
		}
		echo '</div>';
	}

	// ── KPI hero strip (one bordered container, six hairline-split cells) ─────────

	private function render_kpi_strip(): void {
		$kpi     = isset( $this->data['kpi'] ) ? $this->data['kpi'] : array();
		$quality = isset( $this->data['quality'] ) ? $this->data['quality'] : array();
		$dq      = isset( $this->data['daily_quality'] ) ? $this->data['daily_quality'] : array();
		$model   = $this->chart_model();

		$views_spark  = $this->render_spark( $model['views'], 1 );
		$visits_spark = $this->render_spark( $model['visits'], 2 );
		$ppv_series   = array();
		$bounce_series = array();
		foreach ( $dq as $d ) {
			$ppv_series[]    = (float) $d['ppv'];
			$bounce_series[] = (float) $d['bounce_pct'];
		}

		$ppv       = isset( $quality['pages_per_visit'] ) ? (float) $quality['pages_per_visit'] : 0.0;
		$prev_ppv  = isset( $quality['prev_ppv'] ) ? (float) $quality['prev_ppv'] : 0.0;
		$bounce    = isset( $quality['bounce_pct'] ) ? (float) $quality['bounce_pct'] : 0.0;
		$prev_bnc  = isset( $quality['prev_bounce_pct'] ) ? (float) $quality['prev_bounce_pct'] : 0.0;
		$prev_ppv_avail = isset( $quality['prev_ppv'] ) && $prev_ppv > 0;
		$prev_bnc_avail = isset( $quality['prev_bounce_pct'] ) && $prev_bnc > 0;

		echo '<div class="iwsl-stats__kpis" role="group" aria-label="' . self::esc_attr_safe( 'Key metrics' ) . '">';

		// 1 + 2 are the chart metric selector.
		echo '<div class="iwsl-stats__metricgroup" role="group" aria-label="' . self::esc_attr_safe( 'Chart metric' ) . '">';
		$this->render_metric_tile( 'Views', (int) ( $kpi['views'] ?? 0 ), $views_spark, isset( $kpi['views_delta_pct'] ) ? $kpi['views_delta_pct'] : null, 'views', true );
		$this->render_metric_tile( 'Unique visits', (int) ( $kpi['visits'] ?? 0 ), $visits_spark, isset( $kpi['visits_delta_pct'] ) ? $kpi['visits_delta_pct'] : null, 'visits', false );
		echo '</div>';

		// 3 Pages/visit.
		$ppv_delta = $prev_ppv_avail ? round( ( ( $ppv - $prev_ppv ) / $prev_ppv ) * 100, 1 ) : null;
		echo '<div class="iwsl-stats__kpi">';
		echo '<div class="iwsl-stats__kpi-label">' . self::esc_html_safe( 'Pages / visit' ) . '</div>';
		echo '<div class="iwsl-stats__kpi-value">' . self::esc_html_safe( self::num_f( $ppv ) ) . '</div>';
		echo $this->render_spark( $ppv_series, 1 );
		echo $this->delta_html( $ppv_delta, false, '%' );
		echo '</div>';

		// 4 Bounce rate — INVERTED: a falling bounce is GOOD, so colour tracks the
		// direction (down → --iwsl-good) while the arrow always shows the change sign.
		$bnc_delta = $prev_bnc_avail ? round( $bounce - $prev_bnc, 1 ) : null;
		echo '<div class="iwsl-stats__kpi">';
		echo '<div class="iwsl-stats__kpi-label">' . self::esc_html_safe( 'Bounce rate' ) . '</div>';
		echo '<div class="iwsl-stats__kpi-value">' . self::esc_html_safe( self::num_f( $bounce ) . '%' ) . '</div>';
		echo $this->render_spark( $bounce_series, 6 );
		echo $this->delta_html( $bnc_delta, true, ' pt' );
		echo '</div>';

		// 5 Views today.
		echo '<div class="iwsl-stats__kpi">';
		echo '<div class="iwsl-stats__kpi-label">' . self::esc_html_safe( 'Views today' ) . '</div>';
		echo '<div class="iwsl-stats__kpi-value">' . self::esc_html_safe( self::num( (int) ( $kpi['views_today'] ?? 0 ) ) ) . '</div>';
		echo '<div class="iwsl-stats__delta is-flat">&nbsp;</div>';
		echo '</div>';

		// 6 Online now — live dot, title = last 5 min.
		echo '<div class="iwsl-stats__kpi" title="' . self::esc_attr_safe( 'last 5 min' ) . '">';
		echo '<div class="iwsl-stats__kpi-label">' . self::esc_html_safe( 'Online now' ) . '</div>';
		echo '<div class="iwsl-stats__kpi-value"><span class="iwsl-stats__dot" aria-hidden="true"></span>' . self::esc_html_safe( self::num( (int) ( $kpi['online_now'] ?? 0 ) ) ) . '</div>';
		echo '<div class="iwsl-stats__delta is-flat">&nbsp;</div>';
		echo '</div>';

		echo '</div>';
	}

	/** One metric tile — a real <button> so the chart metric can be toggled; inert without JS. */
	private function render_metric_tile( string $label, int $value, string $spark, ?float $delta, string $metric, bool $pressed ): void {
		echo '<button type="button" class="iwsl-stats__kpi iwsl-stats__tile is-metric" data-metric="' . self::esc_attr_safe( $metric ) . '" aria-pressed="' . ( $pressed ? 'true' : 'false' ) . '">';
		echo '<div class="iwsl-stats__kpi-label">' . self::esc_html_safe( $label ) . '</div>';
		echo '<div class="iwsl-stats__kpi-value">' . self::esc_html_safe( self::num( $value ) ) . '</div>';
		echo $spark;
		echo $this->delta_html( $delta, false, '%' );
		echo '</button>';
	}

	/** An accessible up/down delta (arrow glyph + sign, never colour-only). */
	private function delta_html( ?float $delta, bool $good_when_down, string $unit ): string {
		if ( null === $delta ) {
			return '<div class="iwsl-stats__delta is-flat">&nbsp;</div>';
		}
		$down  = $delta < 0;
		$arrow = $down ? '▼' : '▲';
		$good  = $good_when_down ? $down : ! $down;
		$cls   = 0.0 === (float) $delta ? 'is-flat' : ( $good ? 'is-up' : 'is-down' );
		$sign  = $delta > 0 ? '+' : ( $delta < 0 ? '−' : '' );
		$text  = $sign . self::num_f( abs( $delta ) ) . $unit;
		return '<div class="iwsl-stats__delta ' . $cls . '"><span aria-hidden="true">' . $arrow . '</span> '
			. self::esc_html_safe( $text ) . '</div>';
	}

	/** One sparkline (viewBox 100×28, semantic-coloured polyline + endpoint dot, decorative). */
	private function render_spark( array $values, int $slot ): string {
		$n = count( $values );
		if ( $n < 2 ) {
			return '<svg class="iwsl-stats__spark" viewBox="0 0 100 28" aria-hidden="true"></svg>';
		}
		$min = min( $values );
		$max = max( $values );
		$rng = $max - $min;
		if ( $rng <= 0 ) {
			$rng = 1;
		}
		$pts  = array();
		$last = array( 0.0, 27.0 );
		foreach ( $values as $i => $v ) {
			$x      = ( $i / ( $n - 1 ) ) * 100;
			$y      = 27 - ( ( $v - $min ) / $rng ) * 26;
			$pts[]  = self::coord( $x ) . ',' . self::coord( $y );
			$last   = array( $x, $y );
		}
		$color = 'var(--iwsl-series-' . (int) $slot . ')';
		$svg   = '<svg class="iwsl-stats__spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">';
		$svg  .= '<polyline points="' . self::esc_attr_safe( implode( ' ', $pts ) ) . '" fill="none" stroke="' . $color . '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
		$svg  .= '<circle cx="' . self::coord( $last[0] ) . '" cy="' . self::coord( $last[1] ) . '" r="2.5" fill="' . $color . '"/>';
		$svg  .= '</svg>';
		return $svg;
	}

	// ── primary chart (dual-metric, PHP-precomputed geometry) ────────────────────

	/** Build (and memoise) the primary-chart model: series, ghost, labels, ticks, geometry. */
	private function chart_model(): array {
		if ( null !== $this->chart ) {
			return $this->chart;
		}
		$views = array();
		$visits = array();
		$labels = array();
		$days   = array();
		$pviews = array();
		$pvisits = array();

		if ( 1 === $this->range ) {
			foreach ( ( $this->data['hourly'] ?? array() ) as $h ) {
				$views[]  = (int) $h['views'];
				$visits[] = (int) $h['visits'];
				$labels[] = sprintf( '%02d:00', (int) $h['hour'] );
			}
			foreach ( ( $this->data['hourly_prev'] ?? array() ) as $h ) {
				$pviews[]  = (int) $h['views'];
				$pvisits[] = (int) $h['visits'];
			}
		} else {
			$series = $this->data['series'] ?? array();
			$total  = count( $series );
			$take   = min( $this->range, $total );
			$cur    = array_slice( $series, $total - $take );
			foreach ( $cur as $s ) {
				$views[]  = (int) $s['views'];
				$visits[] = (int) $s['visits'];
				$labels[] = self::short_day( (string) $s['day'] );
				$days[]   = (string) $s['day'];
			}
			if ( $total - ( 2 * $take ) >= 0 ) {
				foreach ( array_slice( $series, $total - ( 2 * $take ), $take ) as $s ) {
					$pviews[]  = (int) $s['views'];
					$pvisits[] = (int) $s['visits'];
				}
			}
		}

		$n        = count( $views );
		$has_prev = count( $pviews ) === $n && $n > 0 && ( array_sum( $pviews ) + array_sum( $pvisits ) ) > 0;
		if ( ! $has_prev ) {
			$pviews  = array();
			$pvisits = array();
		}

		$max = 1;
		foreach ( array_merge( $views, $visits, $pviews, $pvisits ) as $v ) {
			$max = max( $max, (int) $v );
		}
		$nice = self::nice_max( $max );

		$iw   = self::W - self::PADL - self::PADR;
		$ih   = self::H - self::PADT - self::PADB;
		$step = $n > 1 ? $iw / ( $n - 1 ) : 0;

		$ticks = array( 0, $n - 1 );
		if ( 1 === $this->range ) {
			for ( $i = 0; $i < $n; $i++ ) {
				if ( 0 === $i % 6 ) {
					$ticks[] = $i;
				}
			}
		} else {
			$mondays = array();
			foreach ( $days as $i => $ymd ) {
				$dt = DateTimeImmutable::createFromFormat( '!Y-m-d', $ymd );
				if ( $dt instanceof DateTimeImmutable && 1 === (int) $dt->format( 'N' ) ) {
					$mondays[] = $i;
				}
			}
			if ( count( $mondays ) > 5 ) {
				$alt = array();
				foreach ( $mondays as $k => $mi ) {
					if ( 0 === $k % 2 ) {
						$alt[] = $mi;
					}
				}
				$mondays = $alt;
			}
			$ticks = array_merge( $ticks, $mondays );
		}
		$ticks = array_values( array_unique( array_filter( $ticks, static function ( $i ) use ( $n ) {
			return $i >= 0 && $i < $n;
		} ) ) );
		sort( $ticks );

		$this->chart = array(
			'n'        => $n,
			'views'    => $views,
			'visits'   => $visits,
			'pviews'   => $pviews,
			'pvisits'  => $pvisits,
			'labels'   => $labels,
			'ticks'    => $ticks,
			'has_prev' => $has_prev,
			'max'      => $nice,
			'geo'      => array( 'w' => self::W, 'h' => self::H, 'padl' => self::PADL, 'padt' => self::PADT, 'iw' => $iw, 'ih' => $ih, 'step' => $step, 'max' => $nice, 'n' => $n ),
		);
		return $this->chart;
	}

	private function render_main_chart(): void {
		$m   = $this->chart_model();
		$geo = $m['geo'];
		$n   = $m['n'];

		$title = 30 === $this->range ? 'Views & unique visits — last 30 days'
			: ( 1 === $this->range ? 'Views & unique visits — today, by hour' : 'Views & unique visits — last 7 days' );
		$updated = 'Updated ' . self::format_hm( (int) ( $this->data['generated'] ?? 0 ) );

		echo '<div class="iwsl-stats__card iwsl-stats__main">';
		echo '<div class="iwsl-stats__main-head"><h3 class="iwsl-stats__card-title">' . self::esc_html_safe( $title ) . '</h3>';
		echo '<span class="iwsl-stats__updated">' . self::esc_html_safe( $updated ) . '</span></div>';

		if ( 0 === $n || array_sum( $m['views'] ) + array_sum( $m['visits'] ) === 0 ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe(
				0 === $n ? 'Nothing recorded yet. Come back after your first visitor — collection starts the moment the plugin is active.'
					: 'No views in this period.'
			) . '</p></div>';
			return;
		}

		$first = isset( $m['labels'][0] ) ? $m['labels'][0] : '';
		$lastl = isset( $m['labels'][ $n - 1 ] ) ? $m['labels'][ $n - 1 ] : '';
		$peak  = $m['max'];

		$area_views  = self::area_path( $m['views'], $geo );
		$area_visits = self::area_path( $m['visits'], $geo );
		$line_views  = self::points_str( $m['views'], $geo );
		$line_visits = self::points_str( $m['visits'], $geo );

		echo '<div class="iwsl-stats__chartwrap">';
		echo '<svg class="iwsl-svg iwsl-svg--main" data-iwsl-chart viewBox="0 0 ' . self::W . ' ' . self::H . '" '
			. 'data-area-views="' . self::esc_attr_safe( $area_views ) . '" data-area-visits="' . self::esc_attr_safe( $area_visits ) . '" '
			. 'role="img" tabindex="0" aria-label="' . self::esc_attr_safe( 'Views and unique visits, ' . $first . '–' . $lastl . ', peak ' . self::num( $peak ) . ' views' ) . '">';
		echo '<title>' . self::esc_html_safe( $title ) . '</title>';

		// gridlines + y ticks + baseline.
		echo '<g class="iwsl-svg__gridlines">';
		for ( $q = 0; $q <= 4; $q++ ) {
			$val = (int) round( $peak * ( $q / 4 ) );
			$y   = $geo['padt'] + $geo['ih'] - ( $q / 4 ) * $geo['ih'];
			$cls = 4 === $q ? 'iwsl-svg__grid' : ( 0 === $q ? 'iwsl-svg__axis' : 'iwsl-svg__grid' );
			echo '<line x1="' . self::coord( $geo['padl'] ) . '" y1="' . self::coord( $y ) . '" x2="' . self::coord( $geo['padl'] + $geo['iw'] ) . '" y2="' . self::coord( $y ) . '" class="' . $cls . '"/>';
			echo '<text x="' . self::coord( $geo['padl'] - 8 ) . '" y="' . self::coord( $y + 4 ) . '" text-anchor="end" class="iwsl-svg__tick">' . self::esc_html_safe( self::num( $val ) ) . '</text>';
		}
		echo '</g>';

		// compare ghosts (prev period), hidden until Compare is toggled.
		echo '<g class="iwsl-svg__ghosts" hidden>';
		if ( $m['has_prev'] ) {
			echo '<polyline points="' . self::esc_attr_safe( self::points_str( $m['pviews'], $geo ) ) . '" class="iwsl-svg__ghost is-views" fill="none" stroke-dasharray="4 4"/>';
			echo '<polyline points="' . self::esc_attr_safe( self::points_str( $m['pvisits'], $geo ) ) . '" class="iwsl-svg__ghost is-visits" fill="none" stroke-dasharray="4 4"/>';
		}
		echo '</g>';

		// area of the emphasised metric (Views by default), then both lines.
		echo '<path d="' . self::esc_attr_safe( $area_views ) . '" class="iwsl-svg__area is-views"/>';
		echo '<polyline points="' . self::esc_attr_safe( $line_views ) . '" class="iwsl-svg__line is-views" fill="none"/>';
		echo '<polyline points="' . self::esc_attr_safe( $line_visits ) . '" class="iwsl-svg__line is-visits is-dim" fill="none"/>';

		// endpoint dot+value for each metric (Views shown by default).
		echo $this->endpoint_svg( $m['views'], $geo, 'is-views', false );
		echo $this->endpoint_svg( $m['visits'], $geo, 'is-visits', true );

		// crosshair (JS-driven), x labels, then the transparent hit target.
		echo '<g class="iwsl-svg__cursor" hidden>';
		echo '<line class="iwsl-svg__cursorline" x1="0" y1="' . self::coord( $geo['padt'] ) . '" x2="0" y2="' . self::coord( $geo['padt'] + $geo['ih'] ) . '"/>';
		echo '<circle class="iwsl-svg__cursordot is-views" r="3.5"/><circle class="iwsl-svg__cursordot is-visits" r="3.5"/>';
		echo '</g>';

		echo '<g class="iwsl-svg__xlabels">';
		foreach ( $m['ticks'] as $i ) {
			$x      = $geo['padl'] + $geo['step'] * $i;
			$anchor = 0 === $i ? 'start' : ( $i === $n - 1 ? 'end' : 'middle' );
			echo '<text x="' . self::coord( $x ) . '" y="' . self::coord( self::H - 8 ) . '" text-anchor="' . $anchor . '" class="iwsl-svg__tick">' . self::esc_html_safe( (string) $m['labels'][ $i ] ) . '</text>';
		}
		echo '</g>';

		echo '<rect class="iwsl-svg__hit" x="' . self::coord( $geo['padl'] ) . '" y="' . self::coord( $geo['padt'] ) . '" width="' . self::coord( $geo['iw'] ) . '" height="' . self::coord( $geo['ih'] ) . '" fill="transparent"/>';
		echo '</svg>';
		echo '<div class="iwsl-stats__tooltip" role="presentation" aria-hidden="true" hidden></div>';
		echo '<p class="iwsl-stats__sr" aria-live="polite"></p>';
		echo '<p class="iwsl-stats__compare-cap" hidden>' . self::esc_html_safe( 'vs. previous period' ) . '</p>';
		echo '</div></div>';
	}

	/** The endpoint dot + value label for a metric's last point. */
	private function endpoint_svg( array $vals, array $geo, string $cls, bool $hidden ): string {
		$n = count( $vals );
		if ( 0 === $n ) {
			return '';
		}
		$v = (int) $vals[ $n - 1 ];
		$x = $geo['padl'] + $geo['step'] * ( $n - 1 );
		$y = $geo['padt'] + $geo['ih'] - ( $geo['max'] > 0 ? ( $v / $geo['max'] ) * $geo['ih'] : 0 );
		$g = '<g class="iwsl-svg__end ' . $cls . '"' . ( $hidden ? ' hidden' : '' ) . '>';
		$g .= '<circle cx="' . self::coord( $x ) . '" cy="' . self::coord( $y ) . '" r="3.5"/>';
		$g .= '<text x="' . self::coord( $x - 6 ) . '" y="' . self::coord( $y - 8 ) . '" text-anchor="end" class="iwsl-svg__endlabel">' . self::esc_html_safe( self::num( $v ) ) . '</text></g>';
		return $g;
	}

	// ── zones ────────────────────────────────────────────────────────────────────

	private function render_acquisition_zone(): void {
		echo '<h3 class="iwsl-stats__zone-title">' . self::esc_html_safe( 'Acquisition' ) . '</h3><hr class="iwsl-stats__rule"/>';
		echo '<div class="iwsl-stats__zone">';
		$this->render_donut_card(
			'Channels',
			isset( $this->data['channels'] ) ? $this->data['channels'] : array(),
			array( 'Direct' => 5, 'Search' => 3, 'Referral' => 2, 'Social' => 4 ),
			'channel',
			'visits',
			'iwsl-col-5',
			'No visits yet in this period.'
		);
		$this->render_list_card( 'Top referrers', $this->data['top_referrers'] ?? array(), 2, 'referrer', array( 'col' => 'iwsl-col-7', 'empty' => 'No referrals yet in this period.' ) );
		$this->render_list_card( 'Search engines', $this->data['search_engines'] ?? array(), 3, null, array( 'col' => 'iwsl-col-6', 'empty' => 'No search-engine visits yet.' ) );
		$this->render_list_card( 'On-site searches', $this->data['searches'] ?? array(), 3, null, array( 'col' => 'iwsl-col-6', 'empty' => 'No on-site searches yet.' ) );
		echo '</div>';
	}

	private function render_content_zone(): void {
		echo '<h3 class="iwsl-stats__zone-title">' . self::esc_html_safe( 'Content' ) . '</h3><hr class="iwsl-stats__rule"/>';
		echo '<div class="iwsl-stats__zone">';
		$this->render_list_card( 'Top pages', $this->data['top_pages'] ?? array(), 1, 'page', array( 'col' => 'iwsl-col-6', 'empty' => 'No page views yet in this period.' ) );
		$this->render_list_card( 'Entry pages', $this->data['entries'] ?? array(), 1, null, array( 'col' => 'iwsl-col-3', 'empty' => 'No entry pages yet.' ) );
		$this->render_list_card( 'Exit pages', $this->data['exits'] ?? array(), 1, null, array( 'col' => 'iwsl-col-3', 'empty' => 'No exit pages yet.' ) );
		echo '</div>';
	}

	private function render_audience_zone(): void {
		echo '<h3 class="iwsl-stats__zone-title">' . self::esc_html_safe( 'Audience' ) . '</h3><hr class="iwsl-stats__rule"/>';
		echo '<div class="iwsl-stats__zone">';
		$this->render_donut_card(
			'Devices',
			isset( $this->data['devices'] ) ? $this->data['devices'] : array(),
			array( 'desktop' => 5, 'mobile' => 2, 'tablet' => 3, 'other' => 6 ),
			null,
			'views',
			'iwsl-col-4',
			'No device data yet.'
		);
		$this->render_list_card( 'Browsers', $this->data['browsers'] ?? array(), 2, null, array( 'col' => 'iwsl-col-4', 'empty' => 'No browser data yet.' ) );
		$this->render_list_card( 'Operating systems', $this->data['os'] ?? array(), 3, null, array( 'col' => 'iwsl-col-4', 'empty' => 'No OS data yet.' ) );
		$this->render_list_card( 'Countries', $this->data['countries'] ?? array(), 2, 'country', array( 'col' => 'iwsl-col-5', 'empty' => 'No country data yet.', 'flag' => true ) );
		$this->render_heatmap_card( 'iwsl-col-7' );
		echo '</div>';
	}

	// ── donut ────────────────────────────────────────────────────────────────────

	/**
	 * A stroked-circle donut (no path math) with a labelled legend. Segments are the
	 * top 4 rows + an "Other" bucket; each legend row carries a count + share, and (for
	 * a drillable dim) is itself a drill button.
	 */
	private function render_donut_card( string $title, array $rows, array $color_map, ?string $drill_dim, string $cap, string $col, string $empty ): void {
		echo '<div class="iwsl-stats__card ' . self::esc_attr_safe( $col ) . '">';
		echo '<h3 class="iwsl-stats__card-title">' . self::esc_html_safe( $title ) . '</h3>';
		if ( array() === $rows ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( $empty ) . '</p></div>';
			return;
		}

		$total = 0;
		foreach ( $rows as $r ) {
			$total += (int) $r['count'];
		}
		$total = max( 1, $total );

		// Fold to ≤4 named + Other.
		$segments = array();
		$idx      = 0;
		$other    = 0;
		foreach ( $rows as $r ) {
			if ( $idx < 4 ) {
				$segments[] = array( 'label' => (string) $r['label'], 'count' => (int) $r['count'] );
			} else {
				$other += (int) $r['count'];
			}
			$idx++;
		}
		if ( $other > 0 ) {
			$segments[] = array( 'label' => 'Other', 'count' => $other );
		}

		$circ  = 2 * M_PI * 52;
		$cum   = 0.0;
		$aria  = array();
		$arcs  = '';
		foreach ( $segments as $seg ) {
			$frac   = $seg['count'] / $total;
			$len    = max( 0.0, ( $frac * $circ ) - 2 );
			$color  = $this->donut_color( $seg['label'], $color_map );
			$arcs  .= '<circle cx="70" cy="70" r="52" fill="none" stroke="' . $color . '" stroke-width="22" '
				. 'stroke-dasharray="' . self::coord( $len ) . ' ' . self::coord( $circ - $len ) . '" '
				. 'stroke-dashoffset="' . self::coord( -$cum ) . '" transform="rotate(-90 70 70)" data-seg="' . self::esc_attr_safe( strtolower( $seg['label'] ) ) . '"><title>' . self::esc_html_safe( $seg['label'] . ': ' . self::num( $seg['count'] ) ) . '</title></circle>';
			$cum   += $frac * $circ;
			$aria[] = $seg['label'] . ' ' . self::num_f( round( $frac * 100, 1 ) ) . '%';
		}

		echo '<div class="iwsl-donut-wrap">';
		echo '<svg class="iwsl-donut" viewBox="0 0 140 140" role="img" aria-label="' . self::esc_attr_safe( $title . ': ' . implode( ', ', $aria ) ) . '">';
		echo '<circle class="iwsl-donut__track" cx="70" cy="70" r="52" fill="none" stroke="var(--iwsl-line)" stroke-width="22"/>';
		echo $arcs;
		echo '<text x="70" y="66" text-anchor="middle" class="iwsl-donut__num">' . self::esc_html_safe( self::num( $total ) ) . '</text>';
		echo '<text x="70" y="84" text-anchor="middle" class="iwsl-donut__cap">' . self::esc_html_safe( $cap ) . '</text>';
		echo '</svg>';

		echo '<ul class="iwsl-donut__legend">';
		foreach ( $segments as $seg ) {
			$share = self::num_f( round( ( $seg['count'] / $total ) * 100, 1 ) ) . '%';
			$color = $this->donut_color( $seg['label'], $color_map );
			$chip  = '<span class="iwsl-donut__chip" style="background:' . $color . '" aria-hidden="true"></span>';
			$body  = $chip . '<span class="iwsl-donut__leglabel">' . self::esc_html_safe( $seg['label'] ) . '</span>'
				. '<span class="iwsl-donut__legcount">' . self::esc_html_safe( self::num( $seg['count'] ) ) . '</span>'
				. '<span class="iwsl-donut__legpct">' . self::esc_html_safe( $share ) . '</span>';
			if ( null !== $drill_dim && 'Other' !== $seg['label'] ) {
				$key = strtolower( $seg['label'] );
				echo '<li class="iwsl-donut__legrow"><button type="button" class="iwsl-donut__legbtn iwsl-list__btn" data-dim="' . self::esc_attr_safe( $drill_dim ) . '" data-key="' . self::esc_attr_safe( $key ) . '" data-seg="' . self::esc_attr_safe( $key ) . '" aria-haspopup="dialog" aria-label="' . self::esc_attr_safe( 'View details for ' . $seg['label'] ) . '">' . $body . '<span class="iwsl-list__chev" aria-hidden="true">›</span></button></li>';
			} else {
				echo '<li class="iwsl-donut__legrow"><div class="iwsl-donut__legbtn" data-seg="' . self::esc_attr_safe( strtolower( $seg['label'] ) ) . '">' . $body . '</div></li>';
			}
		}
		echo '</ul>';
		echo '</div></div>';
	}

	/** Resolve a donut segment's colour from the fixed dimension→slot map (Other is muted). */
	private function donut_color( string $label, array $map ): string {
		if ( 'Other' === $label ) {
			return 'var(--iwsl-muted)';
		}
		$key = isset( $map[ $label ] ) ? $label : strtolower( $label );
		if ( isset( $map[ $key ] ) ) {
			return 'var(--iwsl-series-' . (int) $map[ $key ] . ')';
		}
		return 'var(--iwsl-series-1)';
	}

	// ── list card (mini-bars, optional drill, optional flags) ────────────────────

	/**
	 * The unified ranked-list card (top pages/referrers/search engines/browsers/OS/
	 * countries/entry/exit/searches). Drillable dims render each row as a <button>;
	 * non-drillable dims render an identical <div> row (no affordance lie).
	 */
	private function render_list_card( string $title, array $rows, int $slot, ?string $drill_dim, array $opts = array() ): void {
		$col   = isset( $opts['col'] ) ? $opts['col'] : 'iwsl-col-6';
		$empty = isset( $opts['empty'] ) ? $opts['empty'] : 'No data yet in this period.';
		$flag  = ! empty( $opts['flag'] );

		echo '<div class="iwsl-stats__card ' . self::esc_attr_safe( $col ) . '">';
		echo '<h3 class="iwsl-stats__card-title">' . self::esc_html_safe( $title ) . '</h3>';
		if ( array() === $rows ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( $empty ) . '</p></div>';
			return;
		}

		$cmax = 1;
		$sum  = 0;
		foreach ( $rows as $r ) {
			$cmax = max( $cmax, (int) $r['count'] );
			$sum += (int) $r['count'];
		}
		$sum = max( 1, $sum );

		echo '<ol class="iwsl-list">';
		foreach ( $rows as $r ) {
			$label = (string) $r['label'];
			$count = (int) $r['count'];
			$width = self::coord( ( $count / $cmax ) * 100 );
			$share = self::num_f( round( ( $count / $sum ) * 100, 1 ) ) . '%';

			$display = $label;
			$muted   = '';
			if ( $flag ) {
				if ( 'Unknown' === $label ) {
					$muted   = ' is-muted';
					$display = 'Unknown';
				} else {
					$flg     = self::country_flag( $label );
					$name    = isset( self::COUNTRY_NAMES[ $label ] ) ? self::COUNTRY_NAMES[ $label ] : $label;
					$display = ( '' !== $flg ? $flg . ' ' : '' ) . $name;
				}
			}

			$fill = '<span class="iwsl-list__fill is-s' . (int) $slot . '" style="inset-inline-start:0;width:' . $width . '%"></span>';
			$body = $fill
				. '<span class="iwsl-list__label' . $muted . '" title="' . self::esc_attr_safe( $label ) . '">' . self::esc_html_safe( self::truncate( $display, 42 ) ) . '</span>'
				. '<span class="iwsl-list__count">' . self::esc_html_safe( self::num( $count ) ) . '</span>'
				. '<span class="iwsl-list__pct">' . self::esc_html_safe( $share ) . '</span>';

			if ( null !== $drill_dim ) {
				echo '<li class="iwsl-list__row"><button type="button" class="iwsl-list__btn" data-dim="' . self::esc_attr_safe( $drill_dim ) . '" data-key="' . self::esc_attr_safe( $label ) . '" aria-haspopup="dialog" aria-label="' . self::esc_attr_safe( 'View details for ' . $label ) . '">' . $body . '<span class="iwsl-list__chev" aria-hidden="true">›</span></button></li>';
			} else {
				echo '<li class="iwsl-list__row"><div class="iwsl-list__btn is-static">' . $body . '</div></li>';
			}
		}
		echo '</ol></div>';
	}

	// ── heatmap ──────────────────────────────────────────────────────────────────

	private function render_heatmap_card( string $col ): void {
		$grid    = isset( $this->data['heatmap'] ) ? $this->data['heatmap'] : array();
		$summary = isset( $this->data['heat_summary'] ) ? (string) $this->data['heat_summary'] : '';
		$days    = array( 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su' );
		$daylong = array( 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday' );

		echo '<div class="iwsl-stats__card ' . self::esc_attr_safe( $col ) . '">';
		echo '<h3 class="iwsl-stats__card-title">' . self::esc_html_safe( 'Activity by hour' ) . '</h3>';

		$nonzero = array();
		for ( $d = 0; $d < 7; $d++ ) {
			for ( $h = 0; $h < 24; $h++ ) {
				$v = isset( $grid[ $d ][ $h ] ) ? (int) $grid[ $d ][ $h ] : 0;
				if ( $v > 0 ) {
					$nonzero[] = $v;
				}
			}
		}
		if ( array() === $nonzero ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( 'No activity recorded yet.' ) . '</p></div>';
			return;
		}
		sort( $nonzero );

		$vb_w = 34 + 24 * 24;
		$vb_h = 18 + 7 * 18;
		echo '<div class="iwsl-heat-scroll">';
		echo '<svg class="iwsl-heat-svg" viewBox="0 0 ' . $vb_w . ' ' . $vb_h . '" role="img" aria-label="' . self::esc_attr_safe( $summary ) . '">';
		// hour gutter (0/6/12/18).
		foreach ( array( 0, 6, 12, 18 ) as $hh ) {
			echo '<text x="' . ( 34 + $hh * 24 + 11 ) . '" y="12" text-anchor="middle" class="iwsl-heat__hlabel">' . self::esc_html_safe( (string) $hh ) . '</text>';
		}
		for ( $d = 0; $d < 7; $d++ ) {
			$ry = 18 + $d * 18;
			echo '<text x="0" y="' . ( $ry + 12 ) . '" class="iwsl-heat__dlabel">' . self::esc_html_safe( $days[ $d ] ) . '</text>';
			for ( $h = 0; $h < 24; $h++ ) {
				$v  = isset( $grid[ $d ][ $h ] ) ? (int) $grid[ $d ][ $h ] : 0;
				$op = self::heat_opacity( $v, $nonzero );
				$x  = 34 + $h * 24;
				if ( $v <= 0 ) {
					echo '<rect x="' . $x . '" y="' . $ry . '" width="22" height="16" rx="3" class="iwsl-heat is-zero" fill="var(--iwsl-card)"/>';
				} else {
					echo '<rect x="' . $x . '" y="' . $ry . '" width="22" height="16" rx="3" class="iwsl-heat" fill="var(--iwsl-series-1)" fill-opacity="' . self::coord( $op ) . '"><title>' . self::esc_html_safe( $daylong[ $d ] . ' ' . sprintf( '%02d:00', $h ) . ' — ' . self::num( $v ) . ' views' ) . '</title></rect>';
				}
			}
		}
		echo '</svg></div>';

		echo '<div class="iwsl-heat__legend"><span>' . self::esc_html_safe( 'less' ) . '</span>';
		foreach ( array( 0.12, 0.28, 0.48, 0.72, 1.0 ) as $op ) {
			echo '<span class="iwsl-heat__sw" style="background:var(--iwsl-series-1);opacity:' . self::coord( $op ) . '"></span>';
		}
		echo '<span>' . self::esc_html_safe( 'more' ) . '</span></div>';
		echo '<p class="iwsl-heat__summary">' . self::esc_html_safe( $summary ) . '</p>';
		echo '</div>';
	}

	/** Quantile opacity for a heatmap cell (0 handled by the caller). */
	private static function heat_opacity( int $v, array $sorted_nonzero ): float {
		if ( $v <= 0 ) {
			return 0.0;
		}
		$n = count( $sorted_nonzero );
		if ( $n < 2 ) {
			return 1.0;
		}
		$q = static function ( float $p ) use ( $sorted_nonzero, $n ): int {
			return (int) $sorted_nonzero[ (int) floor( $p * ( $n - 1 ) ) ];
		};
		$t = array( $q( 0.2 ), $q( 0.4 ), $q( 0.6 ), $q( 0.8 ) );
		if ( $v <= $t[0] ) {
			return 0.12;
		}
		if ( $v <= $t[1] ) {
			return 0.28;
		}
		if ( $v <= $t[2] ) {
			return 0.48;
		}
		if ( $v <= $t[3] ) {
			return 0.72;
		}
		return 1.0;
	}

	// ── recent-activity feed ─────────────────────────────────────────────────────

	private function render_feed(): void {
		$events = isset( $this->data['recent_events'] ) ? $this->data['recent_events'] : array();
		echo '<h3 class="iwsl-stats__zone-title">' . self::esc_html_safe( 'Recent activity' ) . '</h3><hr class="iwsl-stats__rule"/>';
		echo '<div class="iwsl-stats__card iwsl-col-12">';
		if ( array() === $events ) {
			echo '<p class="iwsl-stats__empty">' . self::esc_html_safe( 'No visitor actions recorded yet.' ) . '</p></div>';
			return;
		}
		echo '<ul class="iwsl-feed">';
		foreach ( $events as $e ) {
			list( $word, $slot ) = self::event_chip( (string) $e['type'] );
			$detail = '' !== (string) $e['label'] ? (string) $e['label'] : (string) $e['path'];
			echo '<li class="iwsl-feed__row">';
			echo '<span class="iwsl-feed__chip"><span class="iwsl-feed__dot is-s' . (int) $slot . '" aria-hidden="true"></span>' . self::esc_html_safe( $word ) . '</span>';
			echo '<span class="iwsl-feed__detail" title="' . self::esc_attr_safe( $detail ) . '">' . self::esc_html_safe( self::truncate( $detail, 70 ) ) . '</span>';
			echo '<span class="iwsl-feed__time">' . self::esc_html_safe( self::format_time( (int) $e['at'] ) ) . '</span>';
			echo '</li>';
		}
		echo '</ul></div>';
	}

	// ── drawer + island + reset ──────────────────────────────────────────────────

	private function render_drawer_shell(): void {
		echo '<div class="iwsl-drawer" hidden>';
		echo '<div class="iwsl-drawer__scrim"></div>';
		echo '<div class="iwsl-drawer__panel" role="dialog" aria-modal="true" aria-labelledby="iwsl-drawer-title" tabindex="-1">';
		echo '<span class="iwsl-drawer__sentinel" data-sentinel="first" tabindex="0"></span>';
		echo '<header class="iwsl-drawer__head"><p class="iwsl-drawer__kicker"></p><h3 id="iwsl-drawer-title"></h3>';
		echo '<button type="button" class="iwsl-drawer__close" aria-label="' . self::esc_attr_safe( 'Close' ) . '">×</button></header>';
		echo '<div class="iwsl-drawer__kpis"></div>';
		echo '<div class="iwsl-drawer__spark"></div>';
		echo '<div class="iwsl-drawer__lists"></div>';
		echo '<span class="iwsl-drawer__sentinel" data-sentinel="last" tabindex="0"></span>';
		echo '</div></div>';
	}

	private function render_json_island(): void {
		$m       = $this->chart_model();
		$island  = array(
			'range_days' => $this->range,
			'labels'     => $m['labels'],
			'series'     => array( 'views' => $m['views'], 'visits' => $m['visits'] ),
			'prev'       => $m['has_prev'] ? array( 'views' => $m['pviews'], 'visits' => $m['pvisits'] ) : null,
			'geo'        => $m['geo'],
			'drill'      => isset( $this->data['drill'] ) ? $this->data['drill'] : array(),
			'i18n'       => array(
				'views'    => 'Views',
				'visits'   => 'Unique visits',
				'share'    => 'of all views',
				'bounce'   => 'Bounce rate',
				'close'    => 'Close',
				'prev'     => 'prev',
				'page'     => 'Page',
				'referrer' => 'Referrer',
				'country'  => 'Country',
				'channel'  => 'Channel',
			),
		);
		echo '<script type="application/json" id="iwsl-stats-data">' . self::json_safe( $island ) . '</script>';
	}

	/** The gated "Reset statistics" admin-post form. */
	private function render_reset_form(): void {
		$action_url = function_exists( 'admin_url' ) ? admin_url( 'admin-post.php' ) : 'admin-post.php';
		echo '<form method="post" action="' . self::esc_url_safe( (string) $action_url ) . '" class="iwsl-stats__reset" '
			. 'onsubmit="return confirm(\'Clear all recorded statistics? This cannot be undone.\');">';
		echo '<input type="hidden" name="action" value="' . self::esc_attr_safe( IWSL_Statistics::RESET_ACTION ) . '"/>';
		if ( function_exists( 'wp_nonce_field' ) ) {
			wp_nonce_field( IWSL_Statistics::RESET_NONCE );
		}
		echo '<button type="submit" class="button button-secondary">' . self::esc_html_safe( 'Reset statistics' ) . '</button>';
		if ( function_exists( 'iwsl_field_help' ) ) {
			echo ' ' . iwsl_field_help( 'Permanently deletes all recorded visits and starts counting fresh.' );
		}
		echo '</form>';
	}

	// ── geometry helpers ─────────────────────────────────────────────────────────

	/** "Nice" upper bound: the smallest of {1,2,5}×10^k ≥ $max. */
	private static function nice_max( int $max ): int {
		if ( $max <= 0 ) {
			return 1;
		}
		$exp  = (int) floor( log10( $max ) );
		$base = 10 ** $exp;
		foreach ( array( 1, 2, 5, 10 ) as $mult ) {
			if ( $mult * $base >= $max ) {
				return (int) ( $mult * $base );
			}
		}
		return (int) ( 10 * $base );
	}

	/** A polyline "x,y x,y …" points string for a values array. */
	private static function points_str( array $vals, array $g ): string {
		$pts = array();
		foreach ( $vals as $i => $v ) {
			$x     = $g['padl'] + $g['step'] * $i;
			$y     = $g['padt'] + $g['ih'] - ( $g['max'] > 0 ? ( $v / $g['max'] ) * $g['ih'] : 0 );
			$pts[] = self::coord( $x ) . ',' . self::coord( $y );
		}
		return implode( ' ', $pts );
	}

	/** A closed area path (baseline → line → baseline) for a values array. */
	private static function area_path( array $vals, array $g ): string {
		$n = count( $vals );
		if ( 0 === $n ) {
			return '';
		}
		$base = $g['padt'] + $g['ih'];
		$xn   = $g['padl'] + $g['step'] * ( $n - 1 );
		$d    = 'M' . self::coord( $g['padl'] ) . ',' . self::coord( $base );
		foreach ( $vals as $i => $v ) {
			$x  = $g['padl'] + $g['step'] * $i;
			$y  = $g['padt'] + $g['ih'] - ( $g['max'] > 0 ? ( $v / $g['max'] ) * $g['ih'] : 0 );
			$d .= ' L' . self::coord( $x ) . ',' . self::coord( $y );
		}
		$d .= ' L' . self::coord( $xn ) . ',' . self::coord( $base ) . ' Z';
		return $d;
	}

	// ── small helpers ────────────────────────────────────────────────────────────

	/** A regional-indicator flag for a valid ISO-2 code, or '' (never an image). */
	private static function country_flag( string $code ): string {
		if ( ! preg_match( '/^[A-Z]{2}$/', $code ) || ! function_exists( 'mb_chr' ) ) {
			return '';
		}
		return mb_chr( 0x1F1E6 + ord( $code[0] ) - 65, 'UTF-8' ) . mb_chr( 0x1F1E6 + ord( $code[1] ) - 65, 'UTF-8' );
	}

	/** The (word, series slot) chip for a recent-event type. */
	private static function event_chip( string $type ): array {
		switch ( $type ) {
			case IWSL_Stats_Classifier::EVENT_SEARCH:
				return array( 'Search', 3 );
			case IWSL_Stats_Classifier::EVENT_404:
				return array( '404', 6 );
			case IWSL_Stats_Classifier::EVENT_COMMENT:
				return array( 'Comment', 2 );
			default:
				return array( 'View', 1 );
		}
	}

	private static function range_label( int $days ): string {
		return 1 === $days ? 'Today' : $days . ' days';
	}

	private static function short_day( string $ymd ): string {
		$dt = DateTimeImmutable::createFromFormat( '!Y-m-d', $ymd );
		return $dt instanceof DateTimeImmutable ? $dt->format( 'M j' ) : $ymd;
	}

	private function page_base_url(): string {
		$url = 'admin.php?page=' . IWSL_Statistics::PAGE_SLUG;
		return function_exists( 'admin_url' ) ? admin_url( $url ) : $url;
	}

	private static function add_query_arg_safe( string $url, string $key, string $value ): string {
		if ( function_exists( 'add_query_arg' ) ) {
			return (string) add_query_arg( $key, $value, $url );
		}
		$sep = false === strpos( $url, '?' ) ? '?' : '&';
		return $url . $sep . rawurlencode( $key ) . '=' . rawurlencode( $value );
	}

	/** JSON for the inert island, hardened against a `</script>` break-out; harness-safe. */
	private static function json_safe( $data ): string {
		$flags = JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
		$out   = function_exists( 'wp_json_encode' ) ? wp_json_encode( $data, $flags ) : json_encode( $data, $flags );
		return is_string( $out ) ? $out : '{}';
	}

	private static function num( int $value ): string {
		return function_exists( 'number_format_i18n' ) ? (string) number_format_i18n( $value ) : number_format( $value );
	}

	private static function num_f( float $value ): string {
		return rtrim( rtrim( number_format( $value, 1, '.', '' ), '0' ), '.' );
	}

	private static function coord( float $value ): string {
		return rtrim( rtrim( number_format( $value, 2, '.', '' ), '0' ), '.' );
	}

	private static function truncate( string $value, int $max ): string {
		if ( function_exists( 'mb_strlen' ) && function_exists( 'mb_substr' ) ) {
			return mb_strlen( $value ) <= $max ? $value : mb_substr( $value, 0, max( 0, $max - 1 ) ) . '…';
		}
		return strlen( $value ) <= $max ? $value : substr( $value, 0, max( 0, $max - 1 ) ) . '…';
	}

	private static function format_time( int $unix ): string {
		if ( $unix <= 0 ) {
			return '—';
		}
		if ( function_exists( 'wp_date' ) ) {
			$f = wp_date( 'M j, H:i', $unix );
			if ( is_string( $f ) && '' !== $f ) {
				return $f;
			}
		}
		return gmdate( 'M j, H:i', $unix );
	}

	private static function format_hm( int $unix ): string {
		if ( $unix <= 0 ) {
			return '—';
		}
		if ( function_exists( 'wp_date' ) ) {
			$f = wp_date( 'H:i', $unix );
			if ( is_string( $f ) && '' !== $f ) {
				return $f;
			}
		}
		return gmdate( 'H:i', $unix );
	}

	private static function esc_html_safe( string $value ): string {
		return function_exists( 'esc_html' ) ? esc_html( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_attr_safe( string $value ): string {
		return function_exists( 'esc_attr' ) ? esc_attr( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	private static function esc_url_safe( string $value ): string {
		return function_exists( 'esc_url' ) ? esc_url( $value ) : htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}

	// ── styles + script (self-contained, theme-aware) ────────────────────────────

	private function render_styles(): void {
		echo '<style>' . self::css() . '</style>';
	}

	private function render_scripts(): void {
		echo '<script>' . self::js() . '</script>';
	}

	/** All dashboard CSS — three theme token blocks + component rules, scoped to .iwsl-stats. */
	private static function css(): string {
		return <<<'CSS'
.iwsl-stats{--iwsl-ink:#0b0b0b;--iwsl-ink-2:#52514e;--iwsl-muted:#898781;--iwsl-line:#e1e0d9;--iwsl-axis:#c3c2b7;--iwsl-card:rgba(11,11,11,0.03);--iwsl-good:#006300;--iwsl-bad:#d03b3b;--iwsl-series-1:#2a78d6;--iwsl-series-2:#1baf7a;--iwsl-series-3:#eda100;--iwsl-series-4:#7a5bd0;--iwsl-series-5:#0f8e9d;--iwsl-series-6:#e34948;--iwsl-hover:rgba(11,11,11,0.045);--iwsl-scrim:rgba(11,11,11,0.35);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:1200px;}
@media (prefers-color-scheme:dark){.iwsl-stats{--iwsl-ink:#ffffff;--iwsl-ink-2:#c3c2b7;--iwsl-muted:#898781;--iwsl-line:#2c2c2a;--iwsl-axis:#383835;--iwsl-card:rgba(255,255,255,0.04);--iwsl-good:#0ca30c;--iwsl-bad:#e66767;--iwsl-series-1:#3987e5;--iwsl-series-2:#199e70;--iwsl-series-3:#c98500;--iwsl-series-4:#9b82ea;--iwsl-series-5:#2fb3c4;--iwsl-series-6:#e66767;--iwsl-hover:rgba(255,255,255,0.06);--iwsl-scrim:rgba(0,0,0,0.55);}}
.iwsl-shell .iwsl-stats,:root[data-theme="dark"] .iwsl-stats{--iwsl-ink:#ffffff;--iwsl-ink-2:#c3c2b7;--iwsl-line:#2c2c2a;--iwsl-axis:#383835;--iwsl-card:rgba(255,255,255,0.04);--iwsl-good:#0ca30c;--iwsl-bad:#e66767;--iwsl-series-1:#3987e5;--iwsl-series-2:#199e70;--iwsl-series-3:#c98500;--iwsl-series-4:#9b82ea;--iwsl-series-5:#2fb3c4;--iwsl-series-6:#e66767;--iwsl-hover:rgba(255,255,255,0.06);--iwsl-scrim:rgba(0,0,0,0.55);}
.iwsl-stats__title{margin:0 0 4px;color:var(--iwsl-ink);}
.iwsl-stats__privacy{display:flex;align-items:center;gap:6px;color:var(--iwsl-ink-2);font-size:14px;margin:0 0 14px;max-width:70ch;}
.iwsl-stats__lock{flex:0 0 auto;color:var(--iwsl-ink-2);}
.iwsl-stats__controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;}
.iwsl-stats__ranges{display:inline-flex;gap:2px;border:1px solid var(--iwsl-line);border-radius:8px;overflow:hidden;background:var(--iwsl-card);}
.iwsl-stats__range{padding:6px 14px;text-decoration:none;color:var(--iwsl-ink-2);font-size:13px;}
.iwsl-stats__range.is-active{background:var(--iwsl-series-1);color:#fff;font-weight:600;}
.iwsl-stats__compare{padding:6px 12px;border:1px solid var(--iwsl-line);border-radius:8px;background:var(--iwsl-card);color:var(--iwsl-ink-2);font-size:13px;cursor:pointer;}
.iwsl-stats__compare[aria-pressed="true"]{border-color:var(--iwsl-series-1);color:var(--iwsl-series-1);font-weight:600;}
.iwsl-stats__compare[disabled]{opacity:.5;cursor:not-allowed;}
.iwsl-stats__kpis{display:grid;grid-template-columns:repeat(6,1fr);border:1px solid var(--iwsl-line);border-radius:8px;background:var(--iwsl-card);margin-bottom:16px;overflow:hidden;}
.iwsl-stats__metricgroup{display:contents;}
.iwsl-stats__kpi{padding:12px 14px;border-inline-start:1px solid var(--iwsl-line);min-width:0;text-align:start;background:transparent;}
.iwsl-stats__kpis>.iwsl-stats__kpi:first-child,.iwsl-stats__metricgroup>.iwsl-stats__kpi:first-child{border-inline-start:0;}
.iwsl-stats__kpi.is-metric{border:0;border-inline-start:1px solid var(--iwsl-line);font:inherit;cursor:pointer;color:inherit;}
.iwsl-stats__kpi.is-metric:hover{background:var(--iwsl-hover);}
.iwsl-stats__kpi.is-metric[aria-pressed="true"]{box-shadow:inset 0 -3px 0 var(--iwsl-series-1);}
.iwsl-stats__kpi.is-metric[data-metric="visits"][aria-pressed="true"]{box-shadow:inset 0 -3px 0 var(--iwsl-series-2);}
.iwsl-stats__kpi-label{color:var(--iwsl-ink-2);font-size:12px;font-weight:500;}
.iwsl-stats__kpi-value{color:var(--iwsl-ink);font-size:28px;font-weight:700;line-height:1.1;margin-top:2px;font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:6px;}
.iwsl-stats__spark{width:100%;height:24px;display:block;margin:4px 0 2px;overflow:visible;}
.iwsl-stats__delta{font-size:12px;color:var(--iwsl-muted);font-variant-numeric:tabular-nums;}
.iwsl-stats__delta.is-up{color:var(--iwsl-good);}
.iwsl-stats__delta.is-down{color:var(--iwsl-bad);}
.iwsl-stats__dot{width:7px;height:7px;border-radius:50%;background:var(--iwsl-good);display:inline-block;animation:iwsl-pulse 2s ease-in-out infinite;}
@keyframes iwsl-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}
.iwsl-stats__card{background:var(--iwsl-card);border:1px solid var(--iwsl-line);border-radius:8px;padding:16px;min-width:0;}
.iwsl-stats__card-title{margin:0 0 12px;font-size:13px;font-weight:600;color:var(--iwsl-ink);}
.iwsl-stats__main{margin-bottom:8px;}
.iwsl-stats__main-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;}
.iwsl-stats__updated{color:var(--iwsl-ink-2);font-size:12px;font-variant-numeric:tabular-nums;}
.iwsl-stats__chartwrap{position:relative;overflow-x:auto;}
.iwsl-stats__tooltip{position:absolute;pointer-events:none;background:var(--iwsl-ink);color:var(--iwsl-card);padding:6px 8px;border-radius:6px;font-size:12px;line-height:1.4;z-index:5;white-space:nowrap;box-shadow:0 1px 4px var(--iwsl-scrim);}
.iwsl-shell .iwsl-stats__tooltip,:root[data-theme="dark"] .iwsl-stats__tooltip{color:#0b0b0b;}
.iwsl-stats__tooltip b{font-variant-numeric:tabular-nums;}
.iwsl-stats__sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
.iwsl-stats__compare-cap{color:var(--iwsl-ink-2);font-size:12px;margin:4px 0 0;transition:opacity .15s;}
.iwsl-stats__zone-title{margin:24px 0 0;font-size:15px;color:var(--iwsl-ink);}
.iwsl-stats__rule{border:0;border-top:1px solid var(--iwsl-line);margin:6px 0 14px;}
.iwsl-stats__zone{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-bottom:8px;}
.iwsl-col-3{grid-column:span 3;}.iwsl-col-4{grid-column:span 4;}.iwsl-col-5{grid-column:span 5;}
.iwsl-col-6{grid-column:span 6;}.iwsl-col-7{grid-column:span 7;}.iwsl-col-12{grid-column:span 12;}
.iwsl-svg{max-width:100%;display:block;}
.iwsl-svg--main{width:100%;height:auto;min-width:520px;}
.iwsl-svg__axis{stroke:var(--iwsl-axis);stroke-width:1;}
.iwsl-svg__grid{stroke:var(--iwsl-line);stroke-width:1;}
.iwsl-svg__tick{fill:var(--iwsl-ink-2);font-size:11px;font-variant-numeric:tabular-nums;}
.iwsl-svg__area.is-views{fill:var(--iwsl-series-1);opacity:.14;}
.iwsl-svg__area.is-visits{fill:var(--iwsl-series-2);opacity:.14;}
.iwsl-svg__line{stroke-width:2;stroke-linejoin:round;stroke-linecap:round;transition:opacity .15s;}
.iwsl-svg__line.is-views{stroke:var(--iwsl-series-1);}
.iwsl-svg__line.is-visits{stroke:var(--iwsl-series-2);}
.iwsl-svg__line.is-dim{opacity:.45;}
.iwsl-svg__ghost.is-views{stroke:var(--iwsl-series-1);opacity:.4;stroke-width:2;}
.iwsl-svg__ghost.is-visits{stroke:var(--iwsl-series-2);opacity:.4;stroke-width:2;}
.iwsl-svg__end.is-views circle{fill:var(--iwsl-series-1);stroke:var(--iwsl-card);stroke-width:2;}
.iwsl-svg__end.is-visits circle{fill:var(--iwsl-series-2);stroke:var(--iwsl-card);stroke-width:2;}
.iwsl-svg__endlabel{fill:var(--iwsl-ink);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;}
.iwsl-svg__cursorline{stroke:var(--iwsl-axis);stroke-width:1;stroke-dasharray:2 2;}
.iwsl-svg__cursordot.is-views{fill:var(--iwsl-series-1);}
.iwsl-svg__cursordot.is-visits{fill:var(--iwsl-series-2);}
.iwsl-svg--main:focus-visible{outline:2px solid var(--iwsl-series-1);outline-offset:2px;}
.iwsl-donut-wrap{display:flex;gap:16px;align-items:center;flex-wrap:wrap;}
.iwsl-donut{width:120px;height:120px;flex:0 0 auto;}
.iwsl-donut__track{opacity:.6;}
.iwsl-donut circle[data-seg]{transition:stroke-width .08s;}
.iwsl-donut__num{fill:var(--iwsl-ink);font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;}
.iwsl-donut__cap{fill:var(--iwsl-ink-2);font-size:10px;}
.iwsl-donut__legend{list-style:none;margin:0;padding:0;flex:1 1 160px;min-width:150px;}
.iwsl-donut__legrow{margin:0;}
.iwsl-donut__legbtn{display:flex;align-items:center;gap:8px;width:100%;padding:5px 6px;border:0;background:transparent;color:var(--iwsl-ink);font:inherit;font-size:13px;text-align:start;border-radius:5px;}
button.iwsl-donut__legbtn{cursor:pointer;}
button.iwsl-donut__legbtn:hover,button.iwsl-donut__legbtn:focus-visible{background:var(--iwsl-hover);}
.iwsl-donut__chip{width:9px;height:9px;border-radius:3px;flex:0 0 auto;}
.iwsl-donut__leglabel{flex:1 1 auto;}
.iwsl-donut__legcount{font-variant-numeric:tabular-nums;}
.iwsl-donut__legpct{color:var(--iwsl-ink-2);font-size:12px;font-variant-numeric:tabular-nums;min-width:38px;text-align:end;}
.iwsl-list{list-style:none;margin:0;padding:0;}
.iwsl-list__row{margin:0;}
.iwsl-list__btn{position:relative;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 6px;border:0;background:transparent;color:var(--iwsl-ink);font:inherit;font-size:13px;text-align:start;border-radius:5px;overflow:hidden;}
button.iwsl-list__btn{cursor:pointer;}
button.iwsl-list__btn:hover,button.iwsl-list__btn:focus-visible{background:var(--iwsl-hover);}
.iwsl-list__fill{position:absolute;top:3px;bottom:3px;border-radius:4px;z-index:0;}
.iwsl-list__fill.is-s1{background:var(--iwsl-series-1);opacity:.14;}
.iwsl-list__fill.is-s2{background:var(--iwsl-series-2);opacity:.14;}
.iwsl-list__fill.is-s3{background:var(--iwsl-series-3);opacity:.14;}
.iwsl-list__fill.is-s4{background:var(--iwsl-series-4);opacity:.14;}
.iwsl-list__fill.is-s5{background:var(--iwsl-series-5);opacity:.14;}
.iwsl-list__fill.is-s6{background:var(--iwsl-series-6);opacity:.14;}
.iwsl-list__label{position:relative;z-index:1;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.iwsl-list__label.is-muted{color:var(--iwsl-muted);}
.iwsl-list__count{position:relative;z-index:1;font-variant-numeric:tabular-nums;}
.iwsl-list__pct{position:relative;z-index:1;color:var(--iwsl-ink-2);font-size:12px;font-variant-numeric:tabular-nums;min-width:38px;text-align:end;}
.iwsl-list__chev{position:relative;z-index:1;color:var(--iwsl-muted);}
button.iwsl-list__btn:hover .iwsl-list__chev{color:var(--iwsl-ink-2);}
.iwsl-heat-scroll{overflow-x:auto;}
.iwsl-heat-svg{max-width:100%;height:auto;min-width:560px;}
.iwsl-heat__hlabel,.iwsl-heat__dlabel{fill:var(--iwsl-ink-2);font-size:10px;}
.iwsl-heat.is-zero{stroke:var(--iwsl-line);stroke-width:1;}
.iwsl-heat__legend{display:flex;align-items:center;gap:4px;margin-top:8px;color:var(--iwsl-ink-2);font-size:11px;}
.iwsl-heat__sw{width:14px;height:12px;border-radius:3px;display:inline-block;}
.iwsl-heat__summary{color:var(--iwsl-ink-2);font-size:12px;margin:6px 0 0;}
.iwsl-feed{list-style:none;margin:0;padding:0;}
.iwsl-feed__row{display:flex;align-items:center;gap:12px;padding:6px 4px;border-top:1px solid var(--iwsl-line);}
.iwsl-feed__row:first-child{border-top:0;}
.iwsl-feed__chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--iwsl-ink-2);flex:0 0 96px;}
.iwsl-feed__dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}
.iwsl-feed__dot.is-s1{background:var(--iwsl-series-1);}.iwsl-feed__dot.is-s2{background:var(--iwsl-series-2);}
.iwsl-feed__dot.is-s3{background:var(--iwsl-series-3);}.iwsl-feed__dot.is-s6{background:var(--iwsl-series-6);}
.iwsl-feed__detail{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--iwsl-ink);font-size:13px;}
.iwsl-feed__time{color:var(--iwsl-ink-2);font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto;}
.iwsl-stats__empty{color:var(--iwsl-muted);margin:4px 0 0;}
.iwsl-adv{margin-top:20px;}
.iwsl-adv__body{padding-top:10px;}
.iwsl-stats__reset{margin-top:8px;}
.iwsl-drawer{position:fixed;inset:0;z-index:100000;}
.iwsl-drawer[hidden]{display:none;}
.iwsl-drawer__scrim{position:absolute;inset:0;background:var(--iwsl-scrim);opacity:0;transition:opacity .2s;}
.iwsl-drawer.is-open .iwsl-drawer__scrim{opacity:1;}
.iwsl-drawer__panel{position:absolute;top:0;right:0;height:100%;width:min(420px,100vw);background:var(--iwsl-card);border-inline-start:1px solid var(--iwsl-line);padding:20px;overflow-y:auto;transform:translateX(8%);opacity:0;transition:transform .2s ease-out,opacity .2s ease-out;backdrop-filter:blur(8px);}
.iwsl-stats .iwsl-drawer__panel,.iwsl-drawer__panel{background:var(--iwsl-card);}
.iwsl-drawer.is-open .iwsl-drawer__panel{transform:translateX(0);opacity:1;}
.iwsl-drawer__sentinel{position:absolute;width:1px;height:1px;overflow:hidden;}
.iwsl-drawer__head{display:flex;align-items:baseline;gap:10px;margin-bottom:12px;}
.iwsl-drawer__kicker{color:var(--iwsl-ink-2);font-size:12px;margin:0;text-transform:none;}
.iwsl-drawer__head h3{margin:0;flex:1 1 auto;color:var(--iwsl-ink);font-size:16px;overflow:hidden;text-overflow:ellipsis;}
.iwsl-drawer__close{border:0;background:transparent;font-size:22px;line-height:1;cursor:pointer;color:var(--iwsl-ink-2);padding:0 4px;}
.iwsl-drawer__kpis{color:var(--iwsl-ink);font-size:14px;font-variant-numeric:tabular-nums;margin-bottom:12px;}
.iwsl-drawer__spark{margin-bottom:14px;}
.iwsl-drawer__spark svg{width:100%;height:48px;display:block;}
.iwsl-drawer__lists{display:grid;gap:14px;}
.iwsl-drawer__lists h4{margin:0 0 6px;font-size:12px;color:var(--iwsl-ink-2);font-weight:600;}
@media (max-width:1100px){.iwsl-stats__zone{grid-template-columns:repeat(auto-fit,minmax(280px,1fr));}.iwsl-col-3,.iwsl-col-4,.iwsl-col-5,.iwsl-col-6,.iwsl-col-7,.iwsl-col-12{grid-column:auto;}}
@media (max-width:760px){.iwsl-stats__kpis{grid-template-columns:repeat(3,1fr);}.iwsl-stats__kpi:nth-child(n+4){border-top:1px solid var(--iwsl-line);}}
@media (max-width:600px){.iwsl-stats__kpis{grid-template-columns:repeat(2,1fr);}.iwsl-donut-wrap{flex-direction:column;align-items:flex-start;}.iwsl-drawer__panel{top:auto;bottom:0;width:100vw;height:auto;max-height:85vh;transform:translateY(12%);border-inline-start:0;border-top:1px solid var(--iwsl-line);border-radius:12px 12px 0 0;}.iwsl-drawer.is-open .iwsl-drawer__panel{transform:translateY(0);}}
@media (prefers-reduced-motion:reduce){.iwsl-stats *,.iwsl-stats *::before,.iwsl-stats *::after,.iwsl-drawer *{animation-duration:.01ms!important;transition-duration:.01ms!important;}}
CSS;
	}

	/** The single inlined interactivity IIFE — no globals, degrades to nothing without it. */
	private static function js(): string {
		return <<<'JS'
(function(){
"use strict";
var root=document.currentScript&&document.currentScript.closest?document.currentScript.closest('.iwsl-stats'):document.querySelector('.iwsl-stats');
if(!root)return;
var island=root.querySelector('#iwsl-stats-data');
var D={};try{D=JSON.parse(island.textContent)||{};}catch(e){D={};}
var SVGNS='http'+'://www.w3.org/2000/svg';
function $(s,c){return (c||root).querySelector(s);}function $all(s,c){return Array.prototype.slice.call((c||root).querySelectorAll(s));}
function txt(t){return document.createTextNode(String(t));}
function el(tag,cls){var e=document.createElement(tag);if(cls)e.className=cls;return e;}
function svgEl(tag){return document.createElementNS(SVGNS,tag);}
function fmt(n){try{return Number(n).toLocaleString();}catch(e){return String(n);}}

/* ---- primary chart: crosshair, tooltip, metric toggle, keyboard ---- */
var chart=$('[data-iwsl-chart]');
var geo=D.geo||{};var series=D.series||{views:[],visits:[]};var prev=D.prev||null;var labels=D.labels||[];
var metric='views';var compareOn=false;var focusIdx=-1;
function yFor(v){return geo.padt+geo.ih-(geo.max>0?(v/geo.max)*geo.ih:0);}
function xFor(i){return geo.padl+geo.step*i;}
if(chart){
 var cursor=$('.iwsl-svg__cursor',chart);var line=$('.iwsl-svg__cursorline',chart);
 var dotV=$('.iwsl-svg__cursordot.is-views',chart);var dotU=$('.iwsl-svg__cursordot.is-visits',chart);
 var hit=$('.iwsl-svg__hit',chart);var tip=$('.iwsl-stats__tooltip');var sr=$('.iwsl-stats__sr');var wrap=$('.iwsl-stats__chartwrap');
 function showAt(i){
  if(i<0||i>=(series.views||[]).length)return;
  focusIdx=i;var x=xFor(i);
  cursor.hidden=false;line.setAttribute('x1',x);line.setAttribute('x2',x);
  dotV.setAttribute('cx',x);dotV.setAttribute('cy',yFor(series.views[i]));
  dotU.setAttribute('cx',x);dotU.setAttribute('cy',yFor(series.visits[i]));
  if(tip){
   tip.textContent='';
   var head=el('div');head.appendChild(txt(labels[i]||''));tip.appendChild(head);
   var rv=el('div');rv.appendChild(txt((D.i18n.views)+' '));var bv=el('b');bv.appendChild(txt(fmt(series.views[i])));rv.appendChild(bv);tip.appendChild(rv);
   var ru=el('div');ru.appendChild(txt((D.i18n.visits)+' '));var bu=el('b');bu.appendChild(txt(fmt(series.visits[i])));ru.appendChild(bu);tip.appendChild(ru);
   if(compareOn&&prev){
    var pv=prev.views[i]||0;var d=pv>0?Math.round(((series.views[i]-pv)/pv)*100):0;
    var rp=el('div');rp.appendChild(txt(D.i18n.prev+' '+fmt(pv)+' ('+(d>=0?'+':'')+d+'%)'));tip.appendChild(rp);
   }
   var svgRect=chart.getBoundingClientRect();var scale=svgRect.width/geo.w;
   var px=x*scale;var py=Math.min(yFor(series.views[i]),yFor(series.visits[i]))*scale;
   tip.hidden=false;
   var tw=tip.offsetWidth,th=tip.offsetHeight;
   var left=Math.max(0,Math.min(px-tw/2,svgRect.width-tw));
   var top=py-th-8;var flip=py<svgRect.height*0.3;
   if(flip)top=py+14;
   tip.style.left=left+'px';tip.style.top=Math.max(0,top)+'px';
  }
  if(sr)sr.textContent=(labels[i]||'')+' — '+fmt(series.views[i])+' views, '+fmt(series.visits[i])+' unique visits.';
 }
 function hide(){cursor.hidden=true;if(tip)tip.hidden=true;}
 function idxFromEvent(ev){var r=chart.getBoundingClientRect();var vbx=(ev.clientX-r.left)/r.width*geo.w;return Math.max(0,Math.min(Math.round((vbx-geo.padl)/(geo.step||1)),(series.views||[]).length-1));}
 if(hit){
  hit.addEventListener('pointermove',function(ev){showAt(idxFromEvent(ev));});
  hit.addEventListener('pointerleave',hide);
 }
 chart.addEventListener('keydown',function(ev){
  var n=(series.views||[]).length;if(!n)return;var i=focusIdx<0?n-1:focusIdx;
  if(ev.key==='ArrowLeft'){i=Math.max(0,i-1);}else if(ev.key==='ArrowRight'){i=Math.min(n-1,i+1);}
  else if(ev.key==='Home'){i=0;}else if(ev.key==='End'){i=n-1;}
  else if(ev.key==='Escape'){hide();focusIdx=-1;return;}else{return;}
  ev.preventDefault();showAt(i);
 });
 /* metric toggle */
 var area=$('.iwsl-svg__area',chart);
 var lineV=$('.iwsl-svg__line.is-views',chart);var lineU=$('.iwsl-svg__line.is-visits',chart);
 var endV=$('.iwsl-svg__end.is-views',chart);var endU=$('.iwsl-svg__end.is-visits',chart);
 function setMetric(m){
  metric=m;
  $all('.iwsl-stats__kpi.is-metric').forEach(function(b){b.setAttribute('aria-pressed',b.getAttribute('data-metric')===m?'true':'false');});
  var isV=m==='views';
  if(area){area.setAttribute('d',isV?chart.getAttribute('data-area-views'):chart.getAttribute('data-area-visits'));
   area.classList.toggle('is-views',isV);area.classList.toggle('is-visits',!isV);}
  if(lineV)lineV.classList.toggle('is-dim',!isV);if(lineU)lineU.classList.toggle('is-dim',isV);
  if(endV)endV.hidden=!isV;if(endU)endU.hidden=isV;
 }
 $all('.iwsl-stats__kpi.is-metric').forEach(function(b){b.addEventListener('click',function(){setMetric(b.getAttribute('data-metric'));});});
}

/* ---- compare toggle + localStorage ---- */
var cmp=$('.iwsl-stats__compare');
if(cmp&&prev){
 cmp.hidden=false;
 var ghosts=chart?$('.iwsl-svg__ghosts',chart):null;var cap=$('.iwsl-stats__compare-cap');
 function setCompare(on){compareOn=on;cmp.setAttribute('aria-pressed',on?'true':'false');root.classList.toggle('is-compare',on);
  if(ghosts)ghosts.hidden=!on;if(cap)cap.hidden=!on;
  try{localStorage.setItem('iwsl.stats.compare',on?'1':'0');}catch(e){}}
 cmp.addEventListener('click',function(){setCompare(!compareOn);});
 var stored='0';try{stored=localStorage.getItem('iwsl.stats.compare')||'0';}catch(e){}
 if(stored==='1')setCompare(true);
}else if(cmp){cmp.hidden=false;}

/* ---- drill drawer ---- */
var drawer=$('.iwsl-drawer');
if(drawer&&D.drill){
 var panel=$('.iwsl-drawer__panel',drawer);var scrim=$('.iwsl-drawer__scrim',drawer);
 var invoker=null;
 function buildList(host,heading,pairs){
  var wrap=el('div');var h=el('h4');h.appendChild(txt(heading));wrap.appendChild(h);
  var ol=el('ol','iwsl-list');
  var max=1;(pairs||[]).forEach(function(p){max=Math.max(max,p[1]);});
  (pairs||[]).forEach(function(p){
   var li=el('li','iwsl-list__row');var d=el('div','iwsl-list__btn is-static');
   var f=el('span','iwsl-list__fill is-s2');f.style.insetInlineStart='0';f.style.width=((p[1]/max)*100)+'%';d.appendChild(f);
   var lab=el('span','iwsl-list__label');lab.title=p[0];lab.appendChild(txt(p[0]));d.appendChild(lab);
   var c=el('span','iwsl-list__count');c.appendChild(txt(fmt(p[1])));d.appendChild(c);
   li.appendChild(d);ol.appendChild(li);
  });
  if(!(pairs||[]).length){var em=el('p','iwsl-stats__empty');em.appendChild(txt('—'));wrap.appendChild(em);}else{wrap.appendChild(ol);}
  host.appendChild(wrap);
 }
 function sparkline(host,arr){
  host.textContent='';var n=arr.length;if(n<2)return;
  var min=Math.min.apply(null,arr),max=Math.max.apply(null,arr);var rng=(max-min)||1;
  var pts=[];for(var i=0;i<n;i++){var x=(i/(n-1))*100;var y=27-((arr[i]-min)/rng)*26;pts.push(x.toFixed(2)+','+y.toFixed(2));}
  var svg=svgEl('svg');svg.setAttribute('viewBox','0 0 100 28');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
  var pl=svgEl('polyline');pl.setAttribute('points',pts.join(' '));pl.setAttribute('fill','none');pl.setAttribute('stroke','var(--iwsl-series-1)');pl.setAttribute('stroke-width','1.5');pl.setAttribute('stroke-linejoin','round');
  svg.appendChild(pl);host.appendChild(svg);
 }
 function openDrawer(dim,key,btn){
  var bucket=D.drill[dim];if(!bucket)return;var d=bucket[key];if(!d)return;
  invoker=btn;
  $('.iwsl-drawer__kicker',drawer).textContent=D.i18n[dim]||dim;
  $('#iwsl-drawer-title').textContent=key;
  var kp=$('.iwsl-drawer__kpis',drawer);kp.textContent='';
  kp.appendChild(txt(D.i18n.views+' '+fmt(d.views)+' · '+D.i18n.visits+' '+fmt(d.visits)+' · '+d.share_pct+'% '+D.i18n.share+' · '+D.i18n.bounce+' '+d.bounce_pct+'%'));
  var range=D.range_days||30;var s=(d.series||[]).slice(-range);
  sparkline($('.iwsl-drawer__spark',drawer),s);
  var lists=$('.iwsl-drawer__lists',drawer);lists.textContent='';
  buildList(lists,'Top',d.a||[]);buildList(lists,'Also',d.b||[]);
  drawer.hidden=false;requestAnimationFrame(function(){drawer.classList.add('is-open');});
  document.body.style.overflow='hidden';
  panel.focus();
 }
 function closeDrawer(){
  drawer.classList.remove('is-open');document.body.style.overflow='';
  var f=invoker;window.setTimeout(function(){drawer.hidden=true;},200);
  if(f&&f.focus)f.focus();invoker=null;
 }
 root.addEventListener('click',function(ev){
  var b=ev.target.closest?ev.target.closest('.iwsl-list__btn[data-dim]'):null;
  if(b){ev.preventDefault();openDrawer(b.getAttribute('data-dim'),b.getAttribute('data-key'),b);}
 });
 $('.iwsl-drawer__close',drawer).addEventListener('click',closeDrawer);
 scrim.addEventListener('click',closeDrawer);
 drawer.addEventListener('keydown',function(ev){
  if(ev.key==='Escape'){ev.preventDefault();closeDrawer();return;}
  if(ev.key==='Tab'){
   var f=$all('a[href],button:not([disabled]),[tabindex]',panel).filter(function(n){return n.offsetParent!==null||n===document.activeElement;});
   if(!f.length)return;var first=f[0],last=f[f.length-1];
   if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last.focus();}
   else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first.focus();}
  }
 });
}
})();
JS;
	}
}
