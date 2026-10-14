import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useCatalogos, useGrupos } from '../hooks/useCatalogos';
import { CampoSelect, CampoTexto } from '../components/Campos';
import { Cargando, MensajeAlerta, MensajeError, MensajeInfo } from '../components/Estados';
import {
  GraficaBarrasComparacion,
  GraficaDistribucion,
  GraficaMapaArbol,
  GraficaMedidor,
  GraficaSerie,
  SelectorTipo,
  Sparkline,
} from '../components/Graficas';
import { Contador } from '../components/Contador';
import { Icono, type NombreIcono } from '../components/Iconos';
import { Tabla } from '../components/Tabla';
import {
  claseEstado,
  fecha,
  fechaHora,
  hoyISO,
  inicioDeAnioISO,
  kwh,
  numero,
  porcentaje,
  quetzales,
  tarifa as formatoTarifa,
  textoEstado,
} from '../lib/formato';

/** Tarifa trimestral aplicada dentro del periodo consultado. */
interface TarifaAplicada {
  anio: number;
  trimestre: number;
  proyecto: string;
  costo_kwh: number;
  etiqueta: string;
}

interface RespuestaTablero {
  periodo: { desde: string; hasta: string; comparadoCon: { desde: string; hasta: string } };
  produccion: {
    periodo_kwh: number;
    valor_q: number;
    registros: number;
    dia_kwh: number;
    mes_kwh: number;
    anio_kwh: number;
  };
  variacion: {
    base: string;
    anterior_kwh: number;
    absoluta_kwh: number;
    porcentual_kwh: number | null;
    anterior_valor_q: number;
    absoluta_valor_q: number;
  };
  proyeccion: {
    kwh: number;
    mesesConProyeccion: number;
    mesesDelPeriodo: number;
    cumplimiento: number | null;
    etiqueta: string | null;
  };
  tarifas: {
    /** La tarifa del kWh tiene vigencia TRIMESTRAL. */
    periodicidad: 'TRIMESTRAL';
    aplicadasPorTrimestre: TarifaAplicada[];
    cobertura: {
      trimestresConTarifa: Array<{ anio: number; trimestre: number; etiqueta: string; costo_kwh: number }>;
      trimestresPendientes: Array<{ anio: number; trimestre: number; etiqueta: string }>;
      registrosPendientes: number;
      kwhPendientes: number;
      completa: boolean;
    };
    /** Aviso de que toca actualizar la tarifa de este trimestre. */
    alertaTrimestral: {
      trimestreActual: { anio: number; trimestre: number; etiqueta: string };
      trimestreSiguiente: { anio: number; trimestre: number; etiqueta: string };
      diasRestantes: number;
      diasDeAviso: number;
      proyectosSinTarifaActual: Array<{ id_proyecto: number; proyecto: string }>;
      proyectosSinTarifaSiguiente: Array<{ id_proyecto: number; proyecto: string }>;
      requiereAtencion: boolean;
      mensaje: string | null;
    };
    advertencia: string | null;
  };
  /** Desglose por grupo de inversores (PROYECTO -> GRUPO -> INVERSOR). */
  grupos: Array<{
    id_grupo: number;
    grupo: string;
    proyecto: string;
    tiene_banco_baterias: number;
    capacidad_kwp: number | null;
    cantidad_inversores_declarada: number | null;
    inversores_registrados: number;
    kwh: number;
    valor_q: number;
    ultima_fecha: string | null;
  }>;
  catalogos: { clientes: number; proyectos: number; inversores: number };
  serie: Array<{ periodo: string; etiqueta: string; kwh: number; valor_q: number; pendientes: number }>;
  distribucionPorProyecto: Array<{
    id_proyecto: number;
    proyecto: string;
    cliente: string;
    kwh: number;
    valor_q: number;
    pendientes: number;
  }>;
  inversores: Array<{
    id_inversor: number;
    inversor: string;
    proyecto: string;
    capacidad_kwp: number | null;
    kwh: number;
    valor_q: number;
    ultima_fecha: string | null;
  }>;
  inversoresMenorRendimiento: Array<{
    id_inversor: number;
    inversor: string;
    proyecto: string;
    kwh: number;
    kwh_por_kwp: number;
    relativo: number | null;
  }>;
  rendimiento: {
    baseComparacion: string;
    promedioKwhPorKwp: number;
    noComparables: Array<{ inversor: string; razon: string }>;
  };
  actualizaciones: Array<{
    id_proyecto: number;
    proyecto: string;
    ultima_fecha: string | null;
    ultima_carga: string | null;
  }>;
  ultimaImportacion: {
    id_historico: number;
    nombre_archivo_original: string;
    estado: string;
    total_filas: number;
    insertadas: number;
    rechazadas: number;
    created_at: string;
    usuario: string | null;
  } | null;
  ultimaSincronizacion: {
    id_sync: number;
    estado: string;
    modo: string;
    tipo: string;
    rango_desde: string | null;
    rango_hasta: string | null;
    filas_recibidas: number;
    insertadas: number;
    mensaje: string | null;
    iniciada_en: string;
    usuario: string | null;
  } | null;
  periodosConMezclaDeNiveles: Array<{ proyecto: string; anio: number; mes: number }>;
  ambiental: {
    toneladas_co2_evitadas: number;
    arboles_equivalentes: number;
    factor_co2: number;
    factor_co2_unidad: string;
    factor_co2_fuente: string;
    co2_por_arbol: number;
    co2_por_arbol_unidad: string;
    co2_por_arbol_fuente: string;
  };
  meta: { moneda: string; unidadEnergia: string; zonaHoraria: string; generadoEn: string };
}

