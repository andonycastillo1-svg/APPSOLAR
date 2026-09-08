import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // Vite rechaza por defecto cualquier Host que no reconozca (proteccion
    // contra DNS rebinding). Se declara el nombre de red del equipo por si
    // alguien accede a la pagina con ese nombre en vez de con la IP.
    allowedHosts: ['AALVAREZ-PC'],
    // El proxy corre en la misma maquina que el backend: usa siempre
    // 127.0.0.1 (nunca el nombre de red, que en este equipo resuelve
    // primero a una direccion IPv6 link-local y el backend no escucha ahi).
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
});
