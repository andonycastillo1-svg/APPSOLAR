import { useMemo, useState } from 'react';
import { abrirEnPestana, api, descargar } from '../lib/api';
import { useSesion } from '../lib/auth';
import { useListado } from '../hooks/useListado';
import { useCatalogos } from '../hooks/useCatalogos';
import { CampoCasilla, CampoSelect, CampoTexto } from '../components/Campos';
import { Icono } from '../components/Iconos';
import {
  MensajeAlerta,
  MensajeError,
  MensajeExito,
  MensajeInfo,
} from '../components/Estados';
import {
  GraficaBarrasComparacion,
  GraficaCumplimiento,
  GraficaDistribucion,
  GraficaMedidor,
  GraficaSerie,
} from '../components/Graficas';
import { Paginacion, Tabla } from '../components/Tabla';
import {
  anioActual,
  claseEstado,
  fecha,
  fechaHora,
  hoyISO,
  inicioDeAnioISO,
  kwh,
  numero,
  porcentaje,
  quetzales,
  textoEstado,
} from '../lib/formato';

interface ReporteGuardado {
  id_reporte: number;
  tipo: string;
  nombre: string;
  periodo_desde: string | null;
  periodo_hasta: string | null;
  cobertura_tarifaria: string;
  resumen: { kwh?: number; valor_q?: number; registros?: number; mesesPendientes?: number } | string;
  usuario: string | null;
  created_at: string;
}

interface ReporteGenerado {
  id_reporte: number | null;
  empresa: string;
  usuario: string;
  contexto: { cliente: string; proyecto: string; modalidad: string | null; anio: number };
  resumen: {
    kwh: number;
    valor_q: number;
    registros: number;
    registrosPendientes: number;
    promedioPorPeriodo: number;
    granularidad: string;
    primeraFecha: string | null;
    ultimaFecha: string | null;
  };
  comparacion: {
    baseComparacion: string;
    variacion: { kwh_absoluta: number; kwh_porcentual: number | null; valor_absoluta: number };
  };
  serie: Array<{ etiqueta: string; kwh: number; valor_q: number; pendientes: number }>;
  porProyecto: Array<{ id_proyecto: number; proyecto: string; cliente: string; kwh: number; valor_q: number; pendientes: number }>;
  porInversor: Array<{ id_inversor: number; inversor: string; proyecto: string; kwh: number; valor_q: number; ultima_fecha: string | null }>;
  cobertura: {
    /** La tarifa del kWh tiene vigencia TRIMESTRAL. */
    trimestresConTarifa: Array<{ anio: number; trimestre: number; etiqueta: string; costo_kwh: number }>;
    trimestresPendientes: Array<{ anio: number; trimestre: number; etiqueta: string }>;
    registrosPendientes: number;
    kwhPendientes: number;
    completa: boolean;
  };
  resumenAnual: { totales: Record<string, number | null> };
  desgloseMensual: Array<{
    mes: string;
    proyeccion_kwh: number | null;
    generacion_kwh: number;
    cumplimiento: number | null;
    tarifa_q_kwh: number | null;
    valor_q: number | null;
    estado: string;
  }>;
  notas: string[];
  advertenciaOficial: string | null;
  generadoEn: string;
}

