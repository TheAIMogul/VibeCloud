import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    // Fall back to process.env so Cloud Build's --set-build-env-vars works
    // (loadEnv only reads .env* files, not the process environment).
    const geminiKey = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    return {
      server: {
        port: 5175,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(geminiKey),
        'process.env.GEMINI_API_KEY': JSON.stringify(geminiKey)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
