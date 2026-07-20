<?php
/**
 * The plugin's wp-admin surface: a single Tools → "InfraWeaver Plus" page that
 * is the MANUAL TEST SURFACE for the client-side feature gate. It reads only
 * local plugin state (IWSL_Entitlements::evaluate) — never a network call — and:
 *
 *   - shows each gate's live state: linked? heartbeat fresh? Plus granted?
 *   - renders the gated feature (IWSL_Plus_Feature) when ALL gates pass;
 *   - otherwise clearly shows WHY it is locked, one human line per failing gate.
 *
 * So an operator can verify exactly what happens with/without the link, with a
 * stale heartbeat, and with/without the Plus checkmark from the console.
 */

final class IWSL_Admin {

	/** @var IWSL_Plugin */
	private $plugin;

	public function __construct( IWSL_Plugin $plugin ) {
		$this->plugin = $plugin;
	}

	/** Hook the admin menu. Safe to call at load — add_menu only fires in admin. */
	public function register(): void {
		add_action( 'admin_menu', array( $this, 'add_menu' ) );
	}

	public function add_menu(): void {
		add_management_page(
			'InfraWeaver Plus',
			'InfraWeaver Plus',
			'manage_options',
			'infraweaver-plus',
			array( $this, 'render_page' )
		);
	}

	public function render_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to view this page.', 'default' ) );
		}
		$gate = $this->plugin->entitlements()->evaluate( 'plus' );

		echo '<div class="wrap">';
		echo '<h1>InfraWeaver Plus</h1>';
		echo '<p>Client-side feature gate — evaluated entirely from local plugin state. The gated feature runs only when the site is <strong>linked</strong>, has a <strong>fresh signed heartbeat</strong>, and has the <strong>Plus</strong> entitlement granted from the console.</p>';

		self::render_gate_table( $gate );

		if ( ! empty( $gate['unlocked'] ) ) {
			IWSL_Plus_Feature::render();
		} else {
			self::render_locked_notice( $gate );
		}
		echo '</div>';
	}

	/** One row per gate with a pass/fail marker and the live detail. */
	private static function render_gate_table( array $gate ): void {
		$heartbeat_detail = self::heartbeat_detail( $gate );
		$rows             = array(
			array(
				'label'  => 'Linked',
				'ok'     => ! empty( $gate['linked'] ),
				'detail' => 'Enrollment state: ' . (string) $gate['state'],
			),
			array(
				'label'  => 'Heartbeat fresh',
				'ok'     => ! empty( $gate['heartbeat_fresh'] ),
				'detail' => $heartbeat_detail,
			),
			array(
				'label'  => 'Plus granted',
				'ok'     => ! empty( $gate['plus'] ),
				'detail' => ! empty( $gate['plus'] ) ? 'Entitlement present' : 'Not granted from the console',
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
			return 'No verified signed contact yet';
		}
		$age_ms    = (int) $gate['heartbeat_age_ms'];
		$age_min   = (int) floor( $age_ms / 60000 );
		$limit_min = (int) floor( (int) $gate['heartbeat_threshold_ms'] / 60000 );
		return sprintf( 'Last verified contact %d min ago (fresh window: %d min)', max( 0, $age_min ), $limit_min );
	}

	/** Human, one-line-per-reason explanation of the lock. */
	private static function render_locked_notice( array $gate ): void {
		$messages = array(
			'not-linked'      => 'This site is not linked to the InfraWeaver console. Enroll the connector first.',
			'heartbeat-stale' => 'The signed heartbeat is stale — the console has not verified a signed command recently.',
			'requires-plus'   => 'The Plus entitlement is not granted. Grant it from the console (per-site toggle).',
		);
		echo '<div class="notice notice-warning" style="margin-top:12px;padding:12px;"><p><strong>🔒 Plus feature locked.</strong></p><ul style="list-style:disc;margin-left:20px;">';
		foreach ( (array) $gate['reasons'] as $reason ) {
			$text = isset( $messages[ $reason ] ) ? $messages[ $reason ] : (string) $reason;
			echo '<li>' . esc_html( $text ) . '</li>';
		}
		echo '</ul></div>';
	}
}
