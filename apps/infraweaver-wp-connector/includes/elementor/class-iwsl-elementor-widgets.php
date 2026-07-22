<?php
/**
 * The InfraWeaver Elementor widget classes for the gated `elementor_blocks`
 * feature. Each subclasses `\Elementor\Widget_Base`, so THIS FILE IS PARSED ONLY
 * WHEN ELEMENTOR IS LOADED — IWSL_Elementor_Blocks::register_widgets() requires
 * it lazily from inside the `elementor/widgets/register` callback, which never
 * fires on a site without Elementor. Never add this file to the plugin bootstrap
 * or the test harness require list: declaring these subclasses without the
 * parent class present would fatal.
 *
 * Four widgets, all in the "InfraWeaver" category:
 *   - IWSL_Widget_Callout       : Call-to-Action banner (heading + text + button)
 *   - IWSL_Widget_Feature_Grid  : responsive grid of icon + title + text cards
 *   - IWSL_Widget_Pricing_Table : plan name, price, feature list, CTA
 *   - IWSL_Widget_Notice        : small info / success / warning / error callout
 *
 * ESCAPING. Every author-supplied value is escaped at render (esc_html /
 * esc_attr / esc_url / wp_kses_post), and settings are read via the display
 * accessor get_settings_for_display(). Styling uses Elementor's own `selectors`
 * (`{{WRAPPER}}`) so the editor writes scoped CSS rather than the widget echoing
 * raw style strings.
 */

defined( 'ABSPATH' ) || exit;

// This file is only ever loaded with Elementor present; bail defensively if not.
if ( ! class_exists( '\\Elementor\\Widget_Base' ) ) {
	return;
}

/**
 * Shared base: pins every InfraWeaver widget to the `infraweaver` category and
 * provides the safe anchor-attribute builder the CTA/pricing widgets reuse.
 */
abstract class IWSL_Elementor_Widget_Base extends \Elementor\Widget_Base {

	/** Group every InfraWeaver widget under the plugin's own category. */
	public function get_categories() {
		return array( class_exists( 'IWSL_Elementor_Blocks' ) ? IWSL_Elementor_Blocks::CATEGORY_SLUG : 'infraweaver' );
	}

	/**
	 * Build escaped `href`/`target`/`rel` attributes from an Elementor URL control
	 * value. Returns '' (no href) when the control is empty, so the caller can
	 * render a non-linked element instead of a dead `href=""`.
	 *
	 * @param mixed $link The URL control value (array with url/is_external/nofollow).
	 */
	protected function iwsl_link_attrs( $link ): string {
		if ( ! is_array( $link ) ) {
			return '';
		}
		$url = isset( $link['url'] ) ? trim( (string) $link['url'] ) : '';
		if ( '' === $url ) {
			return '';
		}
		$attrs = ' href="' . esc_url( $url ) . '"';
		if ( ! empty( $link['is_external'] ) ) {
			$attrs .= ' target="_blank"';
		}
		$rel = array();
		if ( ! empty( $link['is_external'] ) ) {
			$rel[] = 'noopener';
		}
		if ( ! empty( $link['nofollow'] ) ) {
			$rel[] = 'nofollow';
		}
		if ( ! empty( $rel ) ) {
			$attrs .= ' rel="' . esc_attr( implode( ' ', $rel ) ) . '"';
		}
		return $attrs;
	}
}

/**
 * IW Callout / CTA Banner — a headline, supporting text and a single button,
 * with background / text colours and horizontal alignment.
 */
final class IWSL_Widget_Callout extends IWSL_Elementor_Widget_Base {

	public function get_name() {
		return 'iwsl-callout';
	}

	public function get_title() {
		return esc_html__( 'IW Callout / CTA', 'infraweaver-connector' );
	}

	public function get_icon() {
		return 'eicon-call-to-action';
	}

	public function get_keywords() {
		return array( 'infraweaver', 'cta', 'callout', 'banner', 'button' );
	}

