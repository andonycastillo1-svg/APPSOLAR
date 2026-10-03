import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useListado } from '../hooks/useListado';
import { CampoSelect, CampoTexto } from '../components/Campos';
import { MensajeInfo, Modal } from '../components/Estados';
import { Paginacion, Tabla } from '../components/Tabla';
import { fechaHora, hoyISO, textoEstado } from '../lib/formato';

interface Entrada {
  id_auditoria: number;
  id_usuario: number | null;
  usuario_email: string | null;
  usuario_nombre: string | null;
  accion: string;
  entidad: string;
  id_entidad: string | null;
  resultado: 'EXITO' | 'FALLO';
  datos_antes: unknown;
  datos_despues: unknown;
  motivo: string | null;
  ip: string | null;
  correlation_id: string | null;
  created_at: string;
}

export function PaginaAuditoria() {
  const [detalle, setDetalle] = useState<Entrada | null>(null);
  const listado = useListado<Entrada>('auditoria', '/audit', { porPagina: 30 });

  const catalogos = useQuery({
    queryKey: ['auditoria-catalogos'],
    queryFn: async () =>
      (await api.obtener<{ acciones: Array<{ accion: string }>; entidades: Array<{ entidad: string }> }>(
        '/audit/acciones',
      )).datos,
  });

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Bitacora de auditoria</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Registro de accesos, cambios de permisos, operaciones sensibles, cargas, correcciones,
            sincronizaciones y generacion de reportes.
          </p>
        </div>
      </div>

      <MensajeInfo>
        Por politica de seguridad, la auditoria <strong>nunca</strong> registra contraseñas, tokens ni el
        contenido completo de los archivos. Los campos sensibles aparecen como <code>[REDACTADO]</code>.
      </MensajeInfo>

      <section className="tarjeta">
        <div className="filtros no-imprimir">
          <CampoTexto
            etiqueta="Buscar"
            type="search"
            placeholder="Correo, motivo o identificador"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
          <CampoSelect
            etiqueta="Accion"
            value={String(listado.estado.accion ?? '')}
            onChange={(e) => listado.actualizar({ accion: e.target.value })}
          >
            <option value="">Todas</option>
            {catalogos.data?.acciones.map((a) => (
              <option key={a.accion} value={a.accion}>{a.accion}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Entidad"
            value={String(listado.estado.entidad ?? '')}
            onChange={(e) => listado.actualizar({ entidad: e.target.value })}
          >
            <option value="">Todas</option>
            {catalogos.data?.entidades.map((e) => (
              <option key={e.entidad} value={e.entidad}>{e.entidad}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Resultado"
            value={String(listado.estado.resultado ?? '')}
            onChange={(e) => listado.actualizar({ resultado: e.target.value })}
          >
            <option value="">Todos</option>
            <option value="EXITO">Exito</option>
            <option value="FALLO">Fallo</option>
          </CampoSelect>
          <CampoTexto
            etiqueta="Desde"
            type="date"
            max={hoyISO()}
            value={String(listado.estado.desde ?? '')}
            onChange={(e) => listado.actualizar({ desde: e.target.value })}
          />
          <CampoTexto
            etiqueta="Hasta"
            type="date"
            max={hoyISO()}
            value={String(listado.estado.hasta ?? '')}
            onChange={(e) => listado.actualizar({ hasta: e.target.value })}
          />
        </div>

        <Tabla<Entrada>
          titulo="Eventos registrados"
          descripcion="Ordenados del mas reciente al mas antiguo."
          columnas={[
            { clave: 'fecha', titulo: 'Fecha y hora', render: (f) => fechaHora(f.created_at) },
            {
              clave: 'usuario',
              titulo: 'Usuario',
              render: (f) => f.usuario_nombre ?? f.usuario_email ?? 'Sistema',
            },
            { clave: 'accion', titulo: 'Accion', render: (f) => f.accion },
            {
              clave: 'entidad',
              titulo: 'Entidad',
              render: (f) => (
                <>
                  {f.entidad}
                  {f.id_entidad ? <span style={{ color: 'var(--texto-suave)' }}> #{f.id_entidad}</span> : null}
                </>
              ),
            },
            {
              clave: 'resultado',
              titulo: 'Resultado',
              render: (f) => (
                <span className={f.resultado === 'EXITO' ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--rojo'}>
                  {textoEstado(f.resultado)}
                </span>
              ),
            },
            { clave: 'motivo', titulo: 'Motivo', render: (f) => f.motivo ?? '—' },
            { clave: 'ip', titulo: 'Origen', render: (f) => f.ip ?? '—' },
            {
              clave: 'acciones',
              titulo: 'Detalle',
              render: (f) => (
                <button
                  type="button"
                  className="boton boton--secundario boton--pequeno no-imprimir"
                  onClick={() => setDetalle(f)}
                >
                  Ver cambios
                </button>
              ),
            },
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_auditoria}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          vacioTitulo="No hay eventos que coincidan con los filtros"
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>

      {detalle ? (
        <Modal titulo="Detalle del evento auditado" ancho alCerrar={() => setDetalle(null)}>
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem', fontSize: '0.87rem' }}>
            <dt style={{ fontWeight: 640 }}>Fecha</dt>
            <dd style={{ margin: 0 }}>{fechaHora(detalle.created_at)}</dd>
            <dt style={{ fontWeight: 640 }}>Usuario</dt>
            <dd style={{ margin: 0 }}>
              {detalle.usuario_nombre ?? 'Sistema'} {detalle.usuario_email ? `(${detalle.usuario_email})` : ''}
            </dd>
            <dt style={{ fontWeight: 640 }}>Accion</dt>
            <dd style={{ margin: 0 }}>{detalle.accion}</dd>
            <dt style={{ fontWeight: 640 }}>Entidad</dt>
            <dd style={{ margin: 0 }}>
              {detalle.entidad} {detalle.id_entidad ? `#${detalle.id_entidad}` : ''}
            </dd>
            <dt style={{ fontWeight: 640 }}>Motivo</dt>
            <dd style={{ margin: 0 }}>{detalle.motivo ?? '—'}</dd>
            <dt style={{ fontWeight: 640 }}>Origen</dt>
            <dd style={{ margin: 0 }}>{detalle.ip ?? '—'}</dd>
            <dt style={{ fontWeight: 640 }}>Correlacion</dt>
            <dd style={{ margin: 0, fontFamily: 'monospace', fontSize: '0.78rem' }}>
              {detalle.correlation_id ?? '—'}
            </dd>
          </dl>

          <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', marginTop: '1rem' }}>
            <div>
              <h3>Antes</h3>
              <pre
                style={{
                  background: 'var(--gris-100)',
                  padding: '0.7rem',
                  borderRadius: 'var(--radio-sm)',
                  fontSize: '0.76rem',
                  overflowX: 'auto',
                  maxHeight: '320px',
                }}
              >
                {detalle.datos_antes ? JSON.stringify(detalle.datos_antes, null, 2) : 'Sin datos previos'}
              </pre>
            </div>
            <div>
              <h3>Despues</h3>
              <pre
                style={{
                  background: 'var(--verde-100)',
                  padding: '0.7rem',
                  borderRadius: 'var(--radio-sm)',
                  fontSize: '0.76rem',
                  overflowX: 'auto',
                  maxHeight: '320px',
                }}
              >
                {detalle.datos_despues ? JSON.stringify(detalle.datos_despues, null, 2) : 'Sin datos posteriores'}
              </pre>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
