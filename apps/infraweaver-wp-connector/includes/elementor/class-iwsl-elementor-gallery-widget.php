<?php
/**
 * The Elementor widget "IWSL Media Gallery (by tag)" for the gated `media_folders`
 * feature. It subclasses `\Elementor\Widget_Base`, so THIS FILE IS PARSED ONLY WHEN
 * ELEMENTOR IS LOADED — IWSL_Media_Gallery::register_widget() requires it lazily from
 * inside the `elementor/widgets/register` callback, which never fires on a site
 * without Elementor. Never add this file to the plugin bootstrap or the test harness
 * require list: declaring the subclass without the parent class present would fatal.
 *
 * The widget carries NO gallery logic of its own — render() marshals the author's
 * controls into an args array and hands them to the ONE shared renderer,
 * IWSL_Media_Gallery::render_for_widget(), which re-checks the entitlement gate and
 * emits the exact same bounded, cached, escaped markup as the shortcode and block. On
 * a locked site (or an empty/unknown tag) the renderer returns '', and in the
 * Elementor editor we show a small placeholder instead of a blank canvas.
 */

defined( 'ABSPATH' ) || exit;

// This file is only ever loaded with Elementor present; bail defensively if not.
if ( ! class_exists( '\\Elementor\\Widget_Base' ) ) {
	return;
}

final class IWSL_Widget_Media_Gallery extends \Elementor\Widget_Base {

	public function get_name() {
		return 'iwsl-media-gallery';
	}

	public function get_title() {
		return esc_html__( 'IWSL Media Gallery (by tag)', 'infraweaver-connector' );
	}

	public function get_icon() {
		return 'eicon-gallery-grid';
	}

	public function get_categories() {
		return array( class_exists( 'IWSL_Media_Gallery' ) ? IWSL_Media_Gallery::CATEGORY_SLUG : 'infraweaver' );
	}

	public function get_keywords() {
		return array( 'infraweaver', 'gallery', 'media', 'tag', 'images', 'grid' );
	}

	protected function register_controls() {
		$this->start_controls_section(
			'content',
			array(
				'label' => esc_html__( 'Gallery', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_CONTENT,
			)
		);

		$tags = class_exists( 'IWSL_Media_Gallery' ) ? IWSL_Media_Gallery::tag_options() : array();
		$this->add_control(
			'tag',
			array(
				'label'       => esc_html__( 'Tag', 'infraweaver-connector' ),
				'type'        => empty( $tags ) ? \Elementor\Controls_Manager::TEXT : \Elementor\Controls_Manager::SELECT2,
				'options'     => $tags,
				'label_block' => true,
				'description' => esc_html__( 'Every image carrying this tag appears in the gallery — tag an image tomorrow and it shows up automatically.', 'infraweaver-connector' ),
			)
		);

		$this->add_responsive_control(
			'columns',
			array(
				'label'          => esc_html__( 'Columns', 'infraweaver-connector' ),
				'type'           => \Elementor\Controls_Manager::SELECT,
				'default'        => '3',
				'tablet_default' => '2',
				'mobile_default' => '2',
				'options'        => array( '1' => '1', '2' => '2', '3' => '3', '4' => '4', '5' => '5', '6' => '6' ),
			)
		);

		$this->add_control(
			'size',
			array(
				'label'   => esc_html__( 'Image size', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::SELECT,
				'default' => 'medium',
				'options' => array(
					'thumbnail'    => esc_html__( 'Thumbnail', 'infraweaver-connector' ),
					'medium'       => esc_html__( 'Medium', 'infraweaver-connector' ),
					'medium_large' => esc_html__( 'Medium Large', 'infraweaver-connector' ),
					'large'        => esc_html__( 'Large', 'infraweaver-connector' ),
					'full'         => esc_html__( 'Full', 'infraweaver-connector' ),
				),
			)
		);

		$this->add_control(
			'orderby',
			array(
				'label'   => esc_html__( 'Order by', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::SELECT,
				'default' => 'date',
				'options' => array(
					'date'       => esc_html__( 'Date', 'infraweaver-connector' ),
					'title'      => esc_html__( 'Title', 'infraweaver-connector' ),
					'menu_order' => esc_html__( 'Menu order', 'infraweaver-connector' ),
					'rand'       => esc_html__( 'Random', 'infraweaver-connector' ),
				),
			)
		);

		$this->add_control(
			'order',
			array(
				'label'   => esc_html__( 'Order', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::SELECT,
				'default' => 'desc',
				'options' => array(
					'desc' => esc_html__( 'Descending', 'infraweaver-connector' ),
					'asc'  => esc_html__( 'Ascending', 'infraweaver-connector' ),
				),
			)
		);

		$max = class_exists( 'IWSL_Media_Gallery' ) ? IWSL_Media_Gallery::GALLERY_MAX : 200;
		$this->add_control(
			'limit',
			array(
				'label'   => esc_html__( 'Maximum images', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::NUMBER,
				'default' => 24,
				'min'     => 1,
				'max'     => $max,
				'step'    => 1,
			)
		);

		$this->add_control(
			'lightbox',
			array(
				'label'        => esc_html__( 'Lightbox', 'infraweaver-connector' ),
				'type'         => \Elementor\Controls_Manager::SWITCHER,
				'label_on'     => esc_html__( 'On', 'infraweaver-connector' ),
				'label_off'    => esc_html__( 'Off', 'infraweaver-connector' ),
				'return_value' => 'yes',
				'default'      => 'yes',
			)
		);

		$this->add_control(
			'captions',
			array(
				'label'        => esc_html__( 'Captions', 'infraweaver-connector' ),
				'type'         => \Elementor\Controls_Manager::SWITCHER,
				'label_on'     => esc_html__( 'Show', 'infraweaver-connector' ),
				'label_off'    => esc_html__( 'Hide', 'infraweaver-connector' ),
				'return_value' => 'yes',
				'default'      => '',
			)
		);

		$this->end_controls_section();
	}

	protected function render() {
		$s    = $this->get_settings_for_display();
		$args = array(
			'tag'      => isset( $s['tag'] ) ? $s['tag'] : '',
			'columns'  => isset( $s['columns'] ) ? $s['columns'] : 3,
			'size'     => isset( $s['size'] ) ? $s['size'] : 'medium',
			'orderby'  => isset( $s['orderby'] ) ? $s['orderby'] : 'date',
			'order'    => isset( $s['order'] ) ? $s['order'] : 'desc',
			'limit'    => isset( $s['limit'] ) ? $s['limit'] : 24,
			'lightbox' => ! isset( $s['lightbox'] ) || 'yes' === $s['lightbox'],
			'captions' => isset( $s['captions'] ) && 'yes' === $s['captions'],
		);

		$html = class_exists( 'IWSL_Media_Gallery' ) ? IWSL_Media_Gallery::render_for_widget( $args ) : '';
		if ( '' !== $html ) {
			echo $html; // phpcs:ignore WordPress.Security.EscapingOutput.OutputNotEscaped -- render_gallery escapes every value at source.
			return;
		}

		// Editor-only placeholder so an unconfigured / empty-tag widget isn't a blank
		// canvas; the public page renders nothing.
		if ( \Elementor\Plugin::$instance->editor->is_edit_mode() ) {
			echo '<div class="iwsl-gallery-placeholder" style="padding:24px;border:1px dashed #c3c4c7;text-align:center;color:#646970;font:14px/1.5 system-ui,sans-serif;">'
				. esc_html__( 'IWSL Media Gallery — pick a tag with images to build a gallery.', 'infraweaver-connector' )
				. '</div>';
		}
	}
}
