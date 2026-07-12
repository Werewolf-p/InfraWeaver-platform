/**
 * Shared inline style for `<input type="range">` tracks — paints the filled
 * portion of the track up to the current value. Single copy of the
 * `sliderTrackStyle` helpers duplicated across game-hub and settings panels.
 */

/** Console accent used as the default slider fill. */
export const SLIDER_FILL_COLOR = "#0078D4";
/** Default unfilled-track color (dark surface used by the existing sliders). */
export const SLIDER_REST_COLOR = "#1a1a1a";

export function sliderTrackStyle(
  value: number,
  min: number,
  max: number,
  color: string = SLIDER_FILL_COLOR,
  restColor: string = SLIDER_REST_COLOR,
): { readonly background: string } {
  const percent = ((Math.min(Math.max(value, min), max) - min) / Math.max(max - min, 1)) * 100;
  return {
    background: `linear-gradient(90deg, ${color} 0%, ${color} ${percent}%, ${restColor} ${percent}%, ${restColor} 100%)`,
  } as const;
}