/** Tarjeta de indicador con icono animado, valor y tendencia opcional. */
function Kpi({
  icono,
  tono,
  etiqueta,
  valor,
  detalle,
  tendencia,
  spark,
}: {
  icono: NombreIcono;
  tono?: 'verde' | 'ambar' | 'rojo';
  etiqueta: string;
  valor: ReactNode;
  detalle?: ReactNode;
  /** Variacion porcentual contra el periodo anterior. */
  tendencia?: number | null;
  spark?: number[];
}) {
  return (
    <div className={tono ? `indicador indicador--${tono}` : 'indicador'}>
      <div className="indicador__cabecera">
        <p className="indicador__etiqueta" style={{ margin: 0 }}>{etiqueta}</p>
        <span className="indicador__icono">
          <Icono nombre={icono} />
        </span>
      </div>
      <p className="indicador__valor">{valor}</p>
      <p className="indicador__detalle">
        {tendencia !== undefined && tendencia !== null ? (
          <span className={`tendencia ${tendencia >= 0 ? 'tendencia--sube' : 'tendencia--baja'}`}>
            {tendencia >= 0 ? '▲' : '▼'} {numero(Math.abs(tendencia), 1)}%
          </span>
        ) : null}{' '}
        {detalle}
      </p>
      {spark && spark.length > 1 ? <Sparkline valores={spark} etiqueta={etiqueta} /> : null}
    </div>
  );
}

