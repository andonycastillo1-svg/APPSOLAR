import { useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, descargar, ErrorApi } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { useCatalogos } from '../hooks/useCatalogos';
import { CampoArea, CampoSelect, CampoTexto } from '../components/Campos';
import {
  MensajeAlerta,
  MensajeError,
  MensajeExito,
  MensajeInfo,
  Modal,
} from '../components/Estados';
import { Paginacion, Tabla } from '../components/Tabla';
import {
  claseEstado,
  fecha,
  hoyISO,
  inicioDeAnioISO,
  kwh,
  numero,
  porcentaje,
  quetzales,
  textoEstado,
} from '../lib/formato';

interface RegistroProduccion {
  id_produccion: number;
  id_proyecto: number;
  proyecto: string;
  cliente: string;
  id_inversor: number | null;
  marca: string | null;
  modelo: string | null;
  serial_externo: string | null;
  nivel_detalle: string;
  fecha: string;
  anio: number;
  mes: number;
  granularidad: string;
  kwh: number;
  origen: string;
  secuencia: number;
  costo_kwh_aplicado: number | null;
  valor_q: number | null;
  estado_valorizacion: string;
  comentarios: string | null;
}

interface Resumen {
  kwh: number;
  valor_q: number;
  registros: number;
  registrosPendientes: number;
  kwhPendientes: number;
  primeraFecha: string | null;
  ultimaFecha: string | null;
  coberturaTarifaria: {
    mesesConTarifa: Array<{ anio: number; mes: number; costo_kwh: number }>;
    mesesPendientes: Array<{ anio: number; mes: number }>;
    registrosPendientes: number;
    completa: boolean;
  };
  periodosConMezclaDeNiveles: Array<{ proyecto: string; anio: number; mes: number }>;
}

interface Comparacion {
  actual: { kwh: number; valor_q: number };
  anterior: { kwh: number; valor_q: number };
  baseComparacion: string;
  variacion: {
    kwh_absoluta: number;
    kwh_porcentual: number | null;
    valor_absoluta: number;
  };
}

