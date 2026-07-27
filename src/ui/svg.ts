/**
 * Gutter artwork, generated as data URIs.
 *
 * The visual language, in one place:
 *
 *   │   ambient      a quiet vertical ray in the collaborator's hue
 *   ┃   emphasis     the same ray, full strength, used for the brief arrival flash
 *   ▸   seam         a wedge pointing at the seam where lines were inserted
 *   ◆   collision    the ray plus a solid diamond — your edit and theirs meet here
 *
 * When several collaborators touch one line the ray splits into stacked segments, so a
 * line worked by three people reads as three colors without any extra chrome.
 */

import * as vscode from 'vscode';

const SIZE = 16;
const BAR_X = 6;
const BAR_WIDTH = 3.2;
const RADIUS = 1.6;

function toUri(svg: string): vscode.Uri {
  // Base64 rather than percent-encoding: shorter, and immune to the quoting differences
  // between platforms when the URI is handed back to the renderer.
  return vscode.Uri.parse(
    `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  );
}

function wrap(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

/**
 * A vertical ray, split evenly when more than one collaborator is involved.
 *
 * `opacity` is what separates ambient presence from emphasis: the same shape, dimmed, so
 * the eye can tell "someone is working here" from "this needs you" without decoding a
 * new symbol.
 */
export function rayIcon(hexColors: readonly string[], opacity: number): vscode.Uri {
  const colors = hexColors.length > 0 ? hexColors : ['#888888'];
  const segmentHeight = SIZE / colors.length;

  const segments = colors
    .map((color, index) => {
      const y = index * segmentHeight;
      // Only the outermost segments get rounded ends, so a split ray still reads as one bar.
      const isFirst = index === 0;
      const isLast = index === colors.length - 1;
      const radius = isFirst || isLast ? RADIUS : 0;
      return `<rect x="${BAR_X}" y="${y}" width="${BAR_WIDTH}" height="${segmentHeight}" rx="${radius}" fill="${color}"/>`;
    })
    .join('');

  return toUri(wrap(`<g opacity="${opacity}">${segments}</g>`));
}

/**
 * A wedge marking the seam where a collaborator inserted lines.
 *
 * Additions do not occupy any line in your copy, so drawing a bar would falsely claim
 * whatever line happens to sit at that seam. The wedge points at the boundary instead.
 */
export function seamIcon(hexColor: string, opacity: number): vscode.Uri {
  const body = `<g opacity="${opacity}"><path d="M${BAR_X} 1.5 L${BAR_X + 5} 5 L${BAR_X} 8.5 Z" fill="${hexColor}"/></g>`;
  return toUri(wrap(body));
}

/**
 * The collision mark: the collaborator's ray with a solid diamond over it.
 *
 * Deliberately the only filled shape in the set — it is the one state that means you
 * should look now, so it must be distinguishable at a glance and even without color.
 */
export function collisionIcon(hexColors: readonly string[], accent: string): vscode.Uri {
  const colors = hexColors.length > 0 ? hexColors : [accent];
  const segmentHeight = SIZE / colors.length;

  const bar = colors
    .map((color, index) => {
      const y = index * segmentHeight;
      return `<rect x="${BAR_X}" y="${y}" width="${BAR_WIDTH}" height="${segmentHeight}" fill="${color}"/>`;
    })
    .join('');

  const cx = BAR_X + BAR_WIDTH / 2;
  const diamond = `<path d="M${cx} 4 L${cx + 4} 8 L${cx} 12 L${cx - 4} 8 Z" fill="${accent}" stroke="${accent}" stroke-width="0.5"/>`;

  return toUri(wrap(`<g opacity="0.9">${bar}</g>${diamond}`));
}

/** A hollow diamond for a near miss: the collision shape, not yet filled in. */
export function nearMissIcon(hexColors: readonly string[], accent: string): vscode.Uri {
  const colors = hexColors.length > 0 ? hexColors : [accent];
  const segmentHeight = SIZE / colors.length;

  const bar = colors
    .map((color, index) => {
      const y = index * segmentHeight;
      return `<rect x="${BAR_X}" y="${y}" width="${BAR_WIDTH}" height="${segmentHeight}" fill="${color}"/>`;
    })
    .join('');

  const cx = BAR_X + BAR_WIDTH / 2;
  const diamond = `<path d="M${cx} 5 L${cx + 3} 8 L${cx} 11 L${cx - 3} 8 Z" fill="none" stroke="${accent}" stroke-width="1.2"/>`;

  return toUri(wrap(`<g opacity="0.75">${bar}</g>${diamond}`));
}
