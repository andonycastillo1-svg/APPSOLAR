import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ProveedorSesion } from './lib/auth';
import { ErrorApi } from './lib/api';
import './styles/global.css';
import './styles/rediseno.css';
import { iniciarTema } from './lib/tema';

// El tema se fija antes del primer pintado para evitar el parpadeo claro/oscuro.
iniciarTema();

const clienteConsultas = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (intentos, error) => {
        // Nunca se reintenta ante fallos de autorizacion o validacion.
        if (error instanceof ErrorApi && error.estado < 500) return false;
        return intentos < 2;
      },
    },
    mutations: { retry: false },
  },
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={clienteConsultas}>
      <ProveedorSesion>
        <App />
      </ProveedorSesion>
    </QueryClientProvider>
  </React.StrictMode>,
);
