<?php
/**
 * Automatic image ALT text (rides the `seo_suite` gate): the pure
 * IWSL_SEO_Alt_Text derivation engine.
 *
 * Everything asserted here is a pure function over plain strings — derive(),
 * humanize_filename() and the resolve_fill() "never clobber" decision. No
 * WordPress, no stubs, no globals. The WP glue (the `add_attachment` hook) lives
 * in IWSL_SEO_Suite and is covered by the seo-suite suite.
 */

// ── 1. derive(): strict precedence title → filename → parent ──────────────────

iwsl_assert_same(
	'Author Chosen Alt',
	IWSL_SEO_Alt_Text::derive( 'Author Chosen Alt', 'coffee-grinder.jpg', 'Best Grinders' ),
	'derive: a non-empty attachment title wins'
);
iwsl_assert_same(
	'Coffee Grinder',
	IWSL_SEO_Alt_Text::derive( '', 'coffee-grinder.jpg', 'Best Grinders' ),
	'derive: empty title falls back to the humanized filename'
);
iwsl_assert_same(
	'Best Grinders',
	IWSL_SEO_Alt_Text::derive( '', '', 'Best Grinders' ),
	'derive: empty title + filename falls back to the parent title'
);
iwsl_assert_same(
	'',
	IWSL_SEO_Alt_Text::derive( '', '', '' ),
	'derive: all-empty inputs yield an empty string'
);
iwsl_assert_same(
	'X',
	IWSL_SEO_Alt_Text::derive( '   ', 'x.png', 'Parent' ),
	'derive: a whitespace-only title is treated as empty → humanized filename "X"'
);

// ── 2. humanize_filename(): strip ext, -/_ → space, Title Case ────────────────

iwsl_assert_same( 'Coffee Grinder Photo', IWSL_SEO_Alt_Text::humanize_filename( 'coffee-grinder_photo.jpg' ), 'humanize: dashes+underscores → spaces, Title Case, ext stripped' );
iwsl_assert_same( 'Sunset Beach', IWSL_SEO_Alt_Text::humanize_filename( 'sunset-beach.JPEG' ), 'humanize: uppercase extension stripped' );
iwsl_assert_same( 'My Photo', IWSL_SEO_Alt_Text::humanize_filename( 'my___photo.png' ), 'humanize: collapses repeated underscores' );
iwsl_assert_same( 'Image', IWSL_SEO_Alt_Text::humanize_filename( '/var/uploads/2026/07/image.webp' ), 'humanize: path stripped, basename humanized' );
iwsl_assert_same( 'Report', IWSL_SEO_Alt_Text::humanize_filename( 'report' ), 'humanize: a filename with no extension still humanizes' );
iwsl_assert_same( '', IWSL_SEO_Alt_Text::humanize_filename( '' ), 'humanize: empty in → empty out' );
iwsl_assert_same( '', IWSL_SEO_Alt_Text::humanize_filename( '.png' ), 'humanize: extension-only filename → empty' );

// ── 3. resolve_fill(): the "never clobber an author alt" invariant ────────────

iwsl_assert_same(
	null,
	IWSL_SEO_Alt_Text::resolve_fill( 'Existing alt', 'Title', 'file.jpg', 'Parent' ),
	'resolve_fill: an existing alt is NEVER overwritten (returns null)'
);
iwsl_assert_same(
	null,
	IWSL_SEO_Alt_Text::resolve_fill( '   ', '', '', '' ),
	'resolve_fill: whitespace-only current alt with nothing to derive → null'
);
iwsl_assert_same(
	'Whitespace Alt',
	IWSL_SEO_Alt_Text::resolve_fill( '   ', 'Whitespace Alt', 'file.jpg', 'Parent' ),
	'resolve_fill: a whitespace-only alt is treated as empty and IS filled'
);
iwsl_assert_same(
	'Coffee Grinder',
	IWSL_SEO_Alt_Text::resolve_fill( '', '', 'coffee-grinder.jpg', 'Parent' ),
	'resolve_fill: empty alt fills from the derived value'
);

// This suite installs no globals — nothing to unset.
