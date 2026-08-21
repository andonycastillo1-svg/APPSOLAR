import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useSesion } from './lib/auth';
import { Layout } from './components/Layout';
import { Cargando, SinPermiso } from './components/Estados';

import { PaginaIngreso } from './pages/Ingreso';
import { PaginaPerfil } from './pages/Perfil';
import { PaginaTablero } from './pages/Tablero';
import { PaginaResumenAnual } from './pages/ResumenAnual';
import { PaginaClientes } from './pages/Clientes';
import { PaginaProyectos } from './pages/Proyectos';
import { PaginaProyectoDetalle } from './pages/ProyectoDetalle';
import { PaginaInversores } from './pages/Inversores';
import { PaginaProduccion } from './pages/Produccion';
import { PaginaImportaciones } from './pages/Importaciones';
import { PaginaIntegracion } from './pages/Integracion';
import { PaginaReportes } from './pages/Reportes';
import { PaginaUsuarios } from './pages/Usuarios';
import { PaginaAuditoria } from './pages/Auditoria';
import { PaginaConfiguracion } from './pages/Configuracion';
import { PaginaEstado } from './pages/EstadoServicios';

/** Pantalla 404: ruta inexistente dentro de la navegacion autorizada. */
function NoEncontrado() {
  return (
    <div className="tarjeta">
      <div className="estado">
        <p className="estado__titulo">404 · Pagina no encontrada</p>
        <p>La direccion solicitada no existe en el sistema.</p>
        <a className="boton" href="/">
          Volver al tablero
        </a>
      </div>
    </div>
  );
}

/** Pantalla 403 accesible desde la navegacion cuando falta un permiso. */
function Prohibido() {
  return (
    <div className="tarjeta">
      <h1>403 · Acceso denegado</h1>
      <SinPermiso />
    </div>
  );
}

function Protegida({ children, permisos }: { children: ReactNode; permisos?: string[] }) {
  const { usuario, cargando, puedeAlguno } = useSesion();
  const ubicacion = useLocation();

  if (cargando) return <Cargando mensaje="Verificando su sesion..." />;
  // 401: sin sesion valida se envia al ingreso conservando el destino.
  if (!usuario) return <Navigate to="/ingresar" state={{ desde: ubicacion.pathname }} replace />;
  if (permisos && !puedeAlguno(...permisos)) return <Prohibido />;

  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/ingresar" element={<PaginaIngreso />} />

        <Route
          element={
            <Protegida>
              <Layout />
            </Protegida>
          }
        >
          <Route path="/" element={<Protegida permisos={['dashboard.ver']}><PaginaTablero /></Protegida>} />
          <Route path="/resumen-anual" element={<Protegida permisos={['produccion.ver']}><PaginaResumenAnual /></Protegida>} />
          <Route path="/produccion" element={<Protegida permisos={['produccion.ver']}><PaginaProduccion /></Protegida>} />
          <Route path="/importaciones" element={<Protegida permisos={['importaciones.ver']}><PaginaImportaciones /></Protegida>} />
          <Route path="/integracion" element={<Protegida permisos={['huawei.ver']}><PaginaIntegracion /></Protegida>} />
          <Route path="/clientes" element={<Protegida permisos={['clientes.ver']}><PaginaClientes /></Protegida>} />
          <Route path="/proyectos" element={<Protegida permisos={['proyectos.ver']}><PaginaProyectos /></Protegida>} />
          <Route path="/proyectos/:id" element={<Protegida permisos={['proyectos.ver']}><PaginaProyectoDetalle /></Protegida>} />
          <Route path="/inversores" element={<Protegida permisos={['inversores.ver']}><PaginaInversores /></Protegida>} />
          <Route path="/reportes" element={<Protegida permisos={['reportes.ver']}><PaginaReportes /></Protegida>} />
          <Route path="/usuarios" element={<Protegida permisos={['usuarios.ver']}><PaginaUsuarios /></Protegida>} />
          <Route path="/auditoria" element={<Protegida permisos={['auditoria.ver']}><PaginaAuditoria /></Protegida>} />
          <Route path="/configuracion" element={<Protegida permisos={['config.ver']}><PaginaConfiguracion /></Protegida>} />
          <Route path="/estado" element={<Protegida permisos={['salud.ver']}><PaginaEstado /></Protegida>} />
          <Route path="/perfil" element={<PaginaPerfil />} />
          <Route path="/sin-permisos" element={<Prohibido />} />
          <Route path="*" element={<NoEncontrado />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
