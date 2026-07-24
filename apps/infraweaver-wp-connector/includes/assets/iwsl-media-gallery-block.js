/**
 * iwsl-media-gallery-block — the no-build editor registration for the dynamic
 * Gutenberg block `infraweaver/media-gallery`.
 *
 * The block is SERVER-RENDERED (save returns null; PHP's render_callback emits the
 * gallery through the ONE shared renderer), so this script only teaches the editor
 * how to show a placeholder and an inspector of controls. It uses the global `wp`
 * runtime (wp.blocks / wp.element / wp.blockEditor / wp.components / wp.i18n) — no
 * JSX, no bundler. The attribute set mirrors IWSL_Media_Gallery::block_attributes().
 */
( function ( wp ) {
  if ( ! wp || ! wp.blocks || ! wp.element ) {
    return;
  }
  var el = wp.element.createElement;
  var __ = wp.i18n && wp.i18n.__ ? wp.i18n.__ : function ( s ) { return s; };
  var blockEditor = wp.blockEditor || wp.editor || {};
  var InspectorControls = blockEditor.InspectorControls || function () { return null; };
  var components = wp.components || {};
  var PanelBody = components.PanelBody || function ( p ) { return el( "div", null, p.children ); };
  var TextControl = components.TextControl || function () { return null; };
  var RangeControl = components.RangeControl || function () { return null; };
  var SelectControl = components.SelectControl || function () { return null; };
  var ToggleControl = components.ToggleControl || function () { return null; };

  wp.blocks.registerBlockType( "infraweaver/media-gallery", {
    title: __( "IWSL Media Gallery (by tag)", "infraweaver-connector" ),
    description: __( "A gallery of every image carrying a chosen tag.", "infraweaver-connector" ),
    icon: "format-gallery",
    category: "media",
    keywords: [ __( "gallery", "infraweaver-connector" ), __( "tag", "infraweaver-connector" ), "infraweaver" ],
    attributes: {
      tag: { type: "string", default: "" },
      columns: { type: "number", default: 3 },
      size: { type: "string", default: "medium" },
      orderby: { type: "string", default: "date" },
      order: { type: "string", default: "desc" },
      limit: { type: "number", default: 24 },
      lightbox: { type: "boolean", default: true },
      captions: { type: "boolean", default: false }
    },
    edit: function ( props ) {
      var a = props.attributes;
      var set = function ( key ) {
        return function ( value ) {
          var patch = {};
          patch[ key ] = value;
          props.setAttributes( patch );
        };
      };

      var inspector = el(
        InspectorControls,
        null,
        el(
          PanelBody,
          { title: __( "Gallery", "infraweaver-connector" ), initialOpen: true },
          el( TextControl, {
            label: __( "Tag (slug or name)", "infraweaver-connector" ),
            value: a.tag,
            onChange: set( "tag" ),
            help: __( "Tag an image with this and it appears here automatically.", "infraweaver-connector" )
          } ),
          el( RangeControl, { label: __( "Columns", "infraweaver-connector" ), value: a.columns, onChange: set( "columns" ), min: 1, max: 6 } ),
          el( SelectControl, {
            label: __( "Image size", "infraweaver-connector" ),
            value: a.size,
            onChange: set( "size" ),
            options: [
              { label: __( "Thumbnail", "infraweaver-connector" ), value: "thumbnail" },
              { label: __( "Medium", "infraweaver-connector" ), value: "medium" },
              { label: __( "Medium Large", "infraweaver-connector" ), value: "medium_large" },
              { label: __( "Large", "infraweaver-connector" ), value: "large" },
              { label: __( "Full", "infraweaver-connector" ), value: "full" }
            ]
          } ),
          el( SelectControl, {
            label: __( "Order by", "infraweaver-connector" ),
            value: a.orderby,
            onChange: set( "orderby" ),
            options: [
              { label: __( "Date", "infraweaver-connector" ), value: "date" },
              { label: __( "Title", "infraweaver-connector" ), value: "title" },
              { label: __( "Menu order", "infraweaver-connector" ), value: "menu_order" },
              { label: __( "Random", "infraweaver-connector" ), value: "rand" }
            ]
          } ),
          el( SelectControl, {
            label: __( "Order", "infraweaver-connector" ),
            value: a.order,
            onChange: set( "order" ),
            options: [
              { label: __( "Descending", "infraweaver-connector" ), value: "desc" },
              { label: __( "Ascending", "infraweaver-connector" ), value: "asc" }
            ]
          } ),
          el( RangeControl, { label: __( "Maximum images", "infraweaver-connector" ), value: a.limit, onChange: set( "limit" ), min: 1, max: 200 } ),
          el( ToggleControl, { label: __( "Lightbox", "infraweaver-connector" ), checked: !! a.lightbox, onChange: set( "lightbox" ) } ),
          el( ToggleControl, { label: __( "Captions", "infraweaver-connector" ), checked: !! a.captions, onChange: set( "captions" ) } )
        )
      );

      var label = a.tag
        ? __( "IWSL Media Gallery — tag: ", "infraweaver-connector" ) + a.tag
        : __( "IWSL Media Gallery — choose a tag in the sidebar.", "infraweaver-connector" );
      var placeholder = el(
        "div",
        { className: "iwsl-gallery-placeholder", style: { padding: "24px", border: "1px dashed #c3c4c7", textAlign: "center", color: "#646970", font: "14px/1.5 system-ui, sans-serif" } },
        label
      );

      return el( wp.element.Fragment, null, inspector, placeholder );
    },
    save: function () {
      return null; // dynamic — the server render_callback owns the output.
    }
  } );
} )( window.wp );