export function PaginaReportes() {
  const { puede } = useSesion();
  const catalogos = useCatalogos();

  const [parametros, setParametros] = useState({
    tipo: 'PRODUCCION',
    nombre: '',
    desde: inicioDeAnioISO(),
    hasta: hoyISO(),
    id_cliente: '',
    id_proyecto: '',
    granularidad: 'MENSUAL',
    anio: String(anioActual()),
  });
  const [inversoresSeleccionados, setInversoresSeleccionados] = useState<number[]>([]);
  const [inventario, setInventario] = useState({ id_cliente: '', soloActivos: false });
  const [descargandoInventario, setDescargandoInventario] = useState(false);
  const [generado, setGenerado] = useState<ReporteGenerado | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const listado = useListado<ReporteGuardado>('reportes', '/reports', {});

  const proyectosFiltrados = useMemo(
    () => (parametros.id_cliente ? catalogos.proyectos.filter((p) => String(p.id_cliente) === parametros.id_cliente) : catalogos.proyectos),
    [catalogos.proyectos, parametros.id_cliente],
  );

  const inversoresFiltrados = useMemo(
    () => (parametros.id_proyecto ? catalogos.inversores.filter((i) => String(i.id_proyecto) === parametros.id_proyecto) : catalogos.inversores),
    [catalogos.inversores, parametros.id_proyecto],
  );

  const descargarInventario = async () => {
    setDescargandoInventario(true);
    setError(null);
    try {
      await descargar('/reports/inventory/export', {
        ...(inventario.id_cliente ? { id_cliente: inventario.id_cliente } : {}),
        solo_activos: inventario.soloActivos ? '1' : '0',
      });
    } catch (fallo) {
      setError(fallo);
    } finally {
      setDescargandoInventario(false);
    }
  };

  const generar = async () => {
    setOcupado(true);
    setError(null);
    setExito(null);
    try {
      const respuesta = await api.crear<ReporteGenerado>('/reports/generate', {
        tipo: parametros.tipo,
        nombre: parametros.nombre || undefined,
        desde: parametros.desde,
        hasta: parametros.hasta,
        id_cliente: parametros.id_cliente ? Number(parametros.id_cliente) : null,
        id_proyecto: parametros.id_proyecto ? Number(parametros.id_proyecto) : null,
        inversores: inversoresSeleccionados.length > 0 ? inversoresSeleccionados : null,
        granularidad: parametros.granularidad,
        anio: Number(parametros.anio),
        guardar: true,
      });
      setGenerado(respuesta.datos);
      setExito('Reporte generado y guardado en el historial.');
      listado.recargar();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setOcupado(false);
    }
  };

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Reportes e indicadores</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Genere, guarde, exporte e imprima reportes tecnicos, comerciales y gerenciales homogeneos.
          </p>
        </div>
        {generado ? (
          <button type="button" className="boton boton--secundario no-imprimir" onClick={() => window.print()}>
            Vista de impresion
          </button>
        ) : null}
      </div>

      {exito ? <MensajeExito>{exito}</MensajeExito> : null}
      {error ? <MensajeError error={error} /> : null}

      {puede('reportes.exportar') ? (
        <section className="tarjeta no-imprimir inventario">
          <div className="inventario__texto">
            <span className="inventario__icono">
              <Icono nombre="descargar" tamano={26} />
            </span>
            <div>
              <h2 style={{ marginBottom: '0.2rem' }}>Inventario de proyectos (stock)</h2>
              <p style={{ margin: 0, fontSize: '0.86rem', color: 'var(--texto-suave)' }}>
                Excel con el total de clientes, proyectos, grupos, inversores y paneles, la potencia
                instalada, la producción acumulada y el detalle de todo lo que lleva cada proyecto.
              </p>
            </div>
          </div>
          <div className="inventario__acciones">
            <CampoSelect
              etiqueta="Cliente"
              value={inventario.id_cliente}
              onChange={(e) => setInventario({ ...inventario, id_cliente: e.target.value })}
            >
              <option value="">Todos los clientes</option>
              {catalogos.clientes.map((c) => (
                <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
              ))}
            </CampoSelect>
            <CampoCasilla
              etiqueta="Solo proyectos activos"
              checked={inventario.soloActivos}
              onChange={(e) => setInventario({ ...inventario, soloActivos: e.target.checked })}
            />
            <button
              type="button"
              className="boton boton--verde"
              disabled={descargandoInventario}
              onClick={() => void descargarInventario()}
            >
              <Icono nombre="descargar" tamano={18} />{' '}
              {descargandoInventario ? 'Generando…' : 'Descargar inventario en Excel'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="tarjeta no-imprimir">
        <h2>Parametros del reporte</h2>
        <div className="filtros">
          <CampoSelect
            etiqueta="Tipo de reporte"
            value={parametros.tipo}
            onChange={(e) => setParametros({ ...parametros, tipo: e.target.value })}
          >
            <option value="PRODUCCION">Produccion</option>
            <option value="RESUMEN_ANUAL">Resumen anual</option>
            <option value="COMPARATIVO">Comparativo</option>
            <option value="VALORIZACION">Valorizacion economica</option>
          </CampoSelect>
          <CampoTexto
            etiqueta="Nombre del reporte"
            value={parametros.nombre}
            placeholder="Opcional"
            onChange={(e) => setParametros({ ...parametros, nombre: e.target.value })}
          />
          <CampoTexto
            etiqueta="Desde"
            type="date"
            value={parametros.desde}
            max={parametros.hasta}
            onChange={(e) => setParametros({ ...parametros, desde: e.target.value })}
          />
          <CampoTexto
            etiqueta="Hasta"
            type="date"
            value={parametros.hasta}
            min={parametros.desde}
            max={hoyISO()}
            onChange={(e) => setParametros({ ...parametros, hasta: e.target.value })}
          />
          <CampoSelect
            etiqueta="Cliente"
            value={parametros.id_cliente}
            onChange={(e) => {
              setParametros({ ...parametros, id_cliente: e.target.value, id_proyecto: '' });
              setInversoresSeleccionados([]);
            }}
          >
            <option value="">Todos los clientes</option>
            {catalogos.clientes.map((c) => (
              <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Proyecto"
            value={parametros.id_proyecto}
            onChange={(e) => {
              setParametros({ ...parametros, id_proyecto: e.target.value });
              setInversoresSeleccionados([]);
            }}
          >
            <option value="">Todos los proyectos</option>
            {proyectosFiltrados.map((p) => (
              <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Granularidad"
            value={parametros.granularidad}
            onChange={(e) => setParametros({ ...parametros, granularidad: e.target.value })}
          >
            <option value="DIARIA">Diaria</option>
            <option value="MENSUAL">Mensual</option>
            <option value="ANUAL">Anual</option>
          </CampoSelect>
          <CampoTexto
            etiqueta="Año de referencia"
            type="number"
            min="2000"
            max="2100"
            value={parametros.anio}
            ayuda="Usado para el desglose mensual y la comparacion interanual."
            onChange={(e) => setParametros({ ...parametros, anio: e.target.value })}
          />
        </div>

        <fieldset>
          <legend>Inversores (opcional, seleccion multiple)</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            {inversoresFiltrados.length === 0 ? (
              <p style={{ fontSize: '0.85rem', color: 'var(--texto-suave)', margin: 0 }}>
                No hay inversores disponibles para la seleccion actual.
              </p>
            ) : (
              inversoresFiltrados.map((i) => (
                <label key={i.id_inversor} style={{ display: 'flex', gap: '0.35rem', fontSize: '0.84rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={inversoresSeleccionados.includes(i.id_inversor)}
                    onChange={(e) =>
                      setInversoresSeleccionados((actual) =>
                        e.target.checked
                          ? [...actual, i.id_inversor]
                          : actual.filter((id) => id !== i.id_inversor),
                      )
                    }
                  />
                  {i.marca} {i.modelo}
                </label>
              ))
            )}
          </div>
        </fieldset>

        <div className="acciones">
          {puede('reportes.generar') ? (
            <button type="button" className="boton" onClick={() => void generar()} disabled={ocupado}>
              {ocupado ? 'Generando...' : 'Generar reporte'}
            </button>
          ) : null}
        </div>
      </section>

      {/* --------------------------- Reporte generado --------------------------- */}
      {generado ? (
        <>
          <div className="solo-impresion" style={{ marginBottom: '1rem' }}>
            <h1>{generado.empresa} · Reporte de {textoEstado(parametros.tipo)}</h1>
            <p>
              Generado por {generado.usuario} el {fechaHora(generado.generadoEn)} · Zona horaria
              America/Guatemala · Moneda GTQ · Energia kWh
            </p>
          </div>

          {generado.advertenciaOficial ? (
            <MensajeAlerta titulo="Reporte con valorizacion parcial">{generado.advertenciaOficial}</MensajeAlerta>
          ) : (
            <MensajeExito>
              Cobertura tarifaria completa: todos los meses del periodo tienen tarifa aprobada, por lo que el
              monto en quetzales es definitivo.
            </MensajeExito>
          )}

          <section className="tarjeta">
            <div className="tarjeta__titulo">
              <h2>
                {generado.contexto.proyecto} · {generado.contexto.cliente}
              </h2>
              <div className="acciones no-imprimir">
                {puede('reportes.exportar') && generado.id_reporte ? (
                  <>
                    <button
                      type="button"
                      className="boton boton--secundario"
                      onClick={() => void abrirEnPestana(`/reports/${generado.id_reporte}/export`, { formato: 'pdf' })}
                    >
                      Ver PDF
                    </button>
                    <button
                      type="button"
                      className="boton boton--secundario"
                      onClick={() => void descargar(`/reports/${generado.id_reporte}/export`, { formato: 'xlsx' })}
                    >
                      Exportar XLSX
                    </button>
                    <button
                      type="button"
                      className="boton boton--secundario"
                      onClick={() => void descargar(`/reports/${generado.id_reporte}/export`, { formato: 'csv' })}
                    >
                      Exportar CSV
                    </button>
                  </>
                ) : null}
              </div>
            </div>

            <section className="rejilla">
              <div className="indicador">
                <p className="indicador__etiqueta">Produccion total</p>
                <p className="indicador__valor">{kwh(generado.resumen.kwh)}</p>
                <p className="indicador__detalle">{generado.resumen.registros} registro(s)</p>
              </div>
              <div className={generado.cobertura.completa ? 'indicador indicador--verde' : 'indicador indicador--ambar'}>
                <p className="indicador__etiqueta">Valor monetario total</p>
                <p className="indicador__valor">{quetzales(generado.resumen.valor_q)}</p>
                <p className="indicador__detalle">
                  {generado.cobertura.completa ? 'Monto definitivo' : 'Monto parcial'}
                </p>
              </div>
              <div className="indicador">
                <p className="indicador__etiqueta">Promedio por periodo</p>
                <p className="indicador__valor">{kwh(generado.resumen.promedioPorPeriodo)}</p>
                <p className="indicador__detalle">Granularidad {textoEstado(generado.resumen.granularidad)}</p>
              </div>
              <div className="indicador">
                <p className="indicador__etiqueta">Variacion vs. periodo anterior</p>
                <p className="indicador__valor">{porcentaje(generado.comparacion.variacion.kwh_porcentual)}</p>
                <p className="indicador__detalle">{generado.comparacion.baseComparacion}</p>
              </div>
              <div className="indicador">
                <p className="indicador__etiqueta">Cumplimiento anual {generado.contexto.anio}</p>
                <p className="indicador__valor">
                  {porcentaje(generado.resumenAnual.totales.cumplimiento_anio_seleccionado)}
                </p>
              </div>
              <div
                className={
                  generado.cobertura.trimestresPendientes.length > 0
                    ? 'indicador indicador--ambar'
                    : 'indicador indicador--verde'
                }
              >
                <p className="indicador__etiqueta">Cobertura tarifaria</p>
                <p className="indicador__valor">
                  {generado.cobertura.trimestresConTarifa.length}/
                  {generado.cobertura.trimestresConTarifa.length +
                    generado.cobertura.trimestresPendientes.length}
                </p>
                <p className="indicador__detalle">
                  trimestre(s) con tarifa · {generado.cobertura.registrosPendientes} registro(s) sin
                  valorizar
                </p>
              </div>
            </section>

            <h3>Serie de produccion</h3>
            <GraficaSerie datos={generado.serie} titulo="Produccion del periodo" />

            <div style={{ display: 'grid', gap: '1.1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginTop: '1.2rem' }}>
              <section>
                <h3>Cumplimiento anual {generado.contexto.anio}</h3>
                <GraficaMedidor
                  valor={
                    generado.resumenAnual.totales.cumplimiento_anio_seleccionado === null ||
                    generado.resumenAnual.totales.cumplimiento_anio_seleccionado === undefined
                      ? null
                      : Number(generado.resumenAnual.totales.cumplimiento_anio_seleccionado)
                  }
                  etiqueta="del año"
                />
              </section>
              <section>
                <h3>Cumplimiento mensual</h3>
                <GraficaCumplimiento filas={generado.desgloseMensual} />
              </section>
            </div>

            {generado.porProyecto.length > 1 || generado.porInversor.length > 1 ? (
              <div style={{ display: 'grid', gap: '1.1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginTop: '1.2rem' }}>
                {generado.porProyecto.length > 1 ? (
                  <section>
                    <h3>Participacion por proyecto</h3>
                    <GraficaDistribucion datos={generado.porProyecto} />
                  </section>
                ) : null}
                {generado.porInversor.length > 1 ? (
                  <section>
                    <h3>Ranking de inversores</h3>
                    <GraficaBarrasComparacion
                      datos={generado.porInversor.slice(0, 10).map((i) => ({ nombre: i.inversor, valor: i.kwh }))}
                    />
                  </section>
                ) : null}
              </div>
            ) : null}

            <h3 style={{ marginTop: '1.4rem' }}>Desglose mensual integrado</h3>
            <div className="tabla-envoltura">
              <table>
                <caption>
                  Proyeccion, generacion real, cumplimiento, tarifa aplicada y valor producido por mes.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Mes</th>
                    <th scope="col" className="num">Proyeccion kWh</th>
                    <th scope="col" className="num">Generacion kWh</th>
                    <th scope="col" className="num">Cumplimiento</th>
                    <th scope="col" className="num">Tarifa Q/kWh</th>
                    <th scope="col" className="num">Valor producido Q</th>
                    <th scope="col">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {generado.desgloseMensual.map((fila) => (
                    <tr key={fila.mes}>
                      <th scope="row" style={{ position: 'static', background: 'transparent' }}>{fila.mes}</th>
                      <td className="num">
                        {fila.proyeccion_kwh === null ? 'Sin proyeccion' : numero(fila.proyeccion_kwh)}
                      </td>
                      <td className="num">{numero(fila.generacion_kwh)}</td>
                      <td className="num">{porcentaje(fila.cumplimiento)}</td>
                      <td className="num">{fila.tarifa_q_kwh === null ? 'Sin tarifa' : numero(fila.tarifa_q_kwh, 6)}</td>
                      <td className="num">{quetzales(fila.valor_q)}</td>
                      <td>
                        <span className={fila.estado === 'VALORIZADO' ? 'etiqueta etiqueta--verde' : 'etiqueta etiqueta--ambar'}>
                          {fila.estado}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 style={{ marginTop: '1.4rem' }}>Comparacion entre proyectos</h3>
            <Tabla
              columnas={[
                { clave: 'proyecto', titulo: 'Proyecto', render: (f) => f.proyecto },
                { clave: 'cliente', titulo: 'Cliente', render: (f) => f.cliente },
                { clave: 'kwh', titulo: 'Generacion', numerica: true, render: (f) => kwh(f.kwh) },
                { clave: 'valor', titulo: 'Valor', numerica: true, render: (f) => quetzales(f.valor_q) },
                {
                  clave: 'pend',
                  titulo: 'Sin valorizar',
                  numerica: true,
                  render: (f) => (f.pendientes > 0 ? <span className="etiqueta etiqueta--ambar">{f.pendientes}</span> : '0'),
                },
              ]}
              filas={generado.porProyecto}
              claveFila={(f) => f.id_proyecto}
              vacioTitulo="Sin datos por proyecto en el periodo"
            />

            <h3 style={{ marginTop: '1.4rem' }}>Comparacion entre inversores</h3>
            <Tabla
              columnas={[
                { clave: 'inversor', titulo: 'Inversor', render: (f) => f.inversor },
                { clave: 'proyecto', titulo: 'Proyecto', render: (f) => f.proyecto },
                { clave: 'kwh', titulo: 'Generacion', numerica: true, render: (f) => kwh(f.kwh) },
                { clave: 'valor', titulo: 'Valor', numerica: true, render: (f) => quetzales(f.valor_q) },
                { clave: 'ultima', titulo: 'Ultimo dato', render: (f) => fecha(f.ultima_fecha) },
              ]}
              filas={generado.porInversor}
              claveFila={(f) => f.id_inversor}
              vacioTitulo="Sin datos por inversor en el periodo"
              vacioDescripcion="El periodo seleccionado solo contiene produccion consolidada de proyecto."
            />

            <h3 style={{ marginTop: '1.4rem' }}>Notas sobre el origen y la actualizacion de los datos</h3>
            <ul style={{ fontSize: '0.85rem', lineHeight: 1.7, paddingLeft: '1.1rem' }}>
              {generado.notas.map((nota, indice) => (
                <li key={indice}>{nota}</li>
              ))}
            </ul>
          </section>
        </>
      ) : (
        <MensajeInfo titulo="Genere un reporte para ver sus indicadores">
          Elija el tipo, el periodo y los filtros. El reporte queda guardado en el historial y puede
          exportarse a PDF, XLSX o CSV, o imprimirse con una vista limpia.
        </MensajeInfo>
      )}

      {/* --------------------------- Historial --------------------------- */}
      <section className="tarjeta no-imprimir">
        <div className="tarjeta__titulo">
          <h2>Reportes guardados</h2>
          <CampoTexto
            etiqueta="Buscar"
            type="search"
            value={listado.estado.buscar}
            onChange={(e) => listado.actualizar({ buscar: e.target.value })}
          />
        </div>
        <Tabla<ReporteGuardado>
          columnas={[
            { clave: 'nombre', titulo: 'Nombre', render: (f) => f.nombre },
            { clave: 'tipo', titulo: 'Tipo', render: (f) => textoEstado(f.tipo) },
            {
              clave: 'periodo',
              titulo: 'Periodo',
              render: (f) => `${fecha(f.periodo_desde)} – ${fecha(f.periodo_hasta)}`,
            },
            {
              clave: 'cobertura',
              titulo: 'Cobertura tarifaria',
              render: (f) => <span className={claseEstado(f.cobertura_tarifaria)}>{textoEstado(f.cobertura_tarifaria)}</span>,
            },
            { clave: 'usuario', titulo: 'Generado por', render: (f) => f.usuario ?? '—' },
            { clave: 'fecha', titulo: 'Fecha', render: (f) => fechaHora(f.created_at) },
            {
              clave: 'acciones',
              titulo: 'Exportar',
              render: (f) =>
                puede('reportes.exportar') ? (
                  <div className="acciones">
                    <button
                      type="button"
                      className="boton boton--secundario boton--pequeno"
                      onClick={() => void abrirEnPestana(`/reports/${f.id_reporte}/export`, { formato: 'pdf' })}
                    >
                      PDF
                    </button>
                    <button
                      type="button"
                      className="boton boton--secundario boton--pequeno"
                      onClick={() => void descargar(`/reports/${f.id_reporte}/export`, { formato: 'xlsx' })}
                    >
                      XLSX
                    </button>
                    <button
                      type="button"
                      className="boton boton--secundario boton--pequeno"
                      onClick={() => void descargar(`/reports/${f.id_reporte}/export`, { formato: 'csv' })}
                    >
                      CSV
                    </button>
                  </div>
                ) : (
                  <span style={{ color: 'var(--texto-suave)', fontSize: '0.8rem' }}>Sin permiso</span>
                ),
            },
          ]}
          filas={listado.filas}
          claveFila={(f) => f.id_reporte}
          cargando={listado.cargando}
          error={listado.error}
          alReintentar={listado.recargar}
          vacioTitulo="Aun no se ha guardado ningun reporte"
          pie={listado.meta ? <Paginacion {...listado.meta} alCambiar={listado.irAPagina} /> : undefined}
        />
      </section>
    </>
  );
}
