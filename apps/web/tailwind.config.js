// apps/web/tailwind.config.js
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Pale-blue page canvas (poster background)
        canvas: {
          DEFAULT: '#CBE5FF',
          deep: '#B4D7FB',
          soft: '#E3F0FF',
          mist: '#F2F8FF',
        },
        // Navy ink scale for type on light surfaces
        ink: {
          DEFAULT: '#0A1633',
          soft: '#44547A',
          faint: '#7987A6',
          line: '#D3E2F6',
        },
        // Electric indigo — the poster's blue card / primary brand
        brand: {
          50: '#EFF3FF',
          100: '#DFE6FF',
          200: '#C3CEFE',
          300: '#9CADFC',
          400: '#6E82F8',
          500: '#3D57F5',
          600: '#2A41E0',
          700: '#1F31B8',
          800: '#182794',
          900: '#131E71',
        },
        accent: '#3D57F5',
        allow: '#0E9F6E',
        review: '#B45309',
        block: '#DC2626',
        // Legacy names kept so any missed class stays light instead of black
        surface: {
          950: '#FFFFFF',
          900: '#FFFFFF',
          800: '#F3F7FF',
          700: '#E7F0FE',
          600: '#D8E6FA',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        panel: '28px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(10,22,51,0.05), 0 8px 24px -12px rgba(10,22,51,0.18)',
        panel: '0 24px 60px -28px rgba(31,49,184,0.55)',
        lift: '0 2px 4px rgba(10,22,51,0.06), 0 18px 40px -20px rgba(10,22,51,0.28)',
      },
      letterSpacing: {
        tightest: '-0.045em',
      },
    },
  },
  plugins: [],
};
