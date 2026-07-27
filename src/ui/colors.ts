/**
 * Concrete color values for gutter artwork.
 *
 * Everything drawn with a VS Code API that accepts a `ThemeColor` — overview ruler marks,
 * backgrounds, annotation text — uses one, so themes and user overrides apply. Gutter
 * icons are the exception: they are SVG images, and an image cannot reference a theme
 * color. So the palette is mirrored here in hex, keyed by theme kind, and the decorations
 * are rebuilt whenever the active theme changes.
 *
 * These values must stay in step with the `contributes.colors` defaults in package.json.
 */

import * as vscode from 'vscode';
import { HUE_COUNT } from '../model/palette.js';

interface Palette {
  hues: string[];
  collision: string;
  nearMiss: string;
}

const DARK: Palette = {
  hues: [
    '#4aa8ff',
    '#4ad6b8',
    '#b98bff',
    '#ffb454',
    '#ff85b5',
    '#8fd14f',
    '#5fd0e8',
    '#f5866b'
  ],
  collision: '#ffa657',
  nearMiss: '#d0a85c'
};

const LIGHT: Palette = {
  hues: [
    '#0a66c2',
    '#0e8a72',
    '#7a3fd6',
    '#a35c00',
    '#bf2f68',
    '#4f7d1e',
    '#0d7b96',
    '#c2400f'
  ],
  collision: '#b5540b',
  nearMiss: '#8a6a1f'
};

const HIGH_CONTRAST_DARK: Palette = {
  hues: [
    '#7cc4ff',
    '#7ce9d2',
    '#d1b3ff',
    '#ffcb85',
    '#ffadcd',
    '#b3e37f',
    '#93e2f2',
    '#ffab96'
  ],
  collision: '#ffc48a',
  nearMiss: '#e6c68a'
};

const HIGH_CONTRAST_LIGHT: Palette = {
  hues: [
    '#00459e',
    '#00614f',
    '#5a1fb0',
    '#7a4200',
    '#94154a',
    '#375c10',
    '#005a70',
    '#96300a'
  ],
  collision: '#8a3f06',
  nearMiss: '#6b5010'
};

export function activePalette(): Palette {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return LIGHT;
    case vscode.ColorThemeKind.HighContrast:
      return HIGH_CONTRAST_DARK;
    case vscode.ColorThemeKind.HighContrastLight:
      return HIGH_CONTRAST_LIGHT;
    default:
      return DARK;
  }
}

export function hueHex(slot: number): string {
  return activePalette().hues[slot % HUE_COUNT];
}

export function collisionHex(): string {
  return activePalette().collision;
}

export function nearMissHex(): string {
  return activePalette().nearMiss;
}

/** Theme color reference, for the APIs that accept one. */
export function themeColor(id: string): vscode.ThemeColor {
  return new vscode.ThemeColor(id);
}