export function PaginaProduccion() {
  const { puede } = useSesion();
  const catalogos = useCatalogos();

  const [filtros, setFiltros] = useState({
    desde: inicioDeAnioISO(),
    hasta: hoyISO(),
    id_cliente: '',
    id_proyecto: '',
    id_inversor: '',
  });

  const [registrar, setRegistrar] = useState<{
    id_proyecto: string;
    id_inversor: string;
    fecha: string;
    kwh: string;
    granularidad: string;
    comentarios: string;
  } | null>(null);
  const [corregir, setCorregir] = useState<{ fila: RegistroProduccion; kwh: string; motivo: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const listado = useListado<RegistroProduccion>('produccion', '/production', {
    orden: 'fecha',
    direccion: 'desc',
    ...filtros,
  });

  const resumen = useQuery({
    queryKey: ['produccion-resumen', filtros],
    queryFn: async () => (await api.obtener<Resumen>('/production/summary', filtros)).datos,
  });

  const comparacion = useQuery({
    queryKey: ['produccion-comparacion', filtros],
    queryFn: async () => (await api.obtener<Comparacion>('/production/compare', filtros)).datos,
  });

  const proyectosFiltrados = useMemo(
    () => (filtros.id_cliente ? catalogos.proyectos.filter((p) => String(p.id_cliente) === filtros.id_cliente) : catalogos.proyectos),
    [catalogos.proyectos, filtros.id_cliente],
  );

  const inversoresFiltrados = useMemo(
    () => (filtros.id_proyecto ? catalogos.inversores.filter((i) => String(i.id_proyecto) === filtros.id_proyecto) : catalogos.inversores),
    [catalogos.inversores, filtros.id_proyecto],
  );

  const aplicarFiltro = (campo: string, valor: string) => {
    const siguiente = { ...filtros, [campo]: valor };
    if (campo === 'id_cliente') {
      siguiente.id_proyecto = '';
      siguiente.id_inversor = '';
    }
    if (campo === 'id_proyecto') siguiente.id_inversor = '';
    setFiltros(siguiente);
    listado.actualizar(siguiente);
  };

  const exportar = async () => {
    setError(null);
    try {
      const respuesta = await api.crear<{ id_reporte: number }>('/reports/generate', {
        tipo: 'PRODUCCION',
        nombre: `Consulta de produccion ${filtros.desde} a ${filtros.hasta}`,
        desde: filtros.desde,
        hasta: filtros.hasta,
        id_cliente: filtros.id_cliente ? Number(filtros.id_cliente) : null,
        id_proyecto: filtros.id_proyecto ? Number(filtros.id_proyecto) : null,
        granularidad: 'MENSUAL',
        guardar: true,
      });
      await descargar(`/reports/${respuesta.datos.id_reporte}/export`, { formato: 'csv' });
      setExito('La consulta se exporto como reporte en formato CSV.');
    } catch (fallo) {
      setError(fallo);
    }
  };

  const guardarRegistro = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!registrar) return;
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await api.crear<{ mensaje: string }>('/production', {
        id_proyecto: Number(registrar.id_proyecto),
        id_inversor: registrar.id_inversor ? Number(registrar.id_inversor) : null,
        fecha: registrar.fecha,
        kwh: Number(registrar.kwh),
        granularidad: registrar.granularidad,
        comentarios: registrar.comentarios || null,
      });
      setExito(respuesta.datos.mensaje);
      setRegistrar(null);
      listado.recargar();
      void resumen.refetch();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const guardarCorreccion = async (evento: FormEvent) => {
    evento.preventDefault();
    if (!corregir) return;
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await api.actualizar<{ mensaje: string }>(`/production/${corregir.fila.id_produccion}`, {
        kwh: Number(corregir.kwh),
        motivo: corregir.motivo,
      });
      setExito(respuesta.datos.mensaje);
      setCorregir(null);
      listado.recargar();
      void resumen.refetch();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  const erroresCampo = error instanceof ErrorApi ? error.erroresPorCampo : {};
  const datos = resumen.data;

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Produccion energetica</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Consulta detallada con filtros, agregacion y exportacion. Energia en kWh, valor en quetzales.
          </p>
        </div>
        <div className="acciones no-imprimir">
          {puede('reportes.exportar') ? (
            <button type="button" className="boton boton--secundario" onClick={() => void exportar()}>
              Exportar consulta
            </button>
          ) : null}
          {puede('produccion.registrar') ? (
            <button
              type="button"
              className="boton"
              onClick={() => {
                setError(null);
                setRegistrar({
                  id_proyecto: filtros.id_proyecto,
                  id_inversor: filtros.id_inversor,
                  fecha: hoyISO(),
                  kwh: '',
                  granularidad: 'DIARIA',
                  comentarios: '',
                });
              }}
            >
              Registrar produccion
            </button>
          ) : null}
        </div>
      </div>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error && !registrar && !corregir ? <MensajeError error={error} /> : null}

      <section className="tarjeta no-imprimir">
        <div className="filtros">
          <CampoTexto etiqueta="Desde" type="date" value={filtros.desde} max={filtros.hasta} onChange={(e) => aplicarFiltro('desde', e.target.value)} />
          <CampoTexto etiqueta="Hasta" type="date" value={filtros.hasta} min={filtros.desde} max={hoyISO()} onChange={(e) => aplicarFiltro('hasta', e.target.value)} />
          <CampoSelect etiqueta="Cliente" value={filtros.id_cliente} onChange={(e) => aplicarFiltro('id_cliente', e.target.value)}>
            <option value="">Todos</option>
            {catalogos.clientes.map((c) => (
              <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect etiqueta="Proyecto" value={filtros.id_proyecto} onChange={(e) => aplicarFiltro('id_proyecto', e.target.value)}>
            <option value="">Todos</option>
            {proyectosFiltrados.map((p) => (
              <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect etiqueta="Inversor" value={filtros.id_inversor} onChange={(e) => aplicarFiltro('id_inversor', e.target.value)}>
            <option value="">Todos</option>
            {inversoresFiltrados.map((i) => (
              <option key={i.id_inversor} value={i.id_inversor}>{i.marca} {i.modelo}</option>
            ))}
          </CampoSelect>
        </div>
      </section>

      {datos ? (
        <>
          {!datos.coberturaTarifaria.completa ? (
            <MensajeAlerta titulo="Cobertura tarifaria incompleta">
              {datos.coberturaTarifaria.registrosPendientes} registro(s) del periodo no tienen tarifa
              aprobada ({kwh(datos.kwhPendientes)}). Su energia es valida; unicamente falta la valorizacion.
              Meses pendientes:{' '}
              {datos.coberturaTarifaria.mesesPendientes
                .map((m) => `${String(m.mes).padStart(2, '0')}/${m.anio}`)
                .join(', ')}
              .
            </MensajeAlerta>
          ) : null}

          {datos.periodosConMezclaDeNiveles.length > 0 ? (
            <MensajeInfo titulo="Prevencion de doble conteo activa">
              En {datos.periodosConMezclaDeNiveles.length} periodo(s) coexisten consolidado de proyecto y
              detalle por inversor. Los totales usan unicamente el detalle por inversor; en la tabla se
              muestran todas las filas para su revision.
            </MensajeInfo>
          ) : null}

          <section className="rejilla">
            <div className="indicador">
              <p className="indicador__etiqueta">Produccion total</p>
              <p className="indicador__valor">{kwh(datos.kwh)}</p>
              <p className="indicador__detalle">{datos.registros} registro(s)</p>
            </div>
            <div className={datos.coberturaTarifaria.completa ? 'indicador indicador--verde' : 'indicador indicador--ambar'}>
              <p className="indicador__etiqueta">Valor total</p>
              <p className="indicador__valor">{quetzales(datos.valor_q)}</p>
              <p className="indicador__detalle">
                {datos.coberturaTarifaria.mesesConTarifa.length} mes(es) con tarifa aprobada
              </p>
            </div>
            <div className="indicador">
              <p className="indicador__etiqueta">Periodo con datos</p>
              <p className="indicador__valor" style={{ fontSize: '1.05rem' }}>
                {fecha(datos.primeraFecha)} – {fecha(datos.ultimaFecha)}
              </p>
            </div>
            {comparacion.data ? (
              <div
                className={
                  comparacion.data.variacion.kwh_porcentual === null
                    ? 'indicador'
                    : comparacion.data.variacion.kwh_porcentual >= 0
                      ? 'indicador indicador--verde'
                      : 'indicador indicador--rojo'
                }
              >
                <p className="indicador__etiqueta">Variacion vs. periodo anterior</p>
                <p className="indicador__valor">{porcentaje(comparacion.data.variacion.kwh_porcentual)}</p>
                <p className="indicador__detalle">{comparacion.data.baseComparacion}</p>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      <section className="tarjeta">
        <Tabla<RegistroProduccion>
          titulo="Registros de produccion"
          descripcion="Cada registro conserva la tarifa aplicada y su estado de valorizacion."
          columnas={[
            { clave: 'fecha', titulo: 'Fecha', orden: 'fecha', render: (f) => fecha(f.fecha) },
            { clave: 'proyecto', titulo: 'Proyecto', orden: 'proyecto', render: (f) => f.proyecto },
            {
              clave: 'origen_dato',
              titulo: 'Nivel / equipo',
              render: (f) =>
                f.id_inversor ? (
                  <>
                    {f.marca} {f.modelo}
                    {f.serial_externo ? <span style={{ color: 'var(--texto-suave)' }}> ({f.serial_externo})</span> : null}
                  </>
                ) : (
                  <span className="etiqueta etiqueta--gris">Consolidado del proyecto</span>
                ),
            },
            {
              clave: 'granularidad',
              titulo: 'Granularidad',
              render: (f) => (
                <>
                  {textoEstado(f.granularidad)}
                  {f.secuencia > 0 ? (
                    <span className="etiqueta etiqueta--azul" style={{ marginLeft: '0.3rem' }}>
                      Componente {f.secuencia + 1}
                    </span>
                  ) : null}
                </>
              ),
            },
            { clave: 'kwh', titulo: 'Energia', orden: 'kwh', numerica: true, render: (f) => kwh(f.kwh) },
            {
              clave: 'tarifa',
              titulo: 'Tarifa aplicada',
              numerica: true,
              render: (f) =>
                f.costo_kwh_aplicado === null ? (
                  <span style={{ color: 'var(--texto-suave)' }}>—</span>
                ) : (
                  numero(f.costo_kwh_aplicado, 6)
                ),
            },
            {
              clave: 'valor',
              titulo: 'Valor',
              orden: 'valor',
              numerica: true,
              render: (f) =>
                f.estado_valorizacion === 'PENDIENTE_DE_TARIFA' ? (
                  <span className="etiqueta etiqueta--ambar">Pendiente de tarifa</span>
                ) : (
                  quetzales(f.valor_q)
                ),
            },
            {
              clave: 'origen',
              titulo: 'Origen',
              render: (f) => <span className={claseEstado(f.origen)}>{textoEstado(f.origen)}</span>,
            },
            { clave: 'comentarios', titulo: 'Comentarios', render: (f) => f.comentarios ?? '—' },
            ...(puede('produccion.corregir')
              ? [
                  {
                    clave: 'acciones',
                    titulo: 'Acciones',
                    render: (f: RegistroProduccion) => (
                      <button
                        type="button"
                        className="boton boton--secundario boton--pequeno no-imprimir"
                        onClick={() => {
                          setError(null);
                          setCorregir({ fila: f, kwh: String(f.kwh), motivo: '' });
                        }}
                      >
                        Corregir
                      </button>
                    ),
                  },
                ]
              : []),
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_produccion}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          ordenActual={listado.estado.orden}
          direccionActual={listado.estado.direccion}
          alOrdenar={listado.ordenar}
          vacioTitulo="No hay produccion en el periodo seleccionado"
          vacioDescripcion="Ajuste los filtros, cargue un archivo historico o ejecute una sincronizacion."
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>

      {/* --------------------------- Registro manual --------------------------- */}
      {registrar ? (
        <Modal titulo="Registrar produccion manualmente" alCerrar={() => setRegistrar(null)}>
          {error ? <MensajeError error={error} /> : null}
          <MensajeInfo>
            Si no selecciona un inversor, el registro se guardara como{' '}
            <strong>consolidado del proyecto</strong>. El sistema impide mezclar ambos niveles en un mismo
            mes para no duplicar la energia.
          </MensajeInfo>
          <form onSubmit={guardarRegistro} noValidate>
            <div className="formulario">
              <CampoSelect
                etiqueta="Proyecto"
                obligatorio
                value={registrar.id_proyecto}
                error={erroresCampo.id_proyecto}
                onChange={(e) => setRegistrar({ ...registrar, id_proyecto: e.target.value, id_inversor: '' })}
              >
                <option value="">Seleccione un proyecto</option>
                {catalogos.proyectos.map((p) => (
                  <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
                ))}
              </CampoSelect>
              <CampoSelect
                etiqueta="Inversor"
                value={registrar.id_inversor}
                ayuda="Opcional: dejelo vacio para registrar el consolidado del proyecto."
                onChange={(e) => setRegistrar({ ...registrar, id_inversor: e.target.value })}
              >
                <option value="">Consolidado del proyecto</option>
                {catalogos.inversores
                  .filter((i) => String(i.id_proyecto) === registrar.id_proyecto)
                  .map((i) => (
                    <option key={i.id_inversor} value={i.id_inversor}>{i.marca} {i.modelo}</option>
                  ))}
              </CampoSelect>
              <CampoSelect
                etiqueta="Granularidad"
                value={registrar.granularidad}
                onChange={(e) => setRegistrar({ ...registrar, granularidad: e.target.value })}
              >
                <option value="DIARIA">Diaria</option>
                <option value="MENSUAL">Mensual (se ancla al dia 1)</option>
              </CampoSelect>
              <CampoTexto
                etiqueta="Fecha"
                type="date"
                obligatorio
                max={hoyISO()}
                value={registrar.fecha}
                error={erroresCampo.fecha}
                onChange={(e) => setRegistrar({ ...registrar, fecha: e.target.value })}
              />
              <CampoTexto
                etiqueta="Energia generada (kWh)"
                type="number"
                min="0"
                step="0.0001"
                obligatorio
                value={registrar.kwh}
                error={erroresCampo.kwh}
                ayuda="No se aceptan valores negativos."
                onChange={(e) => setRegistrar({ ...registrar, kwh: e.target.value })}
              />
              <CampoArea
                etiqueta="Comentarios"
                value={registrar.comentarios}
                onChange={(e) => setRegistrar({ ...registrar, comentarios: e.target.value })}
              />
            </div>
            <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button type="button" className="boton boton--secundario" onClick={() => setRegistrar(null)}>
                Cancelar
              </button>
              <button type="submit" className="boton" disabled={ocupado}>
                {ocupado ? 'Guardando...' : 'Registrar'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* --------------------------- Correccion --------------------------- */}
      {corregir ? (
        <Modal titulo="Corregir registro de produccion" alCerrar={() => setCorregir(null)}>
          {error ? <MensajeError error={error} /> : null}
          <MensajeAlerta titulo="Correccion auditada">
            El valor en quetzales se recalcula automaticamente con la tarifa del mes del registro: nunca se
            edita a mano. Se conservara el valor anterior y el nuevo en la bitacora de auditoria.
          </MensajeAlerta>
          <form onSubmit={guardarCorreccion} noValidate>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem', fontSize: '0.86rem', marginBottom: '0.9rem' }}>
              <dt style={{ fontWeight: 640 }}>Proyecto</dt>
              <dd style={{ margin: 0 }}>{corregir.fila.proyecto}</dd>
              <dt style={{ fontWeight: 640 }}>Fecha</dt>
              <dd style={{ margin: 0 }}>{fecha(corregir.fila.fecha)}</dd>
              <dt style={{ fontWeight: 640 }}>Valor actual</dt>
              <dd style={{ margin: 0 }}>
                {kwh(corregir.fila.kwh)} · {quetzales(corregir.fila.valor_q)}
              </dd>
            </dl>
            <div className="formulario">
              <CampoTexto
                etiqueta="Nueva energia (kWh)"
                type="number"
                min="0"
                step="0.0001"
                obligatorio
                value={corregir.kwh}
                error={erroresCampo.kwh}
                onChange={(e) => setCorregir({ ...corregir, kwh: e.target.value })}
              />
              <CampoArea
                etiqueta="Motivo de la correccion"
                obligatorio
                value={corregir.motivo}
                error={erroresCampo.motivo}
                ayuda="Minimo 10 caracteres. Queda registrado en la auditoria."
                onChange={(e) => setCorregir({ ...corregir, motivo: e.target.value })}
              />
            </div>
            <div className="acciones" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button type="button" className="boton boton--secundario" onClick={() => setCorregir(null)}>
                Cancelar
              </button>
              <button type="submit" className="boton boton--peligro" disabled={ocupado || corregir.motivo.trim().length < 10}>
                {ocupado ? 'Guardando...' : 'Confirmar correccion'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
