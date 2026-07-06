/**
 * Tailwind 3 config — design tokens lifted from jules.ink's DESIGN.md.
 * `darkMode: 'class'` matches jules.ink so we can flip later if a
 * light theme ever ships; for now everything is dark.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Backgrounds
        'content-bg': '#16161a',
        'sidebar-bg': '#1e1e24',
        'label-white': '#ffffff',
        // Text
        'soft-white': '#fbfbfe',
        'slate-gray': '#72728a',
        // Accent
        primary: '#19cc61',
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
