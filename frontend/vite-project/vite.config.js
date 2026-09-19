// C:\Users\Pc\Sure2\frontend\vite-project\vite.config.js

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Esta seção é a que configura o proxy para o seu backend na porta 3010
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3010', // Endereço do seu Express/API
        changeOrigin: true, 
        secure: false,      
      }
    }
  }
});