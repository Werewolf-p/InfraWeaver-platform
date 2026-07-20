<?php
/**
 * §12.6 link.purge — the signed, delete-time enrollment scrub. Verifies the new
 * command is a genuinely allow-listed signed method (the verifier will accept a
 * signed link.purge), that it is wired to wipe all local state after answering
 * (so a reused/restored database leaves no re-enroll-blocking iwsl_* orphan), and
 * that its runner acknowledges the purge so the console confirms it end-to-end.
 *
 * A validly-SIGNED link.purge command can only be produced with the IW private
 * keys (SLH-DSA can't be signed in PHP), so this drives the plugin's own command
 * registry directly rather than through a forged wire object — the full signed
 * round-trip and the `wipes_after` machinery are already covered by test-plugin's
 * kill-switch flow, which shares the exact same code path.
 */

$store  = new IWSL_Memory_Store();
$plugin = new IWSL_Plugin( $store, iwsl_now_t0( 5000 ) );

// 1) Allow-list registration (§7): the verifier will accept a signed link.purge,
//    and it carries no params (§6.3) — parity with the console RpcMethod registry.
$methods = IWSL_Plugin::allowed_methods();
iwsl_assert( array_key_exists( 'link.purge', $methods ), 'link.purge is allow-listed (§7)' );
iwsl_assert_same( null, $methods['link.purge'], 'link.purge takes no params (§6.3)' );

// 2) Handler config: link.purge wipes local state after answering (like the kill
//    switch) and is not a PREPARE-style command that signs under a rotated key.
$ref = new ReflectionMethod( 'IWSL_Plugin', 'command_handlers' );
$ref->setAccessible( true );
$handlers = $ref->invoke( null );
iwsl_assert( isset( $handlers['link.purge'] ), 'link.purge has a command handler' );
$purge = $handlers['link.purge'];
iwsl_assert_same( true, $purge->wipes_after, 'link.purge wipes all local state after responding (§12.6)' );
iwsl_assert_same( false, $purge->signs_with_current_kid, 'link.purge is not a PREPARE-style command' );
iwsl_assert_same( null, $purge->validator, 'link.purge validator is null (empty params)' );

// 3) Runner: acknowledges the purge so the console verifies the scrub end-to-end.
list( $ok, $result ) = $purge->run( $plugin, new stdClass() );
iwsl_assert_same( true, $ok, 'link.purge runner returns ok' );
iwsl_assert_same( true, $result['purged'], 'link.purge runner reports purged:true' );

// 4) Wipe semantics: link.purge reuses the same wipes_after machinery, so an
//    enrolled store returns to a clean `unenrolled` slate with no re-enroll-
//    blocking key material or site_id left behind.
$store->set( 'state', 'active' );
$store->set( 'site_id', 'fixture-site' );
$store->set( 'wp_keys.1', array( 'pk' => 'x', 'sk' => 'y' ) );
$store->set( 'iw_keys.1', array() );
$store->set( 'wp_current_kid', 1 );
$wipe = new ReflectionMethod( 'IWSL_Plugin', 'wipe' );
$wipe->setAccessible( true );
$wipe->invoke( $plugin );
iwsl_assert_same( 'unenrolled', $store->get( 'state' ), 'wipe returns the store to unenrolled' );
iwsl_assert_same( null, $store->get( 'wp_keys.1' ), 'wipe destroys WP key material (no orphan)' );
iwsl_assert_same( null, $store->get( 'site_id' ), 'wipe drops the enrollment site_id' );
