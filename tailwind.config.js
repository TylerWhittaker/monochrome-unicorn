/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.html', './src/**/*.js'],
  theme: {
    extend: {
      colors: {
        ink: {
          50:  '#f6f7f8',
          100: '#eceef1',
          200: '#d6dae1',
          300: '#b2bac6',
          400: '#8794a6',
          500: '#67748a',
          600: '#525d72',
          700: '#434c5d',
          800: '#3a414e',
          900: '#0f1115',
          950: '#0a0c0f',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