export function PaginaTablero() {
  const catalogos = useCatalogos();
  const [filtros, setFiltros] = useState({
    desde: inicioDeAnioISO(),
    hasta: hoyISO(),
    id_cliente: '',
    id_proyecto: '',
    id_grupo: '',
    id_inversor: '',
    granularidad: 'MENSUAL',
  });

  const proyectosFiltrados = useMemo(
    () =>
      filtros.id_cliente
        ? catalogos.proyectos.filter((p) => String(p.id_cliente) === filtros.id_cliente)
        : catalogos.proyectos,
    [catalogos.proyectos, filtros.id_cliente],
  );

  const inversoresFiltrados = useMemo(
    () =>
      filtros.id_proyecto
        ? catalogos.inversores.filter((i) => String(i.id_proyecto) === filtros.id_proyecto)
        : catalogos.inversores,
    [catalogos.inversores, filtros.id_proyecto],
  );

  const gruposDelFiltro = useGrupos(filtros.id_proyecto);

  const consulta = useQuery({
    queryKey: ['tablero', filtros],
    queryFn: async () => (await api.obtener<RespuestaTablero>('/dashboard', filtros)).datos,
  });

  const cambiar = (campo: string, valor: string) => {
    setFiltros((actual) => {
      const siguiente = { ...actual, [campo]: valor };
      if (campo === 'id_cliente') {
        siguiente.id_proyecto = '';
        siguiente.id_inversor = '';
      }
      if (campo === 'id_proyecto') {
        siguiente.id_grupo = '';
        siguiente.id_inversor = '';
      }
      if (campo === 'id_grupo') siguiente.id_inversor = '';
      return siguiente;
    });
  };

  const [rankingModo, setRankingModo] = useState<'kwh' | 'rendimiento'>('kwh');

  const datos = consulta.data;

  const ranking = useMemo(() => {
    if (!datos) return [];
    const base = datos.inversores
      .map((i) => ({
        nombre: i.inversor,
        valor:
          rankingModo === 'kwh'
            ? i.kwh
            : i.capacidad_kwp && i.capacidad_kwp > 0
              ? i.kwh / i.capacidad_kwp
              : null,
      }))
      .filter((i): i is { nombre: string; valor: number } => i.valor !== null && i.valor > 0)
      .sort((a, b) => b.valor - a.valor);
    return base.slice(0, 10);
  }, [datos, rankingModo]);

  const tendenciaSerie = useMemo(() => datos?.serie.map((s) => s.kwh) ?? [], [datos]);
  const tendenciaValor = useMemo(() => datos?.serie.map((s) => s.valor_q) ?? [], [datos]);

  return (
    <>
      <div className="barra-superior">
        <div>
          <h1>Tablero de indicadores energeticos</h1>
          <p style={{ color: 'var(--texto-suave)', fontSize: '0.86rem' }}>
            Energia en kWh · Potencia instalada en kWp · Moneda GTQ (Q) · Zona horaria America/Guatemala
          </p>
        </div>
        <button type="button" className="boton boton--secundario no-imprimir" onClick={() => window.print()}>
          <Icono nombre="imprimir" tamano={18} /> Imprimir tablero
        </button>
      </div>

      <section className="tarjeta no-imprimir" aria-labelledby="titulo-filtros">
        <h2 id="titulo-filtros" style={{ fontSize: '0.95rem' }}>Filtros globales</h2>
        <div className="filtros">
          <CampoTexto
            etiqueta="Desde"
            type="date"
            value={filtros.desde}
            max={filtros.hasta}
            onChange={(e) => cambiar('desde', e.target.value)}
          />
          <CampoTexto
            etiqueta="Hasta"
            type="date"
            value={filtros.hasta}
            min={filtros.desde}
            max={hoyISO()}
            onChange={(e) => cambiar('hasta', e.target.value)}
          />
          <CampoSelect etiqueta="Cliente" value={filtros.id_cliente} onChange={(e) => cambiar('id_cliente', e.target.value)}>
            <option value="">Todos los clientes</option>
            {catalogos.clientes.map((c) => (
              <option key={c.id_cliente} value={c.id_cliente}>{c.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect etiqueta="Proyecto" value={filtros.id_proyecto} onChange={(e) => cambiar('id_proyecto', e.target.value)}>
            <option value="">Todos los proyectos</option>
            {proyectosFiltrados.map((p) => (
              <option key={p.id_proyecto} value={p.id_proyecto}>{p.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Grupo"
            value={filtros.id_grupo}
            disabled={!gruposDelFiltro.habilitado}
            ayuda={gruposDelFiltro.habilitado ? undefined : 'Seleccione primero un proyecto.'}
            onChange={(e) => cambiar('id_grupo', e.target.value)}
          >
            <option value="">Todos</option>
            {gruposDelFiltro.grupos.map((g) => (
              <option key={g.id_grupo} value={g.id_grupo}>{g.nombre}</option>
            ))}
          </CampoSelect>
          <CampoSelect etiqueta="Inversor" value={filtros.id_inversor} onChange={(e) => cambiar('id_inversor', e.target.value)}>
            <option value="">Todos los inversores</option>
            {inversoresFiltrados.map((i) => (
              <option key={i.id_inversor} value={i.id_inversor}>
                {i.marca} {i.modelo} {i.serial_externo ? `(${i.serial_externo})` : ''}
              </option>
            ))}
          </CampoSelect>
          <CampoSelect
            etiqueta="Granularidad"
            value={filtros.granularidad}
            onChange={(e) => cambiar('granularidad', e.target.value)}
          >
            <option value="DIARIA">Diaria</option>
            <option value="MENSUAL">Mensual</option>
            <option value="ANUAL">Anual</option>
          </CampoSelect>
        </div>
      </section>

      {consulta.isLoading ? <Cargando mensaje="Calculando indicadores del periodo..." /> : null}
      {consulta.error ? <MensajeError error={consulta.error} alReintentar={() => void consulta.refetch()} /> : null}

      {datos ? (
        <>
          {/* La tarifa se actualiza cada trimestre: el tablero lo recuerda. */}
          {datos.tarifas.alertaTrimestral.requiereAtencion &&
          datos.tarifas.alertaTrimestral.mensaje ? (
            <MensajeAlerta titulo="Actualizacion trimestral de la tarifa pendiente">
              {datos.tarifas.alertaTrimestral.mensaje}
              <p style={{ marginTop: '0.4rem', fontSize: '0.8rem' }}>
                Trimestre en curso:{' '}
                <strong>{datos.tarifas.alertaTrimestral.trimestreActual.etiqueta}</strong> · quedan{' '}
                {datos.tarifas.alertaTrimestral.diasRestantes} dia(s) · el siguiente es{' '}
                {datos.tarifas.alertaTrimestral.trimestreSiguiente.etiqueta}.
              </p>
              {datos.tarifas.alertaTrimestral.proyectosSinTarifaActual.length > 0 ? (
                <ul style={{ margin: '0.4rem 0 0 1rem', fontSize: '0.82rem' }}>
                  {datos.tarifas.alertaTrimestral.proyectosSinTarifaActual.map((p) => (
                    <li key={p.id_proyecto}>
                      <Link to={`/proyectos/${p.id_proyecto}`}>{p.proyecto}</Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </MensajeAlerta>
          ) : null}

          {datos.tarifas.advertencia ? (
            <MensajeAlerta titulo="Valorizacion parcial">
              {datos.tarifas.advertencia} Trimestres pendientes:{' '}
              {datos.tarifas.cobertura.trimestresPendientes.map((t) => t.etiqueta).join(', ')}. La
              energia registrada ({kwh(datos.tarifas.cobertura.kwhPendientes)}) se conserva intacta.
            </MensajeAlerta>
          ) : null}

          {datos.periodosConMezclaDeNiveles.length > 0 ? (
            <MensajeAlerta titulo="Periodos con dos niveles de detalle">
              En {datos.periodosConMezclaDeNiveles.length} periodo(s) coexisten un consolidado de proyecto y
              el detalle por inversor. Para evitar el doble conteo, el sistema utiliza unicamente el detalle
              por inversor en esos meses:{' '}
              {datos.periodosConMezclaDeNiveles
                .map((p) => `${p.proyecto} ${String(p.mes).padStart(2, '0')}/${p.anio}`)
                .join(' · ')}
              .
            </MensajeAlerta>
          ) : null}

          <section className="rejilla" aria-label="Indicadores principales">
            <Kpi
              icono="produccion"
              etiqueta="Produccion del periodo"
              valor={<Contador valor={datos.produccion.periodo_kwh} formato={kwh} />}
              tendencia={datos.variacion.porcentual_kwh}
              detalle={`${datos.produccion.registros} registro(s)`}
              spark={tendenciaSerie}
            />
            <Kpi
              icono="reportes"
              tono={datos.tarifas.cobertura.completa ? 'verde' : 'ambar'}
              etiqueta="Valor economico estimado"
              valor={<Contador valor={datos.produccion.valor_q} formato={quetzales} />}
              detalle={
                datos.tarifas.cobertura.completa ? 'Cobertura tarifaria completa' : 'Monto parcial: faltan tarifas'
              }
              spark={tendenciaValor}
            />
            <Kpi
              icono="resumen"
              etiqueta="Proyeccion del periodo"
              valor={
                datos.proyeccion.kwh > 0 ? (
                  <Contador valor={datos.proyeccion.kwh} formato={kwh} />
                ) : (
                  'Sin proyeccion'
                )
              }
              detalle={`${datos.proyeccion.mesesConProyeccion} de ${datos.proyeccion.mesesDelPeriodo} mes(es) con proyeccion aprobada`}
            />
            <Kpi
              icono="tablero"
              tono={
                datos.variacion.porcentual_kwh === null
                  ? undefined
                  : datos.variacion.porcentual_kwh >= 0
                    ? 'verde'
                    : 'rojo'
              }
              etiqueta="Variacion vs. periodo anterior"
              valor={porcentaje(datos.variacion.porcentual_kwh)}
              detalle={`${numero(datos.variacion.absoluta_kwh)} kWh · ${datos.variacion.base}`}
            />
            <Kpi
              icono="proyectos"
              etiqueta="Produccion hoy / mes / año"
              valor={<Contador valor={datos.produccion.dia_kwh} formato={kwh} />}
              detalle={`Mes: ${kwh(datos.produccion.mes_kwh)} · Año: ${kwh(datos.produccion.anio_kwh)}`}
            />
            <Kpi
              icono="inversores"
              etiqueta="Catalogos activos"
              valor={`${datos.catalogos.proyectos} proyectos`}
              detalle={`${datos.catalogos.clientes} cliente(s) · ${datos.catalogos.inversores} inversor(es)`}
            />
            <Kpi
              icono="ok"
              tono="verde"
              etiqueta="Equivalencia ambiental"
              valor={
                <>
                  <Contador valor={datos.ambiental.toneladas_co2_evitadas} formato={(n) => numero(n)} /> tCO2e
                </>
              }
              detalle={`≈ ${numero(datos.ambiental.arboles_equivalentes, 0)} arbol(es) equivalentes`}
            />
          </section>

          <details className="tarjeta">
            <summary style={{ cursor: 'pointer', fontWeight: 600, color: 'var(--azul-800)' }}>
              Factores de conversion ambiental utilizados
            </summary>
            <ul style={{ marginTop: '0.7rem', fontSize: '0.84rem', lineHeight: 1.6 }}>
              <li>
                Factor de emision: <strong>{numero(datos.ambiental.factor_co2, 4)}</strong>{' '}
                {datos.ambiental.factor_co2_unidad}. Fuente: {datos.ambiental.factor_co2_fuente}
              </li>
              <li>
                Absorcion por arbol: <strong>{numero(datos.ambiental.co2_por_arbol, 4)}</strong>{' '}
                {datos.ambiental.co2_por_arbol_unidad}. Fuente: {datos.ambiental.co2_por_arbol_fuente}
              </li>
            </ul>
            <p style={{ fontSize: '0.8rem', color: 'var(--texto-suave)', margin: 0 }}>
              Estos factores son configurables desde el modulo de Configuracion; no son constantes ocultas.
            </p>
          </details>

          <section className="tarjeta">
            <div className="tarjeta__titulo">
              <h2>Serie temporal de produccion</h2>
              <span className="etiqueta etiqueta--azul">Granularidad {textoEstado(filtros.granularidad)}</span>
            </div>
            <GraficaSerie datos={datos.serie} titulo="Produccion por periodo" />
          </section>

          <div style={{ display: 'grid', gap: '1.1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
            <section className="tarjeta">
              <h2>Cumplimiento de la proyeccion</h2>
              <GraficaMedidor
                valor={datos.proyeccion.cumplimiento}
                etiqueta="de la proyeccion"
                detalle={
                  datos.proyeccion.kwh > 0
                    ? `${kwh(datos.produccion.periodo_kwh)} generados de ${kwh(datos.proyeccion.kwh)} proyectados`
                    : undefined
                }
              />
            </section>

            <section className="tarjeta">
              <h2>Distribucion por proyecto</h2>
              <GraficaDistribucion datos={datos.distribucionPorProyecto} />
            </section>
          </div>

          <div style={{ display: 'grid', gap: '1.1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
            <section className="tarjeta">
              <div className="tarjeta__titulo">
                <h2>Ranking de inversores</h2>
                <SelectorTipo<'kwh' | 'rendimiento'>
                  etiqueta="Criterio del ranking"
                  valor={rankingModo}
                  alCambiar={setRankingModo}
                  opciones={[
                    { valor: 'kwh', texto: 'Generacion (kWh)' },
                    { valor: 'rendimiento', texto: 'Rendimiento (kWh/kWp)' },
                  ]}
                />
              </div>
              <GraficaBarrasComparacion
                datos={ranking}
                etiquetaValor={rankingModo === 'kwh' ? 'kWh' : 'kWh por kWp'}
              />
            </section>

            <section className="tarjeta">
              <h2>Peso de cada grupo de inversores</h2>
              <GraficaMapaArbol datos={datos.grupos.map((g) => ({ nombre: `${g.proyecto} · ${g.grupo}`, valor: g.kwh }))} />
            </section>
          </div>

          <section className="tarjeta">
            <div className="tarjeta__titulo">
              <h2>Inversores con menor produccion relativa</h2>
              <span style={{ fontSize: '0.79rem', color: 'var(--texto-suave)' }}>
                Base de comparacion: {datos.rendimiento.baseComparacion}
              </span>
            </div>
            <Tabla
              columnas={[
                { clave: 'inversor', titulo: 'Inversor', render: (f) => f.inversor },
                { clave: 'proyecto', titulo: 'Proyecto', render: (f) => f.proyecto },
                { clave: 'kwh', titulo: 'Generacion', numerica: true, render: (f) => kwh(f.kwh) },
                { clave: 'rel', titulo: 'kWh por kWp', numerica: true, render: (f) => numero(f.kwh_por_kwp) },
                {
                  clave: 'porc',
                  titulo: 'Relativo al promedio',
                  numerica: true,
                  render: (f) => (
                    <span className={f.relativo !== null && f.relativo < 90 ? 'etiqueta etiqueta--ambar' : 'etiqueta etiqueta--verde'}>
                      {porcentaje(f.relativo)}
                    </span>
                  ),
                },
              ]}
              filas={datos.inversoresMenorRendimiento}
              claveFila={(f) => f.id_inversor}
              vacioTitulo="No hay inversores comparables"
              vacioDescripcion="La comparacion relativa requiere inversores con potencia instalada (kWp) registrada y datos en el periodo."
            />
            {datos.rendimiento.noComparables.length > 0 ? (
              <MensajeInfo titulo="Inversores excluidos de la comparacion">
                {datos.rendimiento.noComparables.map((i) => i.inversor).join(', ')} — no tienen potencia
                instalada registrada, por lo que no existe una base comparable.
              </MensajeInfo>
            ) : null}
          </section>

          {/* Desglose por grupo de inversores: el nivel intermedio entre el
              proyecto y el equipo. */}
          {datos.grupos.length > 0 ? (
            <section className="tarjeta">
              <h2>Generacion por grupo de inversores</h2>
              <Tabla<RespuestaTablero['grupos'][number]>
                descripcion="Cada proyecto se divide en grupos y cada grupo agrupa varios inversores."
                columnas={[
                  { clave: 'grupo', titulo: 'Grupo', render: (g) => g.grupo },
                  { clave: 'proyecto', titulo: 'Proyecto', render: (g) => g.proyecto },
                  {
                    clave: 'inversores',
                    titulo: 'Inversores',
                    numerica: true,
                    render: (g) =>
                      g.cantidad_inversores_declarada !== null
                        ? `${g.inversores_registrados} de ${g.cantidad_inversores_declarada}`
                        : String(g.inversores_registrados),
                  },
                  {
                    clave: 'baterias',
                    titulo: 'Baterias',
                    render: (g) =>
                      g.tiene_banco_baterias ? (
                        <span className="etiqueta etiqueta--verde">Si</span>
                      ) : (
                        <span className="etiqueta etiqueta--gris">No</span>
                      ),
                  },
                  { clave: 'kwh', titulo: 'Generacion', numerica: true, render: (g) => kwh(g.kwh) },
                  { clave: 'valor', titulo: 'Valor', numerica: true, render: (g) => quetzales(g.valor_q) },
                ]}
                filas={datos.grupos}
                claveFila={(g) => g.id_grupo}
                vacioTitulo="Sin generacion por grupo en el periodo"
              />
            </section>
          ) : null}

          <div style={{ display: 'grid', gap: '1.1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }}>
            <section className="tarjeta">
              <h2>Tarifas aplicadas en el periodo (vigencia trimestral)</h2>
              <Tabla<TarifaAplicada>
                columnas={[
                  { clave: 'trimestre', titulo: 'Trimestre', render: (f) => f.etiqueta },
                  { clave: 'proyecto', titulo: 'Proyecto', render: (f) => f.proyecto },
                  { clave: 'costo', titulo: 'Tarifa', numerica: true, render: (f) => formatoTarifa(f.costo_kwh) },
                ]}
                filas={datos.tarifas.aplicadasPorTrimestre}
                claveFila={(f) => `${f.anio}-${f.trimestre}-${f.proyecto}`}
                vacioTitulo="No hay tarifas aprobadas en el periodo"
                vacioDescripcion="Registre y apruebe la tarifa de cada trimestre desde el detalle del proyecto."
              />
            </section>

            <section className="tarjeta">
              <h2>Ultima actualizacion por proyecto</h2>
              <Tabla
                columnas={[
                  {
                    clave: 'proyecto',
                    titulo: 'Proyecto',
                    render: (f) => <Link to={`/proyectos/${f.id_proyecto}`}>{f.proyecto}</Link>,
                  },
                  { clave: 'dato', titulo: 'Ultimo dato', render: (f) => fecha(f.ultima_fecha) },
                  { clave: 'carga', titulo: 'Ultima carga', render: (f) => fechaHora(f.ultima_carga) },
                ]}
                filas={datos.actualizaciones}
                claveFila={(f) => f.id_proyecto}
                vacioTitulo="Sin proyectos activos"
              />
            </section>
          </div>

          <section className="tarjeta">
            <h2>Estado de las ultimas operaciones de datos</h2>
            <div style={{ display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
              <div>
                <h3>Ultima carga manual</h3>
                {datos.ultimaImportacion ? (
                  <ul style={{ fontSize: '0.86rem', lineHeight: 1.65, paddingLeft: '1.1rem' }}>
                    <li>Archivo: {datos.ultimaImportacion.nombre_archivo_original}</li>
                    <li>
                      Estado:{' '}
                      <span className={claseEstado(datos.ultimaImportacion.estado)}>
                        {textoEstado(datos.ultimaImportacion.estado)}
                      </span>
                    </li>
                    <li>
                      {datos.ultimaImportacion.insertadas} insertada(s) de {datos.ultimaImportacion.total_filas} fila(s);{' '}
                      {datos.ultimaImportacion.rechazadas} rechazada(s)
                    </li>
                    <li>Usuario: {datos.ultimaImportacion.usuario ?? 'No disponible'}</li>
                    <li>Fecha: {fechaHora(datos.ultimaImportacion.created_at)}</li>
                  </ul>
                ) : (
                  <p style={{ color: 'var(--texto-suave)' }}>Aun no se ha registrado ninguna importacion.</p>
                )}
              </div>

              <div>
                <h3>Ultima sincronizacion Huawei</h3>
                {datos.ultimaSincronizacion ? (
                  <ul style={{ fontSize: '0.86rem', lineHeight: 1.65, paddingLeft: '1.1rem' }}>
                    <li>
                      Estado:{' '}
                      <span className={claseEstado(datos.ultimaSincronizacion.estado)}>
                        {textoEstado(datos.ultimaSincronizacion.estado)}
                      </span>{' '}
                      {datos.ultimaSincronizacion.modo === 'MOCK' ? (
                        <span className="etiqueta etiqueta--azul">Datos simulados</span>
                      ) : null}
                    </li>
                    <li>
                      Rango: {fecha(datos.ultimaSincronizacion.rango_desde)} –{' '}
                      {fecha(datos.ultimaSincronizacion.rango_hasta)}
                    </li>
                    <li>
                      {datos.ultimaSincronizacion.filas_recibidas} fila(s) recibida(s),{' '}
                      {datos.ultimaSincronizacion.insertadas} insertada(s)
                    </li>
                    <li>{datos.ultimaSincronizacion.mensaje}</li>
                    <li>Fecha: {fechaHora(datos.ultimaSincronizacion.iniciada_en)}</li>
                  </ul>
                ) : (
                  <p style={{ color: 'var(--texto-suave)' }}>Aun no se ha ejecutado ninguna sincronizacion.</p>
                )}
              </div>
            </div>
          </section>

          <p style={{ fontSize: '0.76rem', color: 'var(--texto-suave)' }}>
            Datos generados el {fechaHora(datos.meta.generadoEn)} · Zona horaria {datos.meta.zonaHoraria} ·
            Moneda {datos.meta.moneda} · Energia {datos.meta.unidadEnergia}
          </p>
        </>
      ) : null}
    </>
  );
}