	protected function register_controls() {
		$this->start_controls_section(
			'content',
			array(
				'label' => esc_html__( 'Content', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_CONTENT,
			)
		);

		$this->add_control(
			'heading',
			array(
				'label'       => esc_html__( 'Heading', 'infraweaver-connector' ),
				'type'        => \Elementor\Controls_Manager::TEXT,
				'default'     => esc_html__( 'Ready to get started?', 'infraweaver-connector' ),
				'label_block' => true,
			)
		);

		$this->add_control(
			'text',
			array(
				'label'   => esc_html__( 'Text', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXTAREA,
				'default' => esc_html__( 'Tell your visitors what to do next in a sentence or two.', 'infraweaver-connector' ),
			)
		);

		$this->add_control(
			'button_text',
			array(
				'label'   => esc_html__( 'Button label', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXT,
				'default' => esc_html__( 'Get in touch', 'infraweaver-connector' ),
			)
		);

		$this->add_control(
			'button_link',
			array(
				'label'   => esc_html__( 'Button link', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::URL,
				'default' => array( 'url' => '#' ),
			)
		);

		$this->add_responsive_control(
			'align',
			array(
				'label'     => esc_html__( 'Alignment', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::CHOOSE,
				'options'   => array(
					'left'   => array(
						'title' => esc_html__( 'Left', 'infraweaver-connector' ),
						'icon'  => 'eicon-text-align-left',
					),
					'center' => array(
						'title' => esc_html__( 'Center', 'infraweaver-connector' ),
						'icon'  => 'eicon-text-align-center',
					),
					'right'  => array(
						'title' => esc_html__( 'Right', 'infraweaver-connector' ),
						'icon'  => 'eicon-text-align-right',
					),
				),
				'default'   => 'center',
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-callout' => 'text-align: {{VALUE}};',
				),
			)
		);

		$this->end_controls_section();

		$this->start_controls_section(
			'style',
			array(
				'label' => esc_html__( 'Style', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_STYLE,
			)
		);

		$this->add_control(
			'bg_color',
			array(
				'label'     => esc_html__( 'Background colour', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-callout' => 'background-color: {{VALUE}};',
				),
			)
		);

		$this->add_control(
			'text_color',
			array(
				'label'     => esc_html__( 'Text colour', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-callout, {{WRAPPER}} .iwsl-el-callout__title' => 'color: {{VALUE}};',
				),
			)
		);

		$this->add_control(
			'button_bg',
			array(
				'label'     => esc_html__( 'Button background', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-callout__btn' => 'background-color: {{VALUE}};',
				),
			)
		);

		$this->add_control(
			'button_color',
			array(
				'label'     => esc_html__( 'Button text colour', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-callout__btn' => 'color: {{VALUE}};',
				),
			)
		);

		$this->end_controls_section();
	}

	protected function render() {
		$s       = $this->get_settings_for_display();
		$heading = isset( $s['heading'] ) ? (string) $s['heading'] : '';
		$text    = isset( $s['text'] ) ? (string) $s['text'] : '';
		$label   = isset( $s['button_text'] ) ? (string) $s['button_text'] : '';
		$link    = isset( $s['button_link'] ) ? $s['button_link'] : array();

		echo '<div class="iwsl-el-callout">';
		if ( '' !== $heading ) {
			echo '<h3 class="iwsl-el-callout__title">' . esc_html( $heading ) . '</h3>';
		}
		if ( '' !== $text ) {
			echo '<div class="iwsl-el-callout__text">' . wp_kses_post( wpautop( $text ) ) . '</div>';
		}
		if ( '' !== $label ) {
			$attrs = $this->iwsl_link_attrs( $link );
			if ( '' !== $attrs ) {
				echo '<a class="iwsl-el-callout__btn"' . $attrs . '>' . esc_html( $label ) . '</a>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $attrs built from esc_url/esc_attr.
			} else {
				echo '<span class="iwsl-el-callout__btn">' . esc_html( $label ) . '</span>';
			}
		}
		echo '</div>';
	}
}

/**
 * IW Feature Grid — a responsive grid of "icon + title + text" cards. The icon is
 * a short text/emoji field, so no icon library or unescaped markup is involved.
 */
final class IWSL_Widget_Feature_Grid extends IWSL_Elementor_Widget_Base {

	public function get_name() {
		return 'iwsl-feature-grid';
	}

	public function get_title() {
		return esc_html__( 'IW Feature Grid', 'infraweaver-connector' );
	}

	public function get_icon() {
		return 'eicon-gallery-grid';
	}

	public function get_keywords() {
		return array( 'infraweaver', 'feature', 'grid', 'cards', 'services' );
	}

	protected function register_controls() {
		$this->start_controls_section(
			'content',
			array(
				'label' => esc_html__( 'Features', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_CONTENT,
			)
		);

		$this->add_responsive_control(
			'columns',
			array(
				'label'          => esc_html__( 'Columns', 'infraweaver-connector' ),
				'type'           => \Elementor\Controls_Manager::SELECT,
				'default'        => '3',
				'tablet_default' => '2',
				'mobile_default' => '1',
				'options'        => array(
					'1' => '1',
					'2' => '2',
					'3' => '3',
					'4' => '4',
				),
				'selectors'      => array(
					'{{WRAPPER}} .iwsl-el-grid' => 'grid-template-columns: repeat({{VALUE}}, minmax(0, 1fr));',
				),
			)
		);

		$repeater = new \Elementor\Repeater();
		$repeater->add_control(
			'icon',
			array(
				'label'   => esc_html__( 'Icon (emoji or text)', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXT,
				'default' => '⭐',
			)
		);
		$repeater->add_control(
			'title',
			array(
				'label'       => esc_html__( 'Title', 'infraweaver-connector' ),
				'type'        => \Elementor\Controls_Manager::TEXT,
				'default'     => esc_html__( 'Feature title', 'infraweaver-connector' ),
				'label_block' => true,
			)
		);
		$repeater->add_control(
			'text',
			array(
				'label'   => esc_html__( 'Text', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXTAREA,
				'default' => esc_html__( 'A short line describing this feature.', 'infraweaver-connector' ),
			)
		);

		$this->add_control(
			'items',
			array(
				'label'       => esc_html__( 'Cards', 'infraweaver-connector' ),
				'type'        => \Elementor\Controls_Manager::REPEATER,
				'fields'      => $repeater->get_controls(),
				'title_field' => '{{{ title }}}',
				'default'     => array(
					array(
						'icon'  => '⚡',
						'title' => esc_html__( 'Fast', 'infraweaver-connector' ),
						'text'  => esc_html__( 'Describe the first thing you offer.', 'infraweaver-connector' ),
					),
					array(
						'icon'  => '🔒',
						'title' => esc_html__( 'Secure', 'infraweaver-connector' ),
						'text'  => esc_html__( 'Describe the second thing you offer.', 'infraweaver-connector' ),
					),
					array(
						'icon'  => '💡',
						'title' => esc_html__( 'Simple', 'infraweaver-connector' ),
						'text'  => esc_html__( 'Describe the third thing you offer.', 'infraweaver-connector' ),
					),
				),
			)
		);

		$this->end_controls_section();

		$this->start_controls_section(
			'style',
			array(
				'label' => esc_html__( 'Style', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_STYLE,
			)
		);

		$this->add_responsive_control(
			'gap',
			array(
				'label'      => esc_html__( 'Gap', 'infraweaver-connector' ),
				'type'       => \Elementor\Controls_Manager::SLIDER,
				'size_units' => array( 'px' ),
				'range'      => array( 'px' => array( 'min' => 0, 'max' => 80 ) ),
				'default'    => array(
					'unit' => 'px',
					'size' => 20,
				),
				'selectors'  => array(
					'{{WRAPPER}} .iwsl-el-grid' => 'gap: {{SIZE}}{{UNIT}};',
				),
			)
		);

		$this->add_control(
			'card_bg',
			array(
				'label'     => esc_html__( 'Card background', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-grid__card' => 'background-color: {{VALUE}};',
				),
			)
		);

		$this->add_control(
			'title_color',
			array(
				'label'     => esc_html__( 'Title colour', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-grid__title' => 'color: {{VALUE}};',
				),
			)
		);

		$this->end_controls_section();
	}

	protected function render() {
		$s     = $this->get_settings_for_display();
		$items = isset( $s['items'] ) && is_array( $s['items'] ) ? $s['items'] : array();
		if ( empty( $items ) ) {
			return;
		}

		echo '<div class="iwsl-el-grid">';
		foreach ( $items as $item ) {
			$icon  = isset( $item['icon'] ) ? (string) $item['icon'] : '';
			$title = isset( $item['title'] ) ? (string) $item['title'] : '';
			$text  = isset( $item['text'] ) ? (string) $item['text'] : '';

			echo '<div class="iwsl-el-grid__card">';
			if ( '' !== $icon ) {
				echo '<div class="iwsl-el-grid__icon" aria-hidden="true">' . esc_html( $icon ) . '</div>';
			}
			if ( '' !== $title ) {
				echo '<h4 class="iwsl-el-grid__title">' . esc_html( $title ) . '</h4>';
			}
			if ( '' !== $text ) {
				echo '<p class="iwsl-el-grid__text">' . esc_html( $text ) . '</p>';
			}
			echo '</div>';
		}
		echo '</div>';
	}
}

/**
 * IW Pricing Table — plan name, price + period, a feature list (each with an
 * included/excluded toggle) and a CTA button, with an optional "featured"
 * highlight.
 */
final class IWSL_Widget_Pricing_Table extends IWSL_Elementor_Widget_Base {

	public function get_name() {
		return 'iwsl-pricing-table';
	}

	public function get_title() {
		return esc_html__( 'IW Pricing Table', 'infraweaver-connector' );
	}

	public function get_icon() {
		return 'eicon-price-table';
	}

	public function get_keywords() {
		return array( 'infraweaver', 'pricing', 'plan', 'price', 'table' );
	}

	protected function register_controls() {
		$this->start_controls_section(
			'plan',
			array(
				'label' => esc_html__( 'Plan', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_CONTENT,
			)
		);

		$this->add_control(
			'plan_name',
			array(
				'label'   => esc_html__( 'Plan name', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXT,
				'default' => esc_html__( 'Pro', 'infraweaver-connector' ),
			)
		);

		$this->add_control(
			'price',
			array(
				'label'   => esc_html__( 'Price', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXT,
				'default' => '$29',
			)
		);

		$this->add_control(
			'period',
			array(
				'label'   => esc_html__( 'Period', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXT,
				'default' => esc_html__( '/month', 'infraweaver-connector' ),
			)
		);

		$this->add_control(
			'featured',
			array(
				'label'        => esc_html__( 'Highlight as featured', 'infraweaver-connector' ),
				'type'         => \Elementor\Controls_Manager::SWITCHER,
				'label_on'     => esc_html__( 'Yes', 'infraweaver-connector' ),
				'label_off'    => esc_html__( 'No', 'infraweaver-connector' ),
				'return_value' => 'yes',
				'default'      => '',
			)
		);

		$repeater = new \Elementor\Repeater();
		$repeater->add_control(
			'feature_text',
			array(
				'label'       => esc_html__( 'Feature', 'infraweaver-connector' ),
				'type'        => \Elementor\Controls_Manager::TEXT,
				'default'     => esc_html__( 'What this plan includes', 'infraweaver-connector' ),
				'label_block' => true,
			)
		);
		$repeater->add_control(
			'included',
			array(
				'label'        => esc_html__( 'Included', 'infraweaver-connector' ),
				'type'         => \Elementor\Controls_Manager::SWITCHER,
				'return_value' => 'yes',
				'default'      => 'yes',
			)
		);

		$this->add_control(
			'features',
			array(
				'label'       => esc_html__( 'Features', 'infraweaver-connector' ),
				'type'        => \Elementor\Controls_Manager::REPEATER,
				'fields'      => $repeater->get_controls(),
				'title_field' => '{{{ feature_text }}}',
				'default'     => array(
					array(
						'feature_text' => esc_html__( 'Everything in Basic', 'infraweaver-connector' ),
						'included'     => 'yes',
					),
					array(
						'feature_text' => esc_html__( 'Priority support', 'infraweaver-connector' ),
						'included'     => 'yes',
					),
					array(
						'feature_text' => esc_html__( 'Advanced analytics', 'infraweaver-connector' ),
						'included'     => '',
					),
				),
			)
		);

		$this->add_control(
			'button_text',
			array(
				'label'   => esc_html__( 'Button label', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXT,
				'default' => esc_html__( 'Choose plan', 'infraweaver-connector' ),
			)
		);

		$this->add_control(
			'button_link',
			array(
				'label'   => esc_html__( 'Button link', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::URL,
				'default' => array( 'url' => '#' ),
			)
		);

		$this->end_controls_section();

		$this->start_controls_section(
			'style',
			array(
				'label' => esc_html__( 'Style', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_STYLE,
			)
		);

		$this->add_control(
			'accent',
			array(
				'label'     => esc_html__( 'Accent colour', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-price__amount, {{WRAPPER}} .iwsl-el-price.is-featured' => 'color: {{VALUE}}; border-color: {{VALUE}};',
					'{{WRAPPER}} .iwsl-el-price__btn' => 'background-color: {{VALUE}};',
				),
			)
		);

		$this->add_control(
			'card_bg',
			array(
				'label'     => esc_html__( 'Card background', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-price' => 'background-color: {{VALUE}};',
				),
			)
		);

		$this->end_controls_section();
	}

	protected function render() {
		$s        = $this->get_settings_for_display();
		$name     = isset( $s['plan_name'] ) ? (string) $s['plan_name'] : '';
		$price    = isset( $s['price'] ) ? (string) $s['price'] : '';
		$period   = isset( $s['period'] ) ? (string) $s['period'] : '';
		$features = isset( $s['features'] ) && is_array( $s['features'] ) ? $s['features'] : array();
		$label    = isset( $s['button_text'] ) ? (string) $s['button_text'] : '';
		$link     = isset( $s['button_link'] ) ? $s['button_link'] : array();
		$featured = isset( $s['featured'] ) && 'yes' === $s['featured'];

		echo '<div class="iwsl-el-price' . ( $featured ? ' is-featured' : '' ) . '">';
		if ( '' !== $name ) {
			echo '<div class="iwsl-el-price__name">' . esc_html( $name ) . '</div>';
		}
		if ( '' !== $price ) {
			echo '<div class="iwsl-el-price__amount">' . esc_html( $price )
				. ( '' !== $period ? ' <span class="iwsl-el-price__period">' . esc_html( $period ) . '</span>' : '' )
				. '</div>';
		}
		if ( ! empty( $features ) ) {
			echo '<ul class="iwsl-el-price__features">';
			foreach ( $features as $feature ) {
				$feature_text = isset( $feature['feature_text'] ) ? (string) $feature['feature_text'] : '';
				if ( '' === $feature_text ) {
					continue;
				}
				$is_in = isset( $feature['included'] ) && 'yes' === $feature['included'];
				echo '<li class="iwsl-el-price__feature ' . ( $is_in ? 'is-in' : 'is-out' ) . '">'
					. '<span class="iwsl-el-price__mark" aria-hidden="true">' . ( $is_in ? '✓' : '✕' ) . '</span> '
					. esc_html( $feature_text )
					. '</li>';
			}
			echo '</ul>';
		}
		if ( '' !== $label ) {
			$attrs = $this->iwsl_link_attrs( $link );
			if ( '' !== $attrs ) {
				echo '<a class="iwsl-el-price__btn"' . $attrs . '>' . esc_html( $label ) . '</a>'; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- $attrs built from esc_url/esc_attr.
			} else {
				echo '<span class="iwsl-el-price__btn">' . esc_html( $label ) . '</span>';
			}
		}
		echo '</div>';
	}
}

/**
 * IW Notice / Badge — a small info / success / warning / error callout, with an
 * optional leading emoji/icon.
 */
final class IWSL_Widget_Notice extends IWSL_Elementor_Widget_Base {

	public function get_name() {
		return 'iwsl-notice';
	}

	public function get_title() {
		return esc_html__( 'IW Notice / Badge', 'infraweaver-connector' );
	}

	public function get_icon() {
		return 'eicon-alert';
	}

	public function get_keywords() {
		return array( 'infraweaver', 'notice', 'badge', 'alert', 'callout' );
	}

	/** The allowed notice types → their default emoji, used at render. */
	public static function notice_types(): array {
		return array(
			'info'    => 'ℹ️',
			'success' => '✅',
			'warning' => '⚠️',
			'error'   => '⛔',
		);
	}

	protected function register_controls() {
		$this->start_controls_section(
			'content',
			array(
				'label' => esc_html__( 'Content', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_CONTENT,
			)
		);

		$this->add_control(
			'type',
			array(
				'label'   => esc_html__( 'Type', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::SELECT,
				'default' => 'info',
				'options' => array(
					'info'    => esc_html__( 'Info', 'infraweaver-connector' ),
					'success' => esc_html__( 'Success', 'infraweaver-connector' ),
					'warning' => esc_html__( 'Warning', 'infraweaver-connector' ),
					'error'   => esc_html__( 'Error', 'infraweaver-connector' ),
				),
			)
		);

		$this->add_control(
			'icon',
			array(
				'label'       => esc_html__( 'Icon (emoji or text)', 'infraweaver-connector' ),
				'type'        => \Elementor\Controls_Manager::TEXT,
				'default'     => '',
				'description' => esc_html__( 'Leave blank to use the default icon for the chosen type.', 'infraweaver-connector' ),
			)
		);

		$this->add_control(
			'message',
			array(
				'label'   => esc_html__( 'Message', 'infraweaver-connector' ),
				'type'    => \Elementor\Controls_Manager::TEXTAREA,
				'default' => esc_html__( 'This is a notice your visitors will see.', 'infraweaver-connector' ),
			)
		);

		$this->end_controls_section();

		$this->start_controls_section(
			'style',
			array(
				'label' => esc_html__( 'Style', 'infraweaver-connector' ),
				'tab'   => \Elementor\Controls_Manager::TAB_STYLE,
			)
		);

		$this->add_control(
			'bg_color',
			array(
				'label'     => esc_html__( 'Background colour', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-notice' => 'background-color: {{VALUE}};',
				),
			)
		);

		$this->add_control(
			'text_color',
			array(
				'label'     => esc_html__( 'Text colour', 'infraweaver-connector' ),
				'type'      => \Elementor\Controls_Manager::COLOR,
				'selectors' => array(
					'{{WRAPPER}} .iwsl-el-notice' => 'color: {{VALUE}};',
				),
			)
		);

		$this->end_controls_section();
	}

	protected function render() {
		$s       = $this->get_settings_for_display();
		$type    = isset( $s['type'] ) ? (string) $s['type'] : 'info';
		$types   = self::notice_types();
		if ( ! isset( $types[ $type ] ) ) {
			$type = 'info';
		}
		$message = isset( $s['message'] ) ? (string) $s['message'] : '';
		if ( '' === $message ) {
			return;
		}
		$icon = isset( $s['icon'] ) && '' !== $s['icon'] ? (string) $s['icon'] : $types[ $type ];

		echo '<div class="iwsl-el-notice iwsl-el-notice--' . esc_attr( $type ) . '" role="note">';
		echo '<span class="iwsl-el-notice__icon" aria-hidden="true">' . esc_html( $icon ) . '</span> ';
		echo '<span class="iwsl-el-notice__msg">' . esc_html( $message ) . '</span>';
		echo '</div>';
	}
}
