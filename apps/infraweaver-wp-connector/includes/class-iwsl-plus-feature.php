<?php
/**
 * The actual client-side "Plus" paid feature — a Site Content & Health Snapshot
 * computed ENTIRELY from local WordPress data (no network, no console call). It
 * is rendered only when IWSL_Entitlements::evaluate('plus')['unlocked'] is true,
 * so this class is the payload behind the gate, kept separate from the gate logic
 * so each can be reasoned about (and tested) independently.
 *
 * Everything here is defensively guarded with function_exists so the snapshot
 * degrades to "n/a" outside a full WordPress context rather than fataling.
 */

defined( 'ABSPATH' ) || exit;

final class IWSL_Plus_Feature {

	/**
	 * Compute the premium snapshot from local WordPress state only.
	 *
	 * @return array<string, string|int>
	 */
	public static function snapshot(): array {
		$posts = self::count_published( 'post' );
		$pages = self::count_published( 'page' );

		$users = 0;
		if ( function_exists( 'count_users' ) ) {
			$counts = count_users();
			$users  = isset( $counts['total_users'] ) ? (int) $counts['total_users'] : 0;
		}

		$active_plugins = 0;
		if ( function_exists( 'get_option' ) ) {
			$active         = get_option( 'active_plugins', array() );
			$active_plugins = is_array( $active ) ? count( $active ) : 0;
		}

		return array(
			'published_posts' => $posts,
			'published_pages' => $pages,
			'users'           => $users,
			'active_plugins'  => $active_plugins,
			'php'             => PHP_VERSION,
			'wp'              => function_exists( 'get_bloginfo' ) ? (string) get_bloginfo( 'version' ) : 'n/a',
			'generated_at'    => function_exists( 'current_time' ) ? (string) current_time( 'mysql' ) : gmdate( 'Y-m-d H:i:s' ),
		);
	}

	/** Published-count for a post type, 0 outside a WP context. */
	private static function count_published( string $type ): int {
		if ( ! function_exists( 'wp_count_posts' ) ) {
			return 0;
		}
		$counts = wp_count_posts( $type );
		return isset( $counts->publish ) ? (int) $counts->publish : 0;
	}

	/**
	 * Render the unlocked feature. Presentation only — the caller (the admin
	 * page) has already confirmed the gate is unlocked. All values are escaped.
	 */
	public static function render(): void {
		$snap = self::snapshot();
		$rows = array(
			'Published posts' => $snap['published_posts'],
			'Published pages' => $snap['published_pages'],
			'Users'           => $snap['users'],
			'Active plugins'  => $snap['active_plugins'],
			'PHP version'     => $snap['php'],
			'WordPress'       => $snap['wp'],
			'Generated at'    => $snap['generated_at'],
		);
		echo '<div class="iwsl-plus-feature" style="border:1px solid var(--iw-line-2,#3a3f4b);background:var(--iw-panel,#23262e);border-radius:12px;padding:18px;margin-top:8px;">';
		echo '<h2 style="margin-top:0;">✨ Plus — Site Content &amp; Health Snapshot</h2>';
		echo '<p>This premium panel is generated locally from your WordPress data. No external call is made.</p>';
		echo '<table class="widefat striped" style="max-width:520px;"><tbody>';
		foreach ( $rows as $label => $value ) {
			echo '<tr><th scope="row" style="width:200px;">' . esc_html( (string) $label ) . '</th><td>' . esc_html( (string) $value ) . '</td></tr>';
		}
		echo '</tbody></table>';
		echo '</div>';
	}
}
