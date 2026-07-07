/**
 * Tailwind 3 config — design tokens for the admin-playground
 * showcase. Mirrors `packages/playground/`'s palette so the
 * two surfaces feel consistent; minor adjustments for a tighter
 * showcase canvas (slightly darker bg + more contrast on dividers).
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Backgrounds
        'canvas-bg': '#0c0d10',
        'panel-bg': '#16181d',
        'sidebar-bg': '#101115',
        // Borders / dividers
        'border-soft': '#2a2d35',
        'border-strong': '#3a3d45',
        // Text
        'soft-white': '#fbfbfe',
        'soft-gray': '#c8c8d0',
        'muted-gray': '#8a8a96',
        'slate-gray': '#72728a',
        // Accent
        primary: '#19cc61',
        'primary-soft': 'rgba(25, 204, 97, 0.12)',
        // Danger
        danger: '#f0a0a0',
        'danger-soft': 'rgba(240, 160, 160, 0.12)',
      },
      fontFamily: {
        display: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
